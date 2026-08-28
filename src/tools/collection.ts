import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getDb,
  catalogIsEmpty,
  EMPTY_CATALOG_MSG,
  resolveRarity,
} from "../db.js";

function setQty(
  cardId: string,
  quantity: number,
  mode: "set" | "add",
): { ok: boolean; error?: string; final?: number } {
  const db = getDb();
  const card = db.prepare("SELECT id FROM cards WHERE id = ?").get(cardId) as
    { id: string } | undefined;
  if (!card)
    return { ok: false, error: `Carta '${cardId}' no existe en el catálogo` };
  const now = new Date().toISOString();
  if (mode === "add") {
    db.prepare(
      `
      INSERT INTO owned (card_id, quantity, updated_at) VALUES (@card_id, MAX(@delta, 0), @updated_at)
      ON CONFLICT(card_id) DO UPDATE SET
        quantity = MAX(owned.quantity + @delta, 0),
        updated_at = @updated_at
    `,
    ).run({ card_id: cardId, delta: quantity, updated_at: now });
  } else {
    db.prepare(
      `
      INSERT INTO owned (card_id, quantity, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(card_id) DO UPDATE SET quantity = excluded.quantity, updated_at = excluded.updated_at
    `,
    ).run(cardId, Math.max(quantity, 0), now);
  }
  const final = (
    db.prepare("SELECT quantity FROM owned WHERE card_id = ?").get(cardId) as {
      quantity: number;
    }
  ).quantity;
  return { ok: true, final };
}

export function parseNumbers(spec: string): number[] {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const t = part.trim();
    if (!t) continue;
    const range = t.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const a = parseInt(range[1], 10),
        b = parseInt(range[2], 10);
      if (a > b || b - a > 500) throw new Error(`Rango inválido: '${t}'`);
      for (let i = a; i <= b; i++) out.add(i);
    } else if (/^\d+$/.test(t)) {
      out.add(parseInt(t, 10));
    } else {
      throw new Error(
        `Token inválido: '${t}'. Usa números y rangos: "1,3,7-15"`,
      );
    }
  }
  return [...out].sort((a, b) => a - b);
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
      if (catalogIsEmpty())
        return {
          content: [{ type: "text", text: EMPTY_CATALOG_MSG }],
          isError: true,
        };
      const db = getDb();
      const global = db
        .prepare(
          `
        SELECT COUNT(c.id) AS total,
          SUM(CASE WHEN COALESCE(o.quantity,0) > 0 THEN 1 ELSE 0 END) AS owned_unique,
          SUM(COALESCE(o.quantity,0)) AS total_copies
        FROM cards c LEFT JOIN owned o ON o.card_id = c.id
      `,
        )
        .get() as { total: number; owned_unique: number; total_copies: number };
      const byExp = db
        .prepare(
          `
        SELECT c.expansion_id AS id, c.expansion_name AS name, COUNT(c.id) AS total,
          SUM(CASE WHEN COALESCE(o.quantity,0) > 0 THEN 1 ELSE 0 END) AS owned_unique
        FROM cards c LEFT JOIN owned o ON o.card_id = c.id
        GROUP BY c.expansion_id ORDER BY c.expansion_id
      `,
        )
        .all() as {
        id: string;
        name: string;
        total: number;
        owned_unique: number;
      }[];
      const byRarity = db
        .prepare(
          `
        SELECT c.rarity, COUNT(c.id) AS total,
          SUM(CASE WHEN COALESCE(o.quantity,0) > 0 THEN 1 ELSE 0 END) AS owned_unique
        FROM cards c LEFT JOIN owned o ON o.card_id = c.id
        GROUP BY c.rarity ORDER BY total DESC
      `,
        )
        .all() as { rarity: string; total: number; owned_unique: number }[];
      const lastSync = db
        .prepare("SELECT value FROM meta WHERE key = 'last_sync'")
        .get() as { value: string } | undefined;

      const output = {
        owned_unique: global.owned_unique ?? 0,
        catalog_total: global.total,
        completion_pct:
          Math.round(((global.owned_unique ?? 0) / global.total) * 1000) / 10,
        total_copies: global.total_copies ?? 0,
        catalog_last_sync: lastSync?.value ?? null,
        by_expansion: byExp.map((e) => ({
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
      if (catalogIsEmpty())
        return {
          content: [{ type: "text", text: EMPTY_CATALOG_MSG }],
          isError: true,
        };
      const where: string[] = [
        "COALESCE(o.quantity,0) = 0",
        "c.pack IS NOT NULL",
      ];
      const args: Record<string, unknown> = {};
      if (p.expansion) {
        where.push("c.expansion_id = @exp");
        args.exp = p.expansion.toLowerCase();
      }
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
        const allowed = order.slice(0, order.indexOf(r) + 1);
        where.push(
          `c.rarity IN (${allowed.map((_, i) => `@r${i}`).join(",")})`,
        );
        allowed.forEach((v, i) => {
          args[`r${i}`] = v;
        });
      }
      const rows = getDb()
        .prepare(
          `
        SELECT c.id, c.name, c.rarity, c.pack, c.expansion_id
        FROM cards c LEFT JOIN owned o ON o.card_id = c.id
        WHERE ${where.join(" AND ")}
        ORDER BY c.expansion_id, c.number
      `,
        )
        .all(args) as {
        id: string;
        name: string;
        rarity: string;
        pack: string;
        expansion_id: string;
      }[];

      const totals = getDb()
        .prepare(
          `
        SELECT pack, expansion_id, COUNT(*) AS n FROM cards WHERE pack IS NOT NULL GROUP BY pack, expansion_id
      `,
        )
        .all() as { pack: string; expansion_id: string; n: number }[];
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
      getDb().transaction(() => {
        for (const it of items) {
          const r = setQty(it.card_id.toLowerCase(), it.quantity, mode);
          if (r.ok) updated++;
          else errors.push(r.error!);
        }
      })();
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
      const existing = new Set(
        (
          getDb()
            .prepare("SELECT number FROM cards WHERE expansion_id = ?")
            .all(exp) as { number: number }[]
        ).map((r) => r.number),
      );
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
      getDb().transaction(() => {
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
      })();
      const output = { expansion: exp, updated, errors };
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
}
