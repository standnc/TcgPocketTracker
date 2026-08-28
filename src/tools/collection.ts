import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { inTransaction, EMPTY_CATALOG_MSG, resolveRarity } from "../db.js";
import { computeQuantity, parseNumbers } from "../domain/collection.js";
import { ownedRepo } from "../repositories/owned.js";
import { cardsRepo } from "../repositories/cards.js";

function setQty(
  cardId: string,
  quantity: number,
  mode: "set" | "add",
): { ok: boolean; error?: string; final?: number } {
  if (!cardsRepo().exists(cardId))
    return { ok: false, error: `Carta '${cardId}' no existe en el catálogo` };
  const owned = ownedRepo();
  const applied = computeQuantity(owned.getQuantity(cardId), quantity, mode);
  owned.setQuantity(cardId, applied, new Date().toISOString());
  return { ok: true, final: applied };
}

export function registerCollectionTools(server: McpServer): void {
  server.registerTool(
    "ptcgp_collection_stats",
    {
      title: "Estadísticas de colección",
      description: `Resumen global de la colección del usuario: cartas únicas poseídas vs total del catálogo, copias totales, desglose por expansión y por rareza. Es el punto de partida para cualquier pregunta general tipo "cómo va mi colección".`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const repo = cardsRepo();
      if (repo.isEmpty())
        return {
          content: [{ type: "text", text: EMPTY_CATALOG_MSG }],
          isError: true,
        };
      const { global, byExpansion, byRarity } = repo.stats();
      const output = {
        owned_unique: global.owned_unique ?? 0,
        catalog_total: global.total,
        completion_pct:
          Math.round(((global.owned_unique ?? 0) / global.total) * 1000) / 10,
        total_copies: global.total_copies ?? 0,
        catalog_last_sync: repo.lastSync(),
        by_expansion: byExpansion.map((e) => ({
          ...e,
          completion_pct: Math.round((e.owned_unique / e.total) * 1000) / 10,
        })),
        by_rarity: byRarity,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "ptcgp_missing_cards",
    {
      title: "Cartas faltantes / mejor sobre",
      description: `Analiza qué cartas faltan al usuario, agrupadas por sobre (pack), ordenando los sobres por número de faltantes descendente — responde directamente a "qué sobre me conviene abrir". Filtros opcionales por expansión y rareza máxima (ej. max_rarity='d4' ignora ☆/♕, que en la práctica salen por rareza visual, no por pack normal).

Devuelve { packs: [{pack, expansion, missing_count, total_in_pack, missing: [{id, name, rarity}] }] }. Con include_cards=false omite el listado de cartas y devuelve solo el ranking (más compacto).`,
      inputSchema: {
        expansion: z
          .string()
          .max(10)
          .optional()
          .describe("Limitar a una expansión, ej. a3"),
        max_rarity: z
          .string()
          .max(10)
          .optional()
          .describe(
            "Rareza máxima a considerar: d1-d4 (diamantes). Omite estrellas/corona si se indica",
          ),
        include_cards: z
          .boolean()
          .default(true)
          .describe("Incluir listado de cartas faltantes por pack"),
        limit_per_pack: z.number().int().min(1).max(200).default(50),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (p) => {
      const repo = cardsRepo();
      if (repo.isEmpty())
        return {
          content: [{ type: "text", text: EMPTY_CATALOG_MSG }],
          isError: true,
        };
      let rarities: string[] | undefined;
      if (p.max_rarity) {
        const order = ["◊", "◊◊", "◊◊◊", "◊◊◊◊", "☆", "☆☆", "☆☆☆", "♕"];
        const r = resolveRarity(p.max_rarity);
        if (!r || !order.includes(r)) {
          return {
            content: [
              {
                type: "text",
                text: `max_rarity '${p.max_rarity}' no válida. Usa d1-d4, s1-s3 o crown.`,
              },
            ],
            isError: true,
          };
        }
        rarities = order.slice(0, order.indexOf(r) + 1);
      }
      const { rows, totals } = repo.missing({
        expansion: p.expansion?.toLowerCase(),
        rarities,
      });
      const totalMap = new Map(
        totals.map((t) => [`${t.expansion_id}|${t.pack}`, t.n]),
      );

      const grouped = new Map<string, typeof rows>();
      for (const r of rows) {
        const key = `${r.expansion_id}|${r.pack}`;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(r);
      }
      const packs = [...grouped.entries()]
        .map(([key, cards]) => {
          const [expansion, pack] = key.split("|");
          return {
            pack,
            expansion,
            missing_count: cards.length,
            total_in_pack: totalMap.get(key) ?? cards.length,
            ...(p.include_cards
              ? {
                  missing: cards
                    .slice(0, p.limit_per_pack)
                    .map(({ id, name, rarity }) => ({ id, name, rarity })),
                }
              : {}),
          };
        })
        .sort((a, b) => b.missing_count - a.missing_count);

      const output = { total_missing: rows.length, packs };
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "ptcgp_set_card_quantity",
    {
      title: "Fijar cantidad de una carta",
      description: `Registra cuántas copias de una carta posee el usuario. mode='set' fija el valor exacto (defecto); mode='add' suma (admite negativos para restar, nunca baja de 0). Usa ptcgp_bulk_update_collection para varias cartas o ptcgp_mark_range para rangos de números consecutivos.`,
      inputSchema: {
        card_id: z
          .string()
          .regex(/^[a-z0-9]+-\d{1,3}$/i)
          .describe("Id de carta, ej. a1-001"),
        quantity: z
          .number()
          .int()
          .min(-99)
          .max(99)
          .describe("Cantidad (set) o delta (add)"),
        mode: z.enum(["set", "add"]).default("set"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ card_id, quantity, mode }) => {
      const r = setQty(card_id.toLowerCase(), quantity, mode);
      if (!r.ok)
        return { content: [{ type: "text", text: r.error! }], isError: true };
      const output = { card_id: card_id.toLowerCase(), quantity: r.final };
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "ptcgp_bulk_update_collection",
    {
      title: "Actualización masiva",
      description: `Actualiza la cantidad poseída de múltiples cartas en una sola llamada transaccional. Cada item: {card_id, quantity}. mode='set' fija valores, mode='add' suma. Ideal al procesar capturas de pantalla de la colección o dictados del usuario. Ids inexistentes se reportan en 'errors' sin abortar el resto.`,
      inputSchema: {
        items: z
          .array(
            z.object({
              card_id: z.string().regex(/^[a-z0-9]+-\d{1,3}$/i),
              quantity: z.number().int().min(-99).max(99),
            }),
          )
          .min(1)
          .max(500)
          .describe("Lista de cartas y cantidades"),
        mode: z.enum(["set", "add"]).default("set"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ items, mode }) => {
      const errors: string[] = [];
      let updated = 0;
      inTransaction(() => {
        for (const it of items) {
          const r = setQty(it.card_id.toLowerCase(), it.quantity, mode);
          if (r.ok) updated++;
          else errors.push(r.error!);
        }
      });
      const output = { updated, errors };
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "ptcgp_mark_range",
    {
      title: "Marcar rango de cartas",
      description: `Marca como poseídas (o ajusta) cartas de una expansión por números: numbers acepta lista y rangos, ej. "1,3,7-15,22". Pensado para volcado rápido manual: "del set a1 tengo de la 1 a la 50 menos la 33" se resuelve con dos llamadas (set 1-50, luego set 33 a 0) o una llamada "1-32,34-50". Números que no existan en la expansión se reportan en 'errors'.`,
      inputSchema: {
        expansion: z.string().max(10).describe("Id de expansión, ej. a1"),
        numbers: z
          .string()
          .min(1)
          .max(2000)
          .describe('Números y rangos: "1,3,7-15"'),
        quantity: z.number().int().min(0).max(99).default(1),
        mode: z.enum(["set", "add"]).default("set"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ expansion, numbers, quantity, mode }) => {
      let nums: number[];
      try {
        nums = parseNumbers(numbers);
      } catch (e) {
        return {
          content: [
            { type: "text", text: e instanceof Error ? e.message : String(e) },
          ],
          isError: true,
        };
      }
      const exp = expansion.toLowerCase();
      const existing = new Set(cardsRepo().numbersInExpansion(exp));
      if (existing.size === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Expansión '${exp}' no existe. Consulta ptcgp_list_expansions.`,
            },
          ],
          isError: true,
        };
      }
      const errors: string[] = [];
      let updated = 0;
      inTransaction(() => {
        for (const n of nums) {
          if (!existing.has(n)) {
            errors.push(`${exp}-${n} no existe`);
            continue;
          }
          const id = `${exp}-${String(n).padStart(3, "0")}`;
          const r = setQty(id, quantity, mode);
          if (r.ok) updated++;
          else errors.push(r.error!);
        }
      });
      const output = { expansion: exp, updated, errors };
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
}
