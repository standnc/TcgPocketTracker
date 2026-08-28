import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./config.js";

export const RARITY_ALIASES: Record<string, string> = {
  d1: "◊",
  d2: "◊◊",
  d3: "◊◊◊",
  d4: "◊◊◊◊",
  s1: "☆",
  s2: "☆☆",
  s3: "☆☆☆",
  crown: "♕",
  promo: "Promo",
  "◊": "◊",
  "◊◊": "◊◊",
  "◊◊◊": "◊◊◊",
  "◊◊◊◊": "◊◊◊◊",
  "☆": "☆",
  "☆☆": "☆☆",
  "☆☆☆": "☆☆☆",
  "♕": "♕",
};

export function resolveRarity(input: string): string | null {
  return (
    RARITY_ALIASES[input.trim().toLowerCase()] ??
    RARITY_ALIASES[input.trim()] ??
    null
  );
}

export { dataDir } from "./config.js";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  db = new Database(join(dir, "collection.db"));
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  runMigrations(db, { backupDir: join(dir, "backups") });
  return db;
}

/**
 * Runs `fn` inside a single deferred transaction on the shared connection.
 * Repository statements invoked within `fn` participate in the same transaction
 * because better-sqlite3 is synchronous and single-connection.
 */
export function inTransaction<T>(fn: () => T): T {
  return getDb().transaction(fn)();
}

/**
 * Like {@link inTransaction} but starts the transaction in IMMEDIATE mode, so a
 * write lock is taken up front. Used by round finalization to make its
 * read-plan-write cycle atomic against other local processes sharing the data
 * directory.
 */
export function inImmediateTransaction<T>(fn: () => T): T {
  return getDb().transaction(fn).immediate();
}

const INITIAL_SCHEMA = `
    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      expansion_id TEXT NOT NULL,
      expansion_name TEXT NOT NULL,
      number INTEGER NOT NULL,
      rarity TEXT NOT NULL,
      pack TEXT,
      type TEXT,
      health INTEGER,
      is_ex INTEGER NOT NULL DEFAULT 0,
      is_fullart INTEGER NOT NULL DEFAULT 0,
      artist TEXT,
      image TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cards_name ON cards(name);
    CREATE INDEX IF NOT EXISTS idx_cards_exp ON cards(expansion_id);
    CREATE INDEX IF NOT EXISTS idx_cards_pack ON cards(pack);
    CREATE TABLE IF NOT EXISTS owned (
      card_id TEXT PRIMARY KEY REFERENCES cards(id),
      quantity INTEGER NOT NULL CHECK (quantity >= 0),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS expansions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      packs TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS capture_rounds (
      id TEXT PRIMARY KEY,
      expansion_id TEXT NOT NULL REFERENCES expansions(id),
      label TEXT,
      status TEXT NOT NULL CHECK (status IN ('open', 'review', 'applied', 'cancelled')),
      quantity_mode TEXT NOT NULL CHECK (quantity_mode IN ('minimum', 'exact')),
      expected_total INTEGER NOT NULL CHECK (expected_total > 0),
      expected_owned_unique INTEGER CHECK (expected_owned_unique >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finalized_at TEXT,
      summary TEXT
    );
    CREATE TABLE IF NOT EXISTS capture_round_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id TEXT NOT NULL REFERENCES capture_rounds(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      capture_order INTEGER NOT NULL,
      analysis TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(round_id, sha256)
    );
    CREATE INDEX IF NOT EXISTS idx_capture_round_images_round ON capture_round_images(round_id, capture_order);
    CREATE TABLE IF NOT EXISTS capture_round_cards (
      round_id TEXT NOT NULL REFERENCES capture_rounds(id) ON DELETE CASCADE,
      card_number INTEGER NOT NULL CHECK (card_number > 0),
      state TEXT NOT NULL CHECK (state IN ('owned', 'missing')),
      quantity INTEGER CHECK (quantity >= 0),
      confidence REAL NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
      confirmed INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
      source TEXT,
      previous_quantity INTEGER,
      applied_quantity INTEGER,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(round_id, card_number)
    );
    CREATE INDEX IF NOT EXISTS idx_capture_round_cards_round ON capture_round_cards(round_id, state);
  `;

const BATTLE_COLUMNS: [string, string][] = [
  ["category", "TEXT"],
  ["stage", "TEXT"],
  ["evolve_from", "TEXT"],
  ["suffix", "TEXT"],
  ["retreat", "INTEGER"],
  ["effect", "TEXT"],
  ["attacks", "TEXT"],
  ["abilities", "TEXT"],
  ["weaknesses", "TEXT"],
  ["max_damage", "INTEGER"],
  ["enriched_at", "TEXT"],
];

