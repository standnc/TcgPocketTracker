import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { analyzeScreenshots } from "../screenshot-analyzer.js";
import { catalogIsEmpty, EMPTY_CATALOG_MSG, getDb } from "../db.js";
import { parseNumbers } from "./collection.js";

interface RoundRow {
  id: string;
  expansion_id: string;
  label: string | null;
  status: "open" | "review" | "applied" | "cancelled";
  quantity_mode: "minimum" | "exact";
  expected_total: number;
  expected_owned_unique: number | null;
  created_at: string;
  updated_at: string;
  finalized_at: string | null;
  summary: string | null;
}

interface RoundCardRow {
  card_number: number;
  state: "owned" | "missing";
  quantity: number | null;
  confidence: number;
  confirmed: number;
  source: string | null;
}

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
  return getDb()
    .prepare("SELECT * FROM capture_rounds WHERE id = ?")
    .get(id) as RoundRow | undefined;
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
      if (
        expected_owned_unique !== undefined &&
        expected_owned_unique > numbers.length
      ) {
        return errorResult(
          `expected_owned_unique=${expected_owned_unique} supera las ${numbers.length} cartas del catálogo para ${exp}.`,
        );
      }
      const now = new Date().toISOString();
      const id = `${exp}-${now.slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8)}`;
      getDb()
        .prepare(
          `
        INSERT INTO capture_rounds
          (id, expansion_id, label, status, quantity_mode, expected_total, expected_owned_unique, created_at, updated_at)
        VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?)
      `,
        )
        .run(
          id,
          exp,
          label ?? null,
          quantity_mode,
          numbers.length,
          expected_owned_unique ?? null,
          now,
          now,
        );
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
        const db = getDb();
        const currentOrder = (
          db
            .prepare(
              "SELECT COALESCE(MAX(capture_order), -1) AS n FROM capture_round_images WHERE round_id = ?",
            )
            .get(round_id) as { n: number }
        ).n;
        const insertImage = db.prepare(`
          INSERT INTO capture_round_images
            (round_id, path, sha256, width, height, capture_order, analysis, created_at)
          VALUES (@round_id, @path, @sha256, @width, @height, @capture_order, @analysis, @created_at)
          ON CONFLICT(round_id, sha256) DO UPDATE SET
            path=excluded.path, width=excluded.width, height=excluded.height, analysis=excluded.analysis
        `);
        const existingCard = db.prepare(
          "SELECT state, confirmed, confidence FROM capture_round_cards WHERE round_id = ? AND card_number = ?",
        );
        const upsertDetection = db.prepare(`
          INSERT INTO capture_round_cards
            (round_id, card_number, state, quantity, confidence, confirmed, source, updated_at)
          VALUES (?, ?, 'missing', 0, ?, 0, ?, ?)
          ON CONFLICT(round_id, card_number) DO UPDATE SET
            state=CASE WHEN capture_round_cards.confirmed=0 THEN 'missing' ELSE capture_round_cards.state END,
            quantity=CASE WHEN capture_round_cards.confirmed=0 THEN 0 ELSE capture_round_cards.quantity END,
            confidence=CASE WHEN capture_round_cards.confirmed=0 THEN MAX(capture_round_cards.confidence, excluded.confidence) ELSE capture_round_cards.confidence END,
            source=CASE WHEN capture_round_cards.confirmed=0 THEN excluded.source ELSE capture_round_cards.source END,
            updated_at=excluded.updated_at
        `);
        const contradictions: {
          number: number;
          confirmed_state: string;
          source: string;
        }[] = [];
        const now = new Date().toISOString();
        db.transaction(() => {
          analyses.forEach((analysis, index) => {
            insertImage.run({
              round_id,
              path: analysis.path,
              sha256: analysis.sha256,
              width: analysis.width,
              height: analysis.height,
              capture_order: currentOrder + index + 1,
              analysis: JSON.stringify(analysis),
              created_at: now,
            });
            for (const detection of analysis.detected_missing) {
              const existing = existingCard.get(round_id, detection.number) as
                | { state: string; confirmed: number; confidence: number }
                | undefined;
              if (existing?.confirmed && existing.state === "owned") {
                contradictions.push({
                  number: detection.number,
                  confirmed_state: existing.state,
                  source: analysis.path,
                });
                continue;
              }
              upsertDetection.run(
                round_id,
                detection.number,
                detection.confidence,
                analysis.path,
                now,
              );
            }
          });
          db.prepare(
            "UPDATE capture_rounds SET status='review', updated_at=? WHERE id=?",
          ).run(now, round_id);
        })();

        const detected = db
          .prepare(
            `
          SELECT card_number AS number, confidence, confirmed, source
          FROM capture_round_cards WHERE round_id=? AND state='missing' ORDER BY card_number
        `,
          )
          .all(round_id);
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
        if (!missing.length && !owned.length && !quantities.length) {
          return errorResult(
            "Indica missing_numbers, owned_numbers o quantities.",
          );
        }
        const missingSet = new Set(missing);
        const ownedSet = new Set(owned);
        for (const item of quantities) ownedSet.add(item.number);
        const overlap = [...missingSet].filter((number) =>
          ownedSet.has(number),
        );
        if (overlap.length)
          return errorResult(
            `Números contradictorios como owned y missing: ${overlap.join(", ")}`,
          );
        const validNumbers = new Set(expansionNumbers(round.expansion_id));
        const invalid = [...missingSet, ...ownedSet].filter(
          (number) => !validNumbers.has(number),
        );
        if (invalid.length)
          return errorResult(
            `Números fuera de ${round.expansion_id}: ${[...new Set(invalid)].join(", ")}`,
          );
        const quantityMap = new Map(
          quantities.map((item) => [item.number, item.quantity]),
        );
        if (round.quantity_mode === "exact") {
          const withoutQuantity = [...ownedSet].filter(
            (number) => !quantityMap.has(number),
          );
          if (withoutQuantity.length)
            return errorResult(
              `El modo exact requiere quantity para: ${withoutQuantity.join(", ")}`,
            );
        }
        const now = new Date().toISOString();
        const upsert = getDb().prepare(`
          INSERT INTO capture_round_cards
            (round_id, card_number, state, quantity, confidence, confirmed, source, updated_at)
          VALUES (@round_id, @card_number, @state, @quantity, 1, 1, 'confirmed-review', @updated_at)
          ON CONFLICT(round_id, card_number) DO UPDATE SET
            state=excluded.state, quantity=excluded.quantity, confidence=1, confirmed=1,
            source=excluded.source, updated_at=excluded.updated_at
        `);
        getDb().transaction(() => {
          for (const number of missingSet)
            upsert.run({
              round_id,
              card_number: number,
              state: "missing",
              quantity: 0,
              updated_at: now,
            });
          for (const number of ownedSet)
            upsert.run({
              round_id,
              card_number: number,
              state: "owned",
              quantity: quantityMap.get(number) ?? 1,
              updated_at: now,
            });
          getDb()
            .prepare(
              "UPDATE capture_rounds SET status='review', updated_at=? WHERE id=?",
            )
            .run(now, round_id);
        })();
        return textResult({
          round_id,
          confirmed_missing: missingSet.size,
          confirmed_owned: ownedSet.size,
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
      const db = getDb();
      if (!round_id) {
        const rounds = db
          .prepare(
            `
          SELECT r.*, COUNT(DISTINCT i.id) AS images,
            COUNT(DISTINCT CASE WHEN rc.state='missing' THEN rc.card_number END) AS missing_detected,
            COUNT(DISTINCT CASE WHEN rc.confirmed=0 THEN rc.card_number END) AS pending_review
          FROM capture_rounds r
          LEFT JOIN capture_round_images i ON i.round_id=r.id
          LEFT JOIN capture_round_cards rc ON rc.round_id=r.id
          GROUP BY r.id ORDER BY r.created_at DESC LIMIT 20
        `,
          )
          .all();
        return textResult({ rounds });
      }
      const round = getRound(round_id);
      if (!round) return errorResult(`Ronda '${round_id}' no encontrada.`);
      const cards = db
        .prepare(
          `
        SELECT card_number AS number, state, quantity, confidence, confirmed, source
        FROM capture_round_cards WHERE round_id=? ORDER BY card_number
      `,
        )
        .all(round_id) as RoundCardRow[];
      const images = db
        .prepare(
          `
        SELECT path, sha256, width, height, capture_order FROM capture_round_images
        WHERE round_id=? ORDER BY capture_order
      `,
        )
        .all(round_id);
      const missing = cards.filter((card) => card.state === "missing");
      return textResult({
        round,
        images,
        observations: cards,
        validation: {
          missing_count: missing.length,
          implied_owned_unique: round.expected_total - missing.length,
          expected_owned_unique: round.expected_owned_unique,
          counts_match:
            round.expected_owned_unique === null
              ? null
              : round.expected_total - missing.length ===
                round.expected_owned_unique,
          unconfirmed: cards
            .filter((card) => !card.confirmed)
            .map((card) => card.card_number),
        },
      });
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
      const expectedOwned =
        expected_owned_unique ?? round.expected_owned_unique;
      if (expectedOwned === null) {
        return errorResult(
          "Falta expected_owned_unique. Lee y suma los contadores de la cabecera de la expansión.",
        );
      }
      if (expectedOwned > round.expected_total)
        return errorResult(
          "expected_owned_unique supera el total de la expansión.",
        );
      const observations = getDb()
        .prepare(
          `
        SELECT card_number, state, quantity, confidence, confirmed, source
        FROM capture_round_cards WHERE round_id=? ORDER BY card_number
      `,
        )
        .all(round_id) as RoundCardRow[];
      const excludedAuto = observations.filter(
        (item) => !item.confirmed && !use_auto_detections,
      );
      const lowConfidence = observations.filter(
        (item) =>
          !item.confirmed && use_auto_detections && item.confidence < 0.84,
      );
      if (lowConfidence.length) {
        return errorResult(
          `OCR con confianza insuficiente; confirma manualmente: ${lowConfidence.map((item) => item.card_number).join(", ")}`,
        );
      }
      const usable = observations.filter(
        (item) => item.confirmed || use_auto_detections,
      );
      const missing = new Set(
        usable
          .filter((item) => item.state === "missing")
          .map((item) => item.card_number),
      );
      const impliedOwned = round.expected_total - missing.size;
      if (impliedOwned !== expectedOwned) {
        return errorResult(
          `La ronda no cuadra: catálogo=${round.expected_total}, huecos=${missing.size}, poseídas implícitas=${impliedOwned}, ` +
            `pero la cabecera indica ${expectedOwned}. Faltan ${Math.abs(impliedOwned - expectedOwned)} huecos por revisar.`,
        );
      }
      if (round.quantity_mode === "exact") {
        const explicitOwned = usable.filter(
          (item) => item.state === "owned" && item.quantity !== null,
        );
        if (explicitOwned.length !== expectedOwned) {
          return errorResult(
            `El modo exact necesita cantidades explícitas para las ${expectedOwned} cartas poseídas; hay ${explicitOwned.length}.`,
          );
        }
      }

      const numbers = expansionNumbers(round.expansion_id);
      const observationMap = new Map(
        usable.map((item) => [item.card_number, item]),
      );
      const db = getDb();
      const currentStmt = db.prepare(`
        SELECT COALESCE(o.quantity,0) AS quantity FROM cards c
        LEFT JOIN owned o ON o.card_id=c.id
        WHERE c.expansion_id=? AND c.number=?
      `);
      const writeOwned = db.prepare(`
        INSERT INTO owned (card_id, quantity, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(card_id) DO UPDATE SET quantity=excluded.quantity, updated_at=excluded.updated_at
      `);
      const writeAudit = db.prepare(`
        INSERT INTO capture_round_cards
          (round_id, card_number, state, quantity, confidence, confirmed, source, previous_quantity, applied_quantity, updated_at)
        VALUES (@round_id, @card_number, @state, @quantity, 1, 1, @source, @previous_quantity, @applied_quantity, @updated_at)
        ON CONFLICT(round_id, card_number) DO UPDATE SET
          state=excluded.state, quantity=excluded.quantity, confirmed=1,
          previous_quantity=excluded.previous_quantity, applied_quantity=excluded.applied_quantity,
          updated_at=excluded.updated_at
      `);
      let changed = 0;
      let preservedHigherQuantities = 0;
      const now = new Date().toISOString();
      db.transaction(() => {
        for (const number of numbers) {
          const cardId = `${round.expansion_id}-${String(number).padStart(3, "0")}`;
          const previous = (
            currentStmt.get(round.expansion_id, number) as { quantity: number }
          ).quantity;
          const observation = observationMap.get(number);
          let applied: number;
          if (missing.has(number)) {
            applied = 0;
          } else if (round.quantity_mode === "exact") {
            applied = observation?.quantity ?? 0;
          } else {
            applied = Math.max(previous, observation?.quantity ?? 1);
            if (previous > 1 && applied === previous)
              preservedHigherQuantities++;
          }
          if (applied !== previous) changed++;
          writeOwned.run(cardId, applied, now);
          writeAudit.run({
            round_id,
            card_number: number,
            state: applied > 0 ? "owned" : "missing",
            quantity: applied,
            source: observation?.source ?? "full-round-complement",
            previous_quantity: previous,
            applied_quantity: applied,
            updated_at: now,
          });
        }
        const summary = JSON.stringify({
          total: round.expected_total,
          owned_unique: expectedOwned,
          missing: missing.size,
          changed,
          preserved_higher_quantities: preservedHigherQuantities,
          excluded_auto_detections: excludedAuto.map(
            (item) => item.card_number,
          ),
        });
        db.prepare(
          `
          UPDATE capture_rounds SET status='applied', expected_owned_unique=?, updated_at=?, finalized_at=?, summary=? WHERE id=?
        `,
        ).run(expectedOwned, now, now, summary, round_id);
      })();
      return textResult({
        round_id,
        expansion: round.expansion_id,
        applied: true,
        total: round.expected_total,
        owned_unique: expectedOwned,
        missing: missing.size,
        changed,
        preserved_higher_quantities: preservedHigherQuantities,
      });
    },
  );
}
