import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { runMigrations } from "../db.js";
import {
  createSqliteRoundsRepository,
  type RoundsRepository,
} from "../repositories/rounds.js";

async function withRepo(
  run: (repo: RoundsRepository) => void | Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ptcgp-rounds-repo-"));
  const db = new Database(join(dir, "collection.db"));
  try {
    runMigrations(db);
    db.prepare(
      "INSERT INTO expansions (id, name, packs) VALUES ('t1', 'Test set', '[]')",
    ).run();
    await run(createSqliteRoundsRepository(db));
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function seedRound(repo: RoundsRepository, id: string): void {
  const now = new Date().toISOString();
  repo.create({
    id,
    expansion_id: "t1",
    label: null,
    quantity_mode: "minimum",
    expected_total: 5,
    expected_owned_unique: 3,
    created_at: now,
    updated_at: now,
  });
}

test("create/get preserva los campos de la ronda y devuelve undefined si no existe", async () => {
  await withRepo((repo) => {
    seedRound(repo, "t1-round-a");
    const round = repo.get("t1-round-a");
    assert.ok(round);
    assert.equal(round.status, "open");
    assert.equal(round.expected_total, 5);
    assert.equal(round.expected_owned_unique, 3);
    assert.equal(round.quantity_mode, "minimum");
    assert.equal(repo.get("no-existe"), undefined);
  });
});

test("confirmedOwnedNumbers excluye huecos y detecciones sin confirmar", async () => {
  await withRepo((repo) => {
    seedRound(repo, "t1-round-b");
    const now = new Date().toISOString();
    repo.upsertConfirmed({
      round_id: "t1-round-b",
      card_number: 1,
      state: "owned",
      quantity: 1,
      updated_at: now,
    });
    repo.upsertConfirmed({
      round_id: "t1-round-b",
      card_number: 2,
      state: "missing",
      quantity: 0,
      updated_at: now,
    });
    repo.upsertDetection({
      round_id: "t1-round-b",
      card_number: 3,
      confidence: 0.9,
      source: "auto",
      updated_at: now,
    });
    assert.deepEqual(
      repo
        .observations("t1-round-b")
        .map((o) => [o.card_number, o.state, o.confirmed]),
      [
        [1, "owned", 1],
        [2, "missing", 1],
        [3, "missing", 0],
      ],
    );
    assert.deepEqual([...repo.confirmedOwnedNumbers("t1-round-b")], [1]);
  });
});

test("listRecent cuenta imágenes, huecos y pendientes de la ronda", async () => {
  await withRepo((repo) => {
    seedRound(repo, "t1-round-c");
    const now = new Date().toISOString();
    repo.upsertDetection({
      round_id: "t1-round-c",
      card_number: 3,
      confidence: 0.9,
      source: "img.png",
      updated_at: now,
    });
    repo.insertImage({
      round_id: "t1-round-c",
      path: "img.png",
      sha256: "abc",
      width: 10,
      height: 20,
      capture_order: 0,
      analysis: "{}",
      created_at: now,
    });
    const recent = repo.listRecent();
    assert.equal(recent.length, 1);
    assert.equal(recent[0].id, "t1-round-c");
    assert.equal(recent[0].images, 1);
    assert.equal(recent[0].missing_detected, 1);
    assert.equal(recent[0].pending_review, 1);
  });
});
