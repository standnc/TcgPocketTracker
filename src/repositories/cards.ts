import { getDb, type CardRow } from "../db.js";

/** Connection type, derived from the single accessor so this port never imports
 * the better-sqlite3 module directly. */
type Db = ReturnType<typeof getDb>;

const BASE_SELECT = `
  SELECT c.*, COALESCE(o.quantity, 0) AS quantity
  FROM cards c LEFT JOIN owned o ON o.card_id = c.id
`;

/** Filters for {@link CardsRepository.search}. Rarity is an already-resolved
 * symbol and expansion is already lower-cased; the adapter owns that input
 * normalization and its user-facing errors. */
export interface CardSearchCriteria {
  query?: string;
  text_search?: string;
  expansion?: string;
  pack?: string;
  rarity?: string;
  type?: string;
  category?: string;
  stage?: string;
  min_damage?: number;
  has_ability?: boolean;
  owned_filter: "all" | "owned" | "missing" | "duplicates";
  ex?: boolean;
  limit: number;
  offset: number;
}

export interface CardSearchResult {
  total: number;
  cards: CardRow[];
}

/** Filters for {@link CardsRepository.missing}. `rarities` is the resolved set
 * of allowed rarity symbols (from `max_rarity`); undefined means all. */
export interface MissingCriteria {
  expansion?: string;
  rarities?: string[];
}

export interface MissingCardRow {
  id: string;
  name: string;
  rarity: string;
  pack: string;
  expansion_id: string;
}

export interface PackTotalRow {
  pack: string;
  expansion_id: string;
  n: number;
}

export interface MissingResult {
  rows: MissingCardRow[];
  totals: PackTotalRow[];
}

export interface CollectionGlobalStats {
  total: number;
  owned_unique: number;
  total_copies: number;
}

export interface ExpansionStatRow {
  id: string;
  name: string;
  total: number;
  owned_unique: number;
}

export interface RarityStatRow {
  rarity: string;
  total: number;
  owned_unique: number;
}

export interface CollectionStats {
  global: CollectionGlobalStats;
  byExpansion: ExpansionStatRow[];
  byRarity: RarityStatRow[];
}

export interface ExpansionProgressRow {
  id: string;
  name: string;
  packs: string;
  total: number;
  owned_unique: number;
}

/**
 * Read port for the catalog aggregate (`cards`, plus the `owned`/`expansions`
 * joins and the `meta.last_sync` marker used by the read models). The catalog
 * is written by the sync/enrich services, not by these tools, so this port only
 * reads. All statements are parametrized; the dynamic `WHERE` builders bind
 * values, never concatenate them.
 */
export interface CardsRepository {
  isEmpty(): boolean;
  exists(cardId: string): boolean;
  findById(cardId: string): CardRow | undefined;
  numbersInExpansion(expansionId: string): number[];
  search(criteria: CardSearchCriteria): CardSearchResult;
  stats(): CollectionStats;
  lastSync(): string | null;
  missing(criteria: MissingCriteria): MissingResult;
  expansionProgress(): ExpansionProgressRow[];
}

