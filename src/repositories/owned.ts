import { getDb } from "../db.js";

/** Connection type, derived from the single accessor so this port never imports
 * the better-sqlite3 module directly. */
type Db = ReturnType<typeof getDb>;

/**
 * Persistence port for the `owned` table: the per-card copy counts. The domain
 * decides *what* quantity to store (see `computeQuantity`/`planFinalize`); this
 * port only reads and writes rows. All statements are parametrized.
 */
export interface OwnedRepository {
  /** Current stored quantity for a card, or 0 when it has no `owned` row. */
  getQuantity(cardId: string): number;
  /** Upserts the owned quantity for a card. Callers pass an already-floored
   * (>= 0) value; the table also enforces `CHECK (quantity >= 0)`. */
  setQuantity(cardId: string, quantity: number, updatedAt: string): void;
  /** Current owned quantity for every card of an expansion, keyed by card
   * number, defaulting to 0 for cards with no `owned` row. */
  quantitiesByExpansion(expansionId: string): Map<number, number>;
}

export function createSqliteOwnedRepository(db: Db): OwnedRepository {
  const selectQuantity = db.prepare(
    "SELECT quantity FROM owned WHERE card_id = ?",
  );
  const upsertQuantity = db.prepare(`
    INSERT INTO owned (card_id, quantity, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(card_id) DO UPDATE SET quantity = excluded.quantity, updated_at = excluded.updated_at
  `);
  const selectByExpansion = db.prepare(`
    SELECT c.number AS number, COALESCE(o.quantity, 0) AS quantity
    FROM cards c LEFT JOIN owned o ON o.card_id = c.id
    WHERE c.expansion_id = ?
  `);

  return {
    getQuantity(cardId) {
      const row = selectQuantity.get(cardId) as
        { quantity: number } | undefined;
      return row?.quantity ?? 0;
    },
    setQuantity(cardId, quantity, updatedAt) {
      upsertQuantity.run(cardId, quantity, updatedAt);
    },
    quantitiesByExpansion(expansionId) {
      const rows = selectByExpansion.all(expansionId) as {
        number: number;
        quantity: number;
      }[];
      return new Map(rows.map((row) => [row.number, row.quantity]));
    },
  };
}

let cached: OwnedRepository | null = null;

/** Process-wide {@link OwnedRepository} bound to the shared connection. Its
 * prepared statements run on the same connection as {@link getDb}, so calls made
 * inside a `getDb().transaction(...)` participate in that transaction. */
export function ownedRepo(): OwnedRepository {
  if (!cached) cached = createSqliteOwnedRepository(getDb());
  return cached;
}
