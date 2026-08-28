import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getDb,
  resolveRarity,
  cardWithQty,
  catalogIsEmpty,
  EMPTY_CATALOG_MSG,
  type CardRow,
} from "../db.js";
import { syncCatalog, enrichCards } from "../sync.js";
import { enrichFromLimitless } from "../limitless.js";

const BASE_SELECT = `
  SELECT c.*, COALESCE(o.quantity, 0) AS quantity
  FROM cards c LEFT JOIN owned o ON o.card_id = c.id
`;

export function registerCatalogTools(server: McpServer): void {
  server.registerTool(
    "ptcgp_search_cards",
    {
      title: "Buscar cartas",
      description: `Busca cartas en el catálogo completo de Pokémon TCG Pocket, con cantidad poseída incluida en cada resultado.

Filtros (todos opcionales, combinables):
  - query: texto parcial del nombre (case-insensitive)
  - text_search: busca en efectos de ataques, habilidades y cartas trainer (ej. "heal", "discard", "draw")
  - expansion: id de expansión (a1, a1a, a2, a2a, a2b, a3, a3a, a3b, a4, a4a, a4b, b1, b1a, b2, b2a, b2b, b3, pa, pb)
  - pack: nombre del sobre (Mewtwo, Charizard, Pikachu, etc.)
  - rarity: símbolo o alias (d1=◊, d2=◊◊, d3=◊◊◊, d4=◊◊◊◊, s1=☆, s2=☆☆, s3=☆☆☆, crown=♕, promo)
  - type: Grass|Fire|Water|Lightning|Psychic|Fighting|Darkness|Metal|Dragon|Colorless|Trainer
  - category: Pokemon|Trainer
  - stage: Basic|Stage1|Stage2
  - min_damage: daño mínimo del mejor ataque (para construcción de mazos)
  - has_ability: true para solo cartas con habilidad
  - owned_filter: 'all' (defecto) | 'owned' (quantity>0) | 'missing' (quantity=0) | 'duplicates' (quantity>1)
  - ex: true para solo cartas ex
  - limit/offset para paginación

Cada resultado incluye max_damage y has_ability. Para ataques/habilidades/efectos completos usa ptcgp_get_card. Los datos de combate provienen de TCGdex; sets muy recientes pueden no tenerlos aún (ejecutar ptcgp_enrich_catalog periódicamente).

Ejemplos: "atacantes de fuego para mi mazo que ya tenga" -> type="Fire", min_damage=100, owned_filter="owned". "cartas que curen" -> text_search="heal".`,
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe("Texto parcial del nombre"),
        text_search: z
          .string()
          .min(2)
          .max(100)
          .optional()
          .describe("Buscar en efectos de ataques/habilidades/trainers"),
        expansion: z
          .string()
          .max(10)
          .optional()
          .describe("Id de expansión, ej. a1"),
        pack: z.string().max(50).optional().describe("Nombre del sobre"),
        rarity: z
          .string()
          .max(10)
          .optional()
          .describe("Rareza: d1-d4, s1-s3, crown, promo o símbolo"),
        type: z.string().max(20).optional().describe("Tipo de carta"),
        category: z.enum(["Pokemon", "Trainer"]).optional(),
        stage: z.enum(["Basic", "Stage1", "Stage2"]).optional(),
        min_damage: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Daño mínimo del mejor ataque"),
        has_ability: z
          .boolean()
          .optional()
          .describe("Solo cartas con habilidad"),
        owned_filter: z
          .enum(["all", "owned", "missing", "duplicates"])
          .default("all"),
        ex: z.boolean().optional().describe("Solo cartas ex"),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
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
      const where: string[] = [];
      const args: Record<string, unknown> = {};
      if (p.query) {
        where.push("c.name LIKE @q");
        args.q = `%${p.query}%`;
      }
      if (p.expansion) {
        where.push("c.expansion_id = @exp");
        args.exp = p.expansion.toLowerCase();
      }
      if (p.pack) {
        where.push("c.pack LIKE @pack");
        args.pack = `%${p.pack}%`;
      }
      if (p.rarity) {
        const r = resolveRarity(p.rarity);
        if (!r)
          return {
            content: [
              {
                type: "text",
                text: `Rareza '${p.rarity}' no reconocida. Usa d1-d4, s1-s3, crown, promo.`,
              },
            ],
            isError: true,
          };
        where.push("c.rarity = @rar");
        args.rar = r;
      }
      if (p.type) {
        where.push("LOWER(c.type) = LOWER(@type)");
        args.type = p.type;
      }
      if (p.category) {
        where.push("c.category = @cat");
        args.cat = p.category;
      }
      if (p.stage) {
        where.push("c.stage = @stage");
        args.stage = p.stage;
      }
      if (p.min_damage) {
        where.push("c.max_damage >= @mindmg");
        args.mindmg = p.min_damage;
      }
      if (p.has_ability !== undefined) {
        where.push(
          p.has_ability ? "c.abilities IS NOT NULL" : "c.abilities IS NULL",
        );
      }
      if (p.text_search) {
        where.push(
          "(c.attacks LIKE @ts OR c.abilities LIKE @ts OR c.effect LIKE @ts)",
        );
        args.ts = `%${p.text_search}%`;
      }
      if (p.ex !== undefined) {
        where.push("c.is_ex = @ex");
        args.ex = p.ex ? 1 : 0;
      }
      if (p.owned_filter === "owned") where.push("COALESCE(o.quantity,0) > 0");
      if (p.owned_filter === "missing")
        where.push("COALESCE(o.quantity,0) = 0");
      if (p.owned_filter === "duplicates")
        where.push("COALESCE(o.quantity,0) > 1");

      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const db = getDb();
      const total = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM cards c LEFT JOIN owned o ON o.card_id = c.id ${whereSql}`,
          )
          .get(args) as { n: number }
      ).n;
      const rows = db
        .prepare(
          `${BASE_SELECT} ${whereSql} ORDER BY c.expansion_id, c.number LIMIT @limit OFFSET @offset`,
        )
        .all({ ...args, limit: p.limit, offset: p.offset }) as CardRow[];

      const output = {
        total,
        count: rows.length,
        offset: p.offset,
        has_more: total > p.offset + rows.length,
        cards: rows.map((r) => cardWithQty(r)),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "ptcgp_get_card",
    {
      title: "Detalle de carta",
      description: `Detalle completo de una carta por id (ej. 'a1-036'): stats, ataques (coste, daño, efecto), habilidades, debilidades, retirada, stage, línea evolutiva, efecto (trainers), copias poseídas e imagen. El campo battle_data indica si la carta tiene datos de combate (sets muy recientes pueden no tenerlos hasta ejecutar ptcgp_enrich_catalog).`,
      inputSchema: {
        card_id: z
          .string()
          .regex(/^[a-z0-9]+-\d{1,3}$/i, "Formato esperado: a1-001")
          .describe("Id de la carta"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ card_id }) => {
      const row = getDb()
        .prepare(`${BASE_SELECT} WHERE c.id = ?`)
        .get(card_id.toLowerCase()) as CardRow | undefined;
      if (!row) {
        return {
          content: [
            {
              type: "text",
              text: `Carta '${card_id}' no encontrada. Verifica el id con ptcgp_search_cards.`,
            },
          ],
          isError: true,
        };
      }
      const output = { ...cardWithQty(row, true), image: row.image };
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "ptcgp_enrich_catalog",
    {
      title: "Enriquecer catálogo (datos de combate)",
      description: `Descarga de TCGdex los datos de combate (ataques, habilidades, debilidades, retirada, stage, efectos de trainers) para las cartas que aún no los tienen. Incremental: solo procesa cartas pendientes salvo force=true. Con 'expansion' limita a un set (recomendado para llamadas desde conversación; el catálogo completo tarda minutos y conviene hacerlo con 'npm run sync' en shell). Fuentes en cascada: TCGdex primero, y para lo que TCGdex no cubra (sets recién salidos) scrapea las páginas de carta de Limitless TCG, que siempre tiene los sets nuevos. pending_total=0 significa catálogo completo.`,
      inputSchema: {
        expansion: z
          .string()
          .max(10)
          .optional()
          .describe("Limitar a una expansión, ej. b2"),
        force: z
          .boolean()
          .default(false)
          .describe("Reprocesar también cartas ya enriquecidas"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .optional()
          .describe("Máximo de cartas a procesar"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (p) => {
      if (catalogIsEmpty())
        return {
          content: [{ type: "text", text: EMPTY_CATALOG_MSG }],
          isError: true,
        };
      try {
        const r = await enrichCards({
          expansion: p.expansion,
          force: p.force,
          limit: p.limit,
        });
        const l =
          r.pending_ids.length > 0
            ? await enrichFromLimitless({
                expansion: p.expansion,
                ids: r.pending_ids,
              })
            : null;
        const output = {
          tcgdex: {
            enriched: r.enriched,
            not_found: r.not_found,
            errors: r.errors,
          },
          limitless: l
            ? { enriched: l.enriched, not_found: l.not_found, errors: l.errors }
            : null,
          pending_total: l ? l.pending_total : r.pending_total,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error enriqueciendo: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "ptcgp_list_expansions",
    {
      title: "Listar expansiones",
      description: `Lista todas las expansiones del juego con sus sobres y el progreso de colección del usuario en cada una: total de cartas, poseídas únicas y porcentaje. Útil como visión general o para decidir en qué set centrarse.`,
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
      const rows = getDb()
        .prepare(
          `
        SELECT e.id, e.name, e.packs,
          COUNT(c.id) AS total,
          SUM(CASE WHEN COALESCE(o.quantity,0) > 0 THEN 1 ELSE 0 END) AS owned_unique
        FROM expansions e
        JOIN cards c ON c.expansion_id = e.id
        LEFT JOIN owned o ON o.card_id = c.id
        GROUP BY e.id ORDER BY e.id
      `,
        )
        .all() as {
        id: string;
        name: string;
        packs: string;
        total: number;
        owned_unique: number;
      }[];
      const output = {
        expansions: rows.map((r) => ({
          id: r.id,
          name: r.name,
          packs: JSON.parse(r.packs) as string[],
          total_cards: r.total,
          owned_unique: r.owned_unique,
          completion_pct: Math.round((r.owned_unique / r.total) * 1000) / 10,
        })),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "ptcgp_sync_catalog",
    {
      title: "Sincronizar catálogo",
      description: `Descarga el catálogo completo de cartas y expansiones desde el dataset comunitario (chase-manning/pokemon-tcg-pocket-cards, scrapeado de Limitless TCG) y actualiza la base local. Ejecutar tras el primer arranque y cuando salga una expansión nueva. No toca la colección del usuario. Requiere red.`,
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const r = await syncCatalog();
        const output = {
          ok: true,
          total_cards: r.cards,
          expansions: r.expansions,
          new_cards: r.newCards,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error sincronizando: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
