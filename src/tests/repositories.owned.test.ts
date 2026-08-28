import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { runMigrations } from "../db.js";
import {
  createSqliteOwnedRepository,
  type OwnedRepository,
} from "../repositories/owned.js";

async function withRepo(
  run: (repo: OwnedRepository) => void | Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ptcgp-owned-repo-"));
  const db = new Database(join(dir, "collection.db"));
  try {
    runMigrations(db);
    db.prepare(
      "INSERT INTO expansions (id, name, packs) VALUES ('t1', 'Test set', '[]')",
    ).run();
    const insert = db.prepare(
      `INSERT INTO cards (id, name, expansion_id, expansion_name, number, rarity)
       VALUES (?, ?, 't1', 'Test set', ?, '◊')`,
    );
    for (let number = 1; number <= 3; number++) {
      insert.run(
        `t1-${String(number).padStart(3, "0")}`,
        `Card ${number}`,
        number,
      );
    }
    await run(createSqliteOwnedRepository(db));
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("getQuantity es 0 sin fila y el upsert actualiza en vez de duplicar", async () => {
  await withRepo((repo) => {
    assert.equal(repo.getQuantity("t1-001"), 0);
    repo.setQuantity("t1-001", 3, new Date().toISOString());
    assert.equal(repo.getQuantity("t1-001"), 3);
    repo.setQuantity("t1-001", 1, new Date().toISOString());
    assert.equal(repo.getQuantity("t1-001"), 1);
  });
});

test("quantitiesByExpansion incluye toda la expansión con 0 por defecto", async () => {
  await withRepo((repo) => {
    repo.setQuantity("t1-002", 5, new Date().toISOString());
    const map = repo.quantitiesByExpansion("t1");
    assert.deepEqual(
      [...map.entries()].sort((a, b) => a[0] - b[0]),
      [
        [1, 0],
        [2, 5],
        [3, 0],
      ],
    );
  });
});
