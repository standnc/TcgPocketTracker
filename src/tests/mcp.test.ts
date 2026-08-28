import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveDataDir, resolveLogLevel } from "../config.js";
import { runMigrations } from "../db.js";

function parseToolText(result: unknown): Record<string, unknown> {
  const typed = result as {
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  assert.equal(typed.isError, undefined);
  assert.equal(typed.content[0]?.type, "text");
  return JSON.parse(typed.content[0]?.text ?? "{}") as Record<string, unknown>;
}

async function withServer(
  run: (client: Client, dataDir: string) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "ptcgp-mcp-test-"));
  const client = new Client(
    { name: "ptcgp-tests", version: "1.0.0" },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/index.js")],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "", PTCGP_DATA_DIR: dataDir },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const db = new Database(join(dataDir, "collection.db"));
    assert.deepEqual(
      db
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all(),
      [{ version: 1 }, { version: 2 }],
    );
    db.prepare(
      "INSERT INTO expansions (id, name, packs) VALUES ('t1', 'Test set', '[]')",
    ).run();
    const insert = db.prepare(`
      INSERT INTO cards (id, name, expansion_id, expansion_name, number, rarity)
      VALUES (?, ?, 't1', 'Test set', ?, '◊')
    `);
    for (let number = 1; number <= 5; number++) {
      insert.run(
        `t1-${String(number).padStart(3, "0")}`,
        `Card ${number}`,
        number,
      );
    }
    db.close();
    await run(client, dataDir);
  } finally {
    await transport.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("mode=add admite deltas negativos y los tools mutables no prometen idempotencia", async () => {
  await withServer(async (client) => {
    const tools = await client.listTools();
    for (const name of [
      "ptcgp_set_card_quantity",
      "ptcgp_bulk_update_collection",
      "ptcgp_mark_range",
      "ptcgp_round_finalize",
    ]) {
      const tool = tools.tools.find((item) => item.name === name);
      assert.ok(tool, `Falta ${name}`);
      assert.equal(tool.annotations?.idempotentHint, false);
      assert.equal(tool.annotations?.destructiveHint, true);
    }
    await client.callTool({
      name: "ptcgp_set_card_quantity",
      arguments: { card_id: "t1-001", quantity: 3, mode: "set" },
    });
    const result = parseToolText(
      await client.callTool({
        name: "ptcgp_set_card_quantity",
        arguments: { card_id: "t1-001", quantity: -2, mode: "add" },
      }),
    );
    assert.equal(result.quantity, 1);
  });
});

test("la configuración rechaza un directorio de datos vacío y normaliza rutas", () => {
  assert.throws(
    () => resolveDataDir({ PTCGP_DATA_DIR: "   " }),
    /PTCGP_DATA_DIR no puede estar vacío/,
  );
  assert.equal(
    resolveDataDir({ PTCGP_DATA_DIR: "temporary-data" }),
    resolve("temporary-data"),
  );
  assert.equal(resolveLogLevel({}), "info");
  assert.throws(
    () => resolveLogLevel({ PTCGP_LOG_LEVEL: "verbose" }),
    /Configuración inválida/,
  );
});

test("las migraciones actualizan una base anterior y registran las versiones", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ptcgp-migrations-test-"));
  try {
    const database = new Database(join(dataDir, "collection.db"));
    database.exec(`
      CREATE TABLE cards (
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
    `);
    runMigrations(database);
    const columns = database.prepare("PRAGMA table_info(cards)").all() as {
      name: string;
    }[];
    assert.ok(columns.some((column) => column.name === "attacks"));
    assert.deepEqual(
      database
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all(),
      [{ version: 1 }, { version: 2 }],
    );
    database.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("una ronda completa valida el recuento y se aplica de forma transaccional", async () => {
  await withServer(async (client, dataDir) => {
    const started = parseToolText(
      await client.callTool({
        name: "ptcgp_round_start",
        arguments: {
          expansion: "t1",
          expected_owned_unique: 3,
          quantity_mode: "minimum",
        },
      }),
    );
    const roundId = String(started.round_id);
    await client.callTool({
      name: "ptcgp_round_record",
      arguments: { round_id: roundId, missing_numbers: "2,5" },
    });
    const status = parseToolText(
      await client.callTool({
        name: "ptcgp_round_status",
        arguments: { round_id: roundId },
      }),
    );
    assert.equal(
      (status.validation as { counts_match: boolean }).counts_match,
      true,
    );
    const finalized = parseToolText(
      await client.callTool({
        name: "ptcgp_round_finalize",
        arguments: { round_id: roundId, confirm: true },
      }),
    );
    assert.equal(finalized.applied, true);
    assert.equal(finalized.owned_unique, 3);
    assert.equal(finalized.missing, 2);

    const db = new Database(join(dataDir, "collection.db"), { readonly: true });
    const quantities = db
      .prepare(
        `
      SELECT c.number, COALESCE(o.quantity,0) AS quantity FROM cards c
      LEFT JOIN owned o ON o.card_id=c.id WHERE c.expansion_id='t1' ORDER BY c.number
    `,
      )
      .all() as { number: number; quantity: number }[];
    db.close();
    assert.deepEqual(
      quantities.map((item) => item.quantity),
      [1, 0, 1, 1, 0],
    );
  });
});

test("una ronda que no cuadra queda bloqueada sin tocar la colección", async () => {
  await withServer(async (client, dataDir) => {
    const started = parseToolText(
      await client.callTool({
        name: "ptcgp_round_start",
        arguments: { expansion: "t1", expected_owned_unique: 2 },
      }),
    );
    const result = (await client.callTool({
      name: "ptcgp_round_finalize",
      arguments: { round_id: String(started.round_id), confirm: true },
    })) as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
    };
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /no cuadra/i);
    const db = new Database(join(dataDir, "collection.db"), { readonly: true });
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM owned").get() as { n: number }).n,
      0,
    );
    db.close();
  });
});
