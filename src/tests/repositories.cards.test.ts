import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { runMigrations } from "../db.js";
import {
  createSqliteCardsRepository,
  type CardsRepository,
} from "../repositories/cards.js";

async function withRepo(
  run: (repo: CardsRepository) => void | Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ptcgp-cards-repo-"));
  const db = new Database(join(dir, "collection.db"));
  try {
    runMigrations(db);
    db.prepare("INSERT INTO expansions (id, name, packs) VALUES (?, ?, ?)").run(
      "t1",
      "Test set 1",
      '["Mewtwo","Charizard"]',
    );
    db.prepare("INSERT INTO expansions (id, name, packs) VALUES (?, ?, ?)").run(
      "t2",
      "Test set 2",
      '["Pikachu"]',
    );
    const insertCard = db.prepare(
      `INSERT INTO cards (id, name, expansion_id, expansion_name, number, rarity, pack)
       VALUES (@id, @name, @expansion_id, @expansion_name, @number, @rarity, @pack)`,
    );
    const cards = [
      ["t1-001", "Alpha", "t1", "Test set 1", 1, "◊", "Mewtwo"],
      ["t1-002", "Beta", "t1", "Test set 1", 2, "◊◊", "Mewtwo"],
      ["t1-003", "Gamma", "t1", "Test set 1", 3, "☆", "Charizard"],
      ["t2-001", "Delta", "t2", "Test set 2", 1, "◊", "Pikachu"],
    ] as const;
    for (const [id, name, exp, expName, number, rarity, pack] of cards) {
      insertCard.run({
        id,
        name,
        expansion_id: exp,
        expansion_name: expName,
        number,
        rarity,
        pack,
      });
    }
    const insertOwned = db.prepare(
      "INSERT INTO owned (card_id, quantity, updated_at) VALUES (?, ?, ?)",
    );
    const now = new Date().toISOString();
    insertOwned.run("t1-001", 2, now);
    insertOwned.run("t1-003", 1, now);
    await run(createSqliteCardsRepository(db));
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("isEmpty/exists/numbersInExpansion reflejan el catálogo sembrado", async () => {
  await withRepo((repo) => {
    assert.equal(repo.isEmpty(), false);
    assert.equal(repo.exists("t1-001"), true);
    assert.equal(repo.exists("t9-999"), false);
    assert.deepEqual(repo.numbersInExpansion("t1"), [1, 2, 3]);
  });
});

test("search aplica filtros y adjunta la cantidad poseída", async () => {
  await withRepo((repo) => {
    const byName = repo.search({
      query: "Alph",
      owned_filter: "all",
      limit: 50,
      offset: 0,
    });
    assert.equal(byName.total, 1);
    assert.equal(byName.cards[0].id, "t1-001");
    assert.equal(byName.cards[0].quantity, 2);

    const owned = repo.search({ owned_filter: "owned", limit: 50, offset: 0 });
    assert.deepEqual(owned.cards.map((c) => c.id).sort(), ["t1-001", "t1-003"]);

    const inT1 = repo.search({
      expansion: "t1",
      owned_filter: "all",
      limit: 50,
      offset: 0,
    });
    assert.equal(inT1.total, 3);
  });
});

test("stats agrega global, por expansión y por rareza", async () => {
  await withRepo((repo) => {
    const { global, byExpansion } = repo.stats();
    assert.equal(global.total, 4);
    assert.equal(global.owned_unique, 2);
    assert.equal(global.total_copies, 3);
    const t1 = byExpansion.find((e) => e.id === "t1");
    assert.equal(t1?.total, 3);
    assert.equal(t1?.owned_unique, 2);
  });
});

test("missing excluye poseídas y respeta el filtro de rareza", async () => {
  await withRepo((repo) => {
    const all = repo.missing({});
    assert.deepEqual(all.rows.map((r) => r.id).sort(), ["t1-002", "t2-001"]);
    // Totales por pack (independientes de lo poseído).
    const mewtwo = all.totals.find(
      (t) => t.expansion_id === "t1" && t.pack === "Mewtwo",
    );
    assert.equal(mewtwo?.n, 2);

    const onlyDiamond = repo.missing({ rarities: ["◊"] });
    assert.deepEqual(
      onlyDiamond.rows.map((r) => r.id),
      ["t2-001"],
    );
  });
});
