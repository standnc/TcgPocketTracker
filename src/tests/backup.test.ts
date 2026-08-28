import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { runMigrations } from "../db.js";

function columnNames(database: Database.Database, table: string): string[] {
  return (
    database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((column) => column.name);
}

test("runMigrations respalda antes de migrar y el respaldo recupera el estado previo", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ptcgp-backup-test-"));
  const backupDir = join(dataDir, "backups");
  try {
    const database = new Database(join(dataDir, "collection.db"));
    database.pragma("journal_mode = WAL");
    // Base ya migrada a v1 (sin las columnas de combate de v2) y con datos.
    database.exec(`
      CREATE TABLE cards (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, expansion_id TEXT NOT NULL,
        expansion_name TEXT NOT NULL, number INTEGER NOT NULL, rarity TEXT NOT NULL,
        pack TEXT, type TEXT, health INTEGER, is_ex INTEGER NOT NULL DEFAULT 0,
        is_fullart INTEGER NOT NULL DEFAULT 0, artist TEXT, image TEXT
      );
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations (version, name, applied_at)
        VALUES (1, 'initial_schema', '2026-01-01T00:00:00.000Z');
    `);
    database
      .prepare(
        `INSERT INTO cards (id, name, expansion_id, expansion_name, number, rarity)
         VALUES ('a1-001', 'Bulbasaur', 'a1', 'Genetic Apex', 1, '◊')`,
      )
      .run();
    assert.ok(!columnNames(database, "cards").includes("attacks"));

    runMigrations(database, { backupDir });

    // La migración v2 se aplicó sobre la base viva.
    assert.ok(columnNames(database, "cards").includes("attacks"));
    assert.deepEqual(
      database
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all(),
      [{ version: 1 }, { version: 2 }],
    );
    database.close();

    // Se creó exactamente un respaldo con el prefijo esperado.
    const backups = (await readdir(backupDir)).filter(
      (name) =>
        name.startsWith("collection-pre-migration-") && name.endsWith(".db"),
    );
    assert.equal(backups.length, 1);

    // El respaldo es consistente y conserva el estado PREVIO a la migración.
    const backup = new Database(join(backupDir, backups[0]), {
      readonly: true,
    });
    assert.equal(
      (backup.prepare("PRAGMA quick_check").get() as { quick_check: string })
        .quick_check,
      "ok",
    );
    assert.ok(!columnNames(backup, "cards").includes("attacks"));
    assert.deepEqual(backup.prepare("SELECT id, name FROM cards").get(), {
      id: "a1-001",
      name: "Bulbasaur",
    });
    assert.deepEqual(
      backup
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all(),
      [{ version: 1 }],
    );
    backup.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("runMigrations no respalda una base nueva sin datos", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ptcgp-backup-fresh-"));
  const backupDir = join(dataDir, "backups");
  try {
    const database = new Database(join(dataDir, "collection.db"));
    runMigrations(database, { backupDir });
    // v1 + v2 aplicadas desde cero, sin respaldo: no había datos que recuperar.
    assert.deepEqual(
      database
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all(),
      [{ version: 1 }, { version: 2 }],
    );
    database.close();
    // El directorio de respaldos ni siquiera llegó a crearse.
    await assert.rejects(readdir(backupDir));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
