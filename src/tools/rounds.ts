import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { analyzeScreenshots } from "../screenshot-analyzer.js";
import {
  catalogIsEmpty,
  EMPTY_CATALOG_MSG,
  getDb,
  inTransaction,
  inImmediateTransaction,
} from "../db.js";
import { parseNumbers } from "../domain/collection.js";
import { ownedRepo } from "../repositories/owned.js";
import {
  roundsRepo,
  type RoundRow,
  type RoundCardRow,
} from "../repositories/rounds.js";
import {
  classifyDetections,
  planFinalize,
  planRecord,
  summarizeRoundValidation,
  validateRoundStart,
  type RoundObservation,
} from "../domain/rounds.js";

function textResult(output: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

function getRound(id: string): RoundRow | undefined {
  return roundsRepo().get(id);
}

function assertEditable(round: RoundRow): string | null {
  if (round.status === "applied")
    return `La ronda '${round.id}' ya fue aplicada y es inmutable.`;
  if (round.status === "cancelled")
    return `La ronda '${round.id}' está cancelada.`;
  return null;
}

function expansionNumbers(expansion: string): number[] {
  return (
    getDb()
      .prepare(
        "SELECT number FROM cards WHERE expansion_id = ? ORDER BY number",
      )
      .all(expansion) as { number: number }[]
  ).map((row) => row.number);
}

function parseSpec(spec: string | undefined, label: string): number[] {
  if (!spec) return [];
  const numbers = parseNumbers(spec);
  if (!numbers.length) throw new Error(`${label} no contiene ningún número`);
  return numbers;
}

/** Maps a persisted round-card row to the framework-free domain observation. */
function toObservation(row: RoundCardRow): RoundObservation {
  return {
    card_number: row.card_number,
    state: row.state,
    quantity: row.quantity,
    confidence: row.confidence,
    confirmed: !!row.confirmed,
    source: row.source,
  };
}

export function registerRoundTools(server: McpServer): void {
  server.registerTool(
    "ptcgp_round_start",
    {
      title: "Iniciar ronda de capturas",
      description: `Crea una ronda para una expansión completa. Una ronda empieza en la primera carta y termina en la última captura de esa expansión. expected_owned_unique debe ser la suma de los contadores visibles de la cabecera (diamantes + estrellas + shiny/corona); se usa para impedir que un OCR incompleto altere la colección. quantity_mode='minimum' es el adecuado para la cuadrícula normal: una carta visible prueba al menos una copia y conserva cantidades superiores ya registradas.`,
      inputSchema: {
        expansion: z
          .string()
          .min(1)
          .max(10)
          .describe("Id de expansión, ej. a3a"),
        expected_owned_unique: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Total de cartas únicas poseídas mostrado en la cabecera"),
        quantity_mode: z.enum(["minimum", "exact"]).default("minimum"),
        label: z.string().max(120).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ expansion, expected_owned_unique, quantity_mode, label }) => {
      if (catalogIsEmpty()) return errorResult(EMPTY_CATALOG_MSG);
      const exp = expansion.toLowerCase();
      const numbers = expansionNumbers(exp);
      if (!numbers.length)
        return errorResult(
          `Expansión '${exp}' no encontrada. Consulta ptcgp_list_expansions.`,
        );
      const startError = validateRoundStart(
        numbers.length,
        expected_owned_unique,
        exp,
      );
      if (startError) return errorResult(startError.message);
      const now = new Date().toISOString();
      const id = `${exp}-${now.slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8)}`;
      roundsRepo().create({
        id,
        expansion_id: exp,
        label: label ?? null,
        quantity_mode,
        expected_total: numbers.length,
        expected_owned_unique: expected_owned_unique ?? null,
        created_at: now,
        updated_at: now,
      });
      return textResult({
        round_id: id,
        expansion: exp,
        expected_total: numbers.length,
        expected_owned_unique: expected_owned_unique ?? null,
        quantity_mode,
        next: "Llama a ptcgp_round_analyze_screenshots con las capturas ordenadas desde el inicio hasta el final de la expansión.",
      });
    },
  );

  server.registerTool(
    "ptcgp_round_analyze_screenshots",
    {
      title: "Analizar capturas de una ronda",
      description: `Analiza capturas móviles PNG/JPEG/WebP/HEIC, corrige orientación y normaliza cualquier resolución. Detecta los huecos de la cuadrícula y lee sus números con OCR local, sin enviar imágenes a Internet. Las detecciones quedan en revisión y NO cambian la colección. Las rutas deben ir en el mismo orden en que se recorrió la expansión.`,
      inputSchema: {
        round_id: z.string().min(5).max(80),
        image_paths: z.array(z.string().min(1).max(1000)).min(1).max(20),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ round_id, image_paths }) => {
      const round = getRound(round_id);
      if (!round) return errorResult(`Ronda '${round_id}' no encontrada.`);
      const editError = assertEditable(round);
      if (editError) return errorResult(editError);
      try {
        const analyses = await analyzeScreenshots(
          image_paths,
          round.expected_total,
        );
        const repo = roundsRepo();
        const currentOrder = repo.maxCaptureOrder(round_id);
        const confirmedOwned = repo.confirmedOwnedNumbers(round_id);
        const { contradictions, upserts } = classifyDetections(
          confirmedOwned,
          analyses.map((analysis) => ({
            path: analysis.path,
            detected_missing: analysis.detected_missing,
          })),
        );
        const now = new Date().toISOString();
        inTransaction(() => {
          analyses.forEach((analysis, index) => {
            repo.insertImage({
              round_id,
              path: analysis.path,
              sha256: analysis.sha256,
              width: analysis.width,
              height: analysis.height,
              capture_order: currentOrder + index + 1,
              analysis: JSON.stringify(analysis),
              created_at: now,
            });
          });
          for (const detection of upserts) {
            repo.upsertDetection({
              round_id,
              card_number: detection.card_number,
              confidence: detection.confidence,
              source: detection.source,
              updated_at: now,
            });
          }
          repo.setStatus(round_id, "review", now);
        });

        const detected = repo.detectedMissing(round_id);
        return textResult({
          round_id,
          images_analyzed: analyses.length,
          dimensions: analyses.map((item) => ({
            path: item.path,
            width: item.width,
            height: item.height,
            format: item.format,
          })),
          detected_missing: detected,
          warnings: analyses.flatMap((item) =>
            item.warnings.map((warning) => `${item.path}: ${warning}`),
          ),
          contradictions,
          collection_changed: false,
          next: "Revisa detected_missing visualmente y confírmalo con ptcgp_round_record antes de finalizar.",
        });
      } catch (error) {
        return errorResult(
          `Error analizando capturas: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );

  server.registerTool(
    "ptcgp_round_record",
    {
      title: "Confirmar o corregir una ronda",
      description: `Registra observaciones confirmadas tras revisar las capturas. missing_numbers son huecos numerados; owned_numbers permite corregir falsos positivos del OCR. En quantity_mode='minimum', una carta visible equivale a cantidad mínima 1. En modo exact debe proporcionarse quantity por carta poseída. Esta operación aún no altera la colección.`,
      inputSchema: {
        round_id: z.string().min(5).max(80),
        missing_numbers: z
          .string()
          .max(4000)
          .optional()
          .describe('Ej. "2,5-6,20"'),
        owned_numbers: z
          .string()
          .max(4000)
          .optional()
          .describe("Números que el OCR marcó por error como huecos"),
        quantities: z
          .array(
            z.object({
              number: z.number().int().min(1),
              quantity: z.number().int().min(1).max(99),
            }),
          )
          .max(500)
          .default([]),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ round_id, missing_numbers, owned_numbers, quantities }) => {
      const round = getRound(round_id);
      if (!round) return errorResult(`Ronda '${round_id}' no encontrada.`);
      const editError = assertEditable(round);
      if (editError) return errorResult(editError);
      try {
        const missing = parseSpec(missing_numbers, "missing_numbers");
        const owned = parseSpec(owned_numbers, "owned_numbers");
        const plan = planRecord({
          quantity_mode: round.quantity_mode,
          expansion_id: round.expansion_id,
          missing,
          owned,
          quantities,
          valid_numbers: new Set(expansionNumbers(round.expansion_id)),
        });
        if (!plan.ok) return errorResult(plan.message);
        const now = new Date().toISOString();
        const repo = roundsRepo();
        inTransaction(() => {
          for (const item of plan.upserts) {
            repo.upsertConfirmed({
              round_id,
              card_number: item.card_number,
              state: item.state,
              quantity: item.quantity,
              updated_at: now,
            });
          }
          repo.setStatus(round_id, "review", now);
        });
        return textResult({
          round_id,
          confirmed_missing: plan.confirmed_missing,
          confirmed_owned: plan.confirmed_owned,
          collection_changed: false,
        });
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  );

  server.registerTool(
    "ptcgp_round_status",
    {
      title: "Estado y previsualización de rondas",
      description:
        "Muestra una ronda concreta o las rondas recientes, con capturas, detecciones confirmadas y pendientes. No modifica datos.",
      inputSchema: { round_id: z.string().min(5).max(80).optional() },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ round_id }) => {
      const repo = roundsRepo();
      if (!round_id) {
        return textResult({ rounds: repo.listRecent() });
      }
      const round = repo.get(round_id);
      if (!round) return errorResult(`Ronda '${round_id}' no encontrada.`);
      const cards = repo.cards(round_id);
      const images = repo.images(round_id);
      const validation = summarizeRoundValidation(
        round.expected_total,
        round.expected_owned_unique,
        cards.map((card) => ({
          card_number: card.number,
          state: card.state,
          confirmed: !!card.confirmed,
        })),
      );
      return textResult({ round, images, observations: cards, validation });
    },
  );

  server.registerTool(
    "ptcgp_round_finalize",
    {
      title: "Finalizar y aplicar ronda",
      description: `Aplica una ronda completa de forma transaccional. Requiere confirm=true y que el total esperado de poseídas coincida exactamente con total_catálogo - huecos. Por defecto solo usa huecos confirmados; use_auto_detections permite detecciones OCR con confianza >=0.84. En modo minimum conserva cantidades superiores existentes.`,
      inputSchema: {
        round_id: z.string().min(5).max(80),
        confirm: z.literal(true),
        expected_owned_unique: z.number().int().min(0).optional(),
        use_auto_detections: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ round_id, expected_owned_unique, use_auto_detections }) => {
      const round = getRound(round_id);
      if (!round) return errorResult(`Ronda '${round_id}' no encontrada.`);
      const editError = assertEditable(round);
      if (editError) return errorResult(editError);
      const owned = ownedRepo();
      const repo = roundsRepo();
      const plan = inImmediateTransaction(() => {
        // Read, plan and write under one immediate transaction. A separate MCP
        // process sharing PTCGP_DATA_DIR cannot change an owned quantity between
        // the `minimum`-mode preservation calculation and its corresponding write.
        const observations = repo.observations(round_id).map(toObservation);
        const numbers = expansionNumbers(round.expansion_id);
        const previousQuantities = owned.quantitiesByExpansion(
          round.expansion_id,
        );
        const result = planFinalize({
          expansion_id: round.expansion_id,
          expected_total: round.expected_total,
          quantity_mode: round.quantity_mode,
          expected_owned_unique:
            expected_owned_unique ?? round.expected_owned_unique,
          observations,
          use_auto_detections,
          expansion_numbers: numbers,
          previous_quantities: previousQuantities,
        });
        if (!result.ok) return result;

        const now = new Date().toISOString();
        for (const write of result.writes) {
          owned.setQuantity(write.card_id, write.applied, now);
          repo.writeAudit({
            round_id,
            card_number: write.card_number,
            state: write.state,
            quantity: write.applied,
            source: write.source,
            previous_quantity: write.previous,
            applied_quantity: write.applied,
            updated_at: now,
          });
        }
        const summary = JSON.stringify({
          total: round.expected_total,
          owned_unique: result.expected_owned_unique,
          missing: result.missing_count,
          changed: result.changed,
          preserved_higher_quantities: result.preserved_higher_quantities,
          excluded_auto_detections: result.excluded_auto_detections,
        });
        repo.markApplied({
          round_id,
          expected_owned_unique: result.expected_owned_unique,
          updated_at: now,
          finalized_at: now,
          summary,
        });
        return result;
      });
      if (!plan.ok) return errorResult(plan.message);
      return textResult({
        round_id,
        expansion: round.expansion_id,
        applied: true,
        total: round.expected_total,
        owned_unique: plan.expected_owned_unique,
        missing: plan.missing_count,
        changed: plan.changed,
        preserved_higher_quantities: plan.preserved_higher_quantities,
      });
    },
  );
}