export function createSqliteCardsRepository(db: Db): CardsRepository {
  const countCards = db.prepare("SELECT COUNT(*) AS n FROM cards");
  const existsCard = db.prepare("SELECT 1 AS ok FROM cards WHERE id = ?");
  const selectById = db.prepare(`${BASE_SELECT} WHERE c.id = ?`);
  const selectNumbers = db.prepare(
    "SELECT number FROM cards WHERE expansion_id = ? ORDER BY number",
  );
  const selectGlobalStats = db.prepare(`
    SELECT COUNT(c.id) AS total,
      SUM(CASE WHEN COALESCE(o.quantity,0) > 0 THEN 1 ELSE 0 END) AS owned_unique,
      SUM(COALESCE(o.quantity,0)) AS total_copies
    FROM cards c LEFT JOIN owned o ON o.card_id = c.id
  `);
  const selectStatsByExpansion = db.prepare(`
    SELECT c.expansion_id AS id, c.expansion_name AS name, COUNT(c.id) AS total,
      SUM(CASE WHEN COALESCE(o.quantity,0) > 0 THEN 1 ELSE 0 END) AS owned_unique
    FROM cards c LEFT JOIN owned o ON o.card_id = c.id
    GROUP BY c.expansion_id ORDER BY c.expansion_id
  `);
  const selectStatsByRarity = db.prepare(`
    SELECT c.rarity, COUNT(c.id) AS total,
      SUM(CASE WHEN COALESCE(o.quantity,0) > 0 THEN 1 ELSE 0 END) AS owned_unique
    FROM cards c LEFT JOIN owned o ON o.card_id = c.id
    GROUP BY c.rarity ORDER BY total DESC
  `);
  const selectLastSync = db.prepare(
    "SELECT value FROM meta WHERE key = 'last_sync'",
  );
  const selectPackTotals = db.prepare(`
    SELECT pack, expansion_id, COUNT(*) AS n FROM cards
    WHERE pack IS NOT NULL GROUP BY pack, expansion_id
  `);
  const selectExpansionProgress = db.prepare(`
    SELECT e.id, e.name, e.packs,
      COUNT(c.id) AS total,
      SUM(CASE WHEN COALESCE(o.quantity,0) > 0 THEN 1 ELSE 0 END) AS owned_unique
    FROM expansions e
    JOIN cards c ON c.expansion_id = e.id
    LEFT JOIN owned o ON o.card_id = c.id
    GROUP BY e.id ORDER BY e.id
  `);

  function buildSearchWhere(criteria: CardSearchCriteria): {
    sql: string;
    args: Record<string, unknown>;
  } {
    const where: string[] = [];
    const args: Record<string, unknown> = {};
    if (criteria.query) {
      where.push("c.name LIKE @q");
      args.q = `%${criteria.query}%`;
    }
    if (criteria.expansion) {
      where.push("c.expansion_id = @exp");
      args.exp = criteria.expansion;
    }
    if (criteria.pack) {
      where.push("c.pack LIKE @pack");
      args.pack = `%${criteria.pack}%`;
    }
    if (criteria.rarity) {
      where.push("c.rarity = @rar");
      args.rar = criteria.rarity;
    }
    if (criteria.type) {
      where.push("LOWER(c.type) = LOWER(@type)");
      args.type = criteria.type;
    }
    if (criteria.category) {
      where.push("c.category = @cat");
      args.cat = criteria.category;
    }
    if (criteria.stage) {
      where.push("c.stage = @stage");
      args.stage = criteria.stage;
    }
    if (criteria.min_damage) {
      where.push("c.max_damage >= @mindmg");
      args.mindmg = criteria.min_damage;
    }
    if (criteria.has_ability !== undefined) {
      where.push(
        criteria.has_ability
          ? "c.abilities IS NOT NULL"
          : "c.abilities IS NULL",
      );
    }
    if (criteria.text_search) {
      where.push(
        "(c.attacks LIKE @ts OR c.abilities LIKE @ts OR c.effect LIKE @ts)",
      );
      args.ts = `%${criteria.text_search}%`;
    }
    if (criteria.ex !== undefined) {
      where.push("c.is_ex = @ex");
      args.ex = criteria.ex ? 1 : 0;
    }
    if (criteria.owned_filter === "owned")
      where.push("COALESCE(o.quantity,0) > 0");
    if (criteria.owned_filter === "missing")
      where.push("COALESCE(o.quantity,0) = 0");
    if (criteria.owned_filter === "duplicates")
      where.push("COALESCE(o.quantity,0) > 1");
    return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", args };
  }

  return {
    isEmpty() {
      return (countCards.get() as { n: number }).n === 0;
    },
    exists(cardId) {
      return existsCard.get(cardId) !== undefined;
    },
    findById(cardId) {
      return selectById.get(cardId) as CardRow | undefined;
    },
    numbersInExpansion(expansionId) {
      return (selectNumbers.all(expansionId) as { number: number }[]).map(
        (row) => row.number,
      );
    },
    search(criteria) {
      const { sql, args } = buildSearchWhere(criteria);
      const total = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM cards c LEFT JOIN owned o ON o.card_id = c.id ${sql}`,
          )
          .get(args) as { n: number }
      ).n;
      const cards = db
        .prepare(
          `${BASE_SELECT} ${sql} ORDER BY c.expansion_id, c.number LIMIT @limit OFFSET @offset`,
        )
        .all({
          ...args,
          limit: criteria.limit,
          offset: criteria.offset,
        }) as CardRow[];
      return { total, cards };
    },
    stats() {
      return {
        global: selectGlobalStats.get() as CollectionGlobalStats,
        byExpansion: selectStatsByExpansion.all() as ExpansionStatRow[],
        byRarity: selectStatsByRarity.all() as RarityStatRow[],
      };
    },
    lastSync() {
      const row = selectLastSync.get() as { value: string } | undefined;
      return row?.value ?? null;
    },
    missing(criteria) {
      const where: string[] = [
        "COALESCE(o.quantity,0) = 0",
        "c.pack IS NOT NULL",
      ];
      const args: Record<string, unknown> = {};
      if (criteria.expansion) {
        where.push("c.expansion_id = @exp");
        args.exp = criteria.expansion;
      }
      if (criteria.rarities && criteria.rarities.length) {
        where.push(
          `c.rarity IN (${criteria.rarities.map((_, index) => `@r${index}`).join(",")})`,
        );
        criteria.rarities.forEach((value, index) => {
          args[`r${index}`] = value;
        });
      }
      const rows = db
        .prepare(
          `
        SELECT c.id, c.name, c.rarity, c.pack, c.expansion_id
        FROM cards c LEFT JOIN owned o ON o.card_id = c.id
        WHERE ${where.join(" AND ")}
        ORDER BY c.expansion_id, c.number
      `,
        )
        .all(args) as MissingCardRow[];
      return { rows, totals: selectPackTotals.all() as PackTotalRow[] };
    },
    expansionProgress() {
      return selectExpansionProgress.all() as ExpansionProgressRow[];
    },
  };
}

let cached: CardsRepository | null = null;

/** Process-wide {@link CardsRepository} bound to the shared connection. */
export function cardsRepo(): CardsRepository {
  if (!cached) cached = createSqliteCardsRepository(getDb());
  return cached;
}
