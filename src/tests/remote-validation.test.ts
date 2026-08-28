import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { parseRemote } from "../remote-validation.js";
import { rawCardsSchema, rawExpansionsSchema } from "../sync.js";
import { deckCardSchema, metaDeckSchema } from "../limitless.js";

test("parseRemote devuelve los datos cuando el esquema valida", () => {
  const schema = z.array(z.object({ id: z.string() }));
  assert.deepEqual(parseRemote(schema, [{ id: "a1-001" }], "fuente"), [
    { id: "a1-001" },
  ]);
});

test("parseRemote lanza un error que nombra la fuente y la ruta", () => {
  const schema = z.array(z.object({ id: z.string() }));
  try {
    parseRemote(schema, [{ id: 5 }], "cards.json");
    assert.fail("parseRemote debería haber lanzado");
  } catch (err) {
    assert.ok(err instanceof Error);
    assert.match(err.message, /cards\.json/);
    assert.match(err.message, /0\.id/);
  }
});

test("rawCardsSchema acepta el dataset conocido y tolera opcionales ausentes", () => {
  const parsed = parseRemote(
    rawCardsSchema,
    [
      {
        id: "a1-001",
        name: "Bulbasaur",
        rarity: "◊",
        pack: "Mewtwo",
        health: "70",
        image: "x",
        fullart: "No",
        ex: "No",
        artist: "Ken",
        type: "Grass",
      },
      { id: "a1-002", name: "Ivysaur", rarity: "◊◊" },
    ],
    "cards.json",
  );
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].pack, undefined);
});

test("rawCardsSchema rechaza una respuesta que no es un array", () => {
  assert.throws(
    () => parseRemote(rawCardsSchema, { data: [] }, "cards.json"),
    /cards\.json/,
  );
});

test("rawCardsSchema rechaza una carta sin id", () => {
  assert.throws(
    () =>
      parseRemote(
        rawCardsSchema,
        [{ name: "sin id", rarity: "◊" }],
        "cards.json",
      ),
    /0\.id/,
  );
});

test("rawExpansionsSchema exige el nombre de cada sobre", () => {
  const ok = parseRemote(
    rawExpansionsSchema,
    [{ id: "a1", name: "Genetic Apex", packs: [{ name: "Mewtwo" }] }],
    "expansions.json",
  );
  assert.equal(ok[0].packs[0].name, "Mewtwo");
  assert.throws(
    () =>
      parseRemote(
        rawExpansionsSchema,
        [{ id: "a1", name: "Genetic Apex", packs: [{ image: "x" }] }],
        "expansions.json",
      ),
    /packs\.0\.name/,
  );
});

test("metaDeckSchema y deckCardSchema fijan la forma de los datos scrapeados", () => {
  const deck = parseRemote(
    metaDeckSchema,
    {
      rank: 1,
      name: "Gyarados ex",
      slug: "gyarados-ex",
      count: 42,
      share: "12.3%",
    },
    "Limitless meta-decks",
  );
  assert.equal(deck.rank, 1);
  assert.throws(
    () =>
      parseRemote(
        metaDeckSchema,
        { rank: 0, name: "x", slug: "y", count: 1, share: "1%" },
        "Limitless meta-decks",
      ),
    /rank/,
  );

  const card = parseRemote(
    deckCardSchema,
    { count: 2, name: "Cyrus", card_id: null },
    "Limitless decklist",
  );
  assert.equal(card.card_id, null);
  assert.throws(
    () =>
      parseRemote(
        deckCardSchema,
        { count: 0, name: "x", card_id: "a2-150" },
        "Limitless decklist",
      ),
    /count/,
  );
});