function addBattleColumns(d: Database.Database): void {
  const existing = new Set(
    (d.prepare("PRAGMA table_info(cards)").all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  for (const [col, type] of BATTLE_COLUMNS) {
    if (!existing.has(col))
      d.exec(`ALTER TABLE cards ADD COLUMN ${col} ${type}`);
  }
}

interface Migration {
  version: number;
  name: string;
  apply: (database: Database.Database) => void;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    apply: (database) => database.exec(INITIAL_SCHEMA),
  },
  { version: 2, name: "battle_columns", apply: addBattleColumns },
];

function tableExists(database: Database.Database, name: string): boolean {
  return (
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(name) !== undefined
  );
}

/**
 * Writes a consistent snapshot of the live database before a migration mutates
 * it. Uses `VACUUM INTO` (not a raw file copy) so WAL-resident, not-yet
 * checkpointed pages are included and the result is a single, self-consistent
 * file. A failure here aborts the migration on purpose: we never migrate
 * without a recoverable copy.
 */
export function backupBeforeMigration(
  database: Database.Database,
  backupDir: string,
): string {
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = join(backupDir, `collection-pre-migration-${stamp}.db`);
  try {
    database.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`);
  } catch (error) {
    throw new Error(
      `No se pudo crear la copia de seguridad previa a la migración en ${destination}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return destination;
}

/**
 * Applies forward-only, idempotent schema migrations and records each version.
 * When `options.backupDir` is set and pending migrations must run against a
 * database that already holds data, a consistent backup is written first.
 */
export function runMigrations(
  database: Database.Database,
  options: { backupDir?: string } = {},
): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = new Set(
    (
      database.prepare("SELECT version FROM schema_migrations").all() as {
        version: number;
      }[]
    ).map((row) => row.version),
  );
  const pending = MIGRATIONS.filter(
    (migration) => !applied.has(migration.version),
  );

  // Skip the backup on a brand-new database (no `cards` table yet): the initial
  // migration only creates schema, so there is nothing to recover.
  if (pending.length && options.backupDir && tableExists(database, "cards")) {
    backupBeforeMigration(database, options.backupDir);
  }

  const record = database.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );
  for (const migration of pending) {
    database.transaction(() => {
      migration.apply(database);
      record.run(migration.version, migration.name, new Date().toISOString());
    })();
  }
}

export interface CardRow {
  id: string;
  name: string;
  expansion_id: string;
  expansion_name: string;
  number: number;
  rarity: string;
  pack: string | null;
  type: string | null;
  health: number | null;
  is_ex: number;
  is_fullart: number;
  artist: string | null;
  image: string | null;
  category: string | null;
  stage: string | null;
  evolve_from: string | null;
  suffix: string | null;
  retreat: number | null;
  effect: string | null;
  attacks: string | null;
  abilities: string | null;
  weaknesses: string | null;
  max_damage: number | null;
  enriched_at: string | null;
  quantity?: number;
}

function parseJson(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function cardWithQty(
  row: CardRow,
  full = false,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: row.id,
    name: row.name,
    expansion: `${row.expansion_id} (${row.expansion_name})`,
    number: row.number,
    rarity: row.rarity,
    pack: row.pack,
    type: row.type,
    health: row.health,
    ex: !!row.is_ex,
    owned: row.quantity ?? 0,
  };
  if (full) {
    Object.assign(base, {
      fullart: !!row.is_fullart,
      artist: row.artist,
      category: row.category,
      stage: row.stage,
      evolve_from: row.evolve_from,
      suffix: row.suffix,
      retreat: row.retreat,
      effect: row.effect,
      attacks: parseJson(row.attacks),
      abilities: parseJson(row.abilities),
      weaknesses: parseJson(row.weaknesses),
      battle_data: row.enriched_at !== null,
    });
  } else {
    Object.assign(base, {
      max_damage: row.max_damage,
      has_ability: row.abilities !== null && row.abilities !== "null",
    });
  }
  return base;
}

export function catalogIsEmpty(): boolean {
  const n = getDb().prepare("SELECT COUNT(*) AS n FROM cards").get() as {
    n: number;
  };
  return n.n === 0;
}

export const EMPTY_CATALOG_MSG =
  "El catálogo está vacío. Ejecuta el tool ptcgp_sync_catalog (o `npm run sync`) para descargarlo.";
