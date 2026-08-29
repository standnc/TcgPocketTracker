import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

type ServerHandle = {
  port: number;
  token: string;
  dataDir: string;
  close: () => Promise<void>;
};

type WithOptions = { extraEnv?: Record<string, string> };

async function withHttpServer(
  options: WithOptions,
  run: (handle: ServerHandle) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "ptcgp-http-test-"));
  const token = randomBytes(32).toString("hex");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    PTCGP_DATA_DIR: dataDir,
    PTCGP_HTTP_HOST: "127.0.0.1",
    PTCGP_HTTP_PORT: "0",
    PTCGP_HTTP_TOKEN: token,
    PTCGP_LOG_LEVEL: "info",
    ...(options.extraEnv ?? {}),
  };

  const child = spawn(process.execPath, [resolve("dist/http.js")], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.resume();

  const port = await new Promise<number>((resolvePromise, rejectPromise) => {
    let done = false;
    let buffer = "";
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      rejectPromise(new Error("HTTP server no anunció puerto a tiempo"));
    }, 10000);
    const onData = (chunk: Buffer): void => {
      if (done) return;
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index >= 0 && !done) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          const parsed = JSON.parse(line) as { msg?: string; port?: number };
          if (parsed.msg === "HTTP server ready" && parsed.port) {
            done = true;
            clearTimeout(timer);
            resolvePromise(parsed.port);
            return;
          }
        } catch {
          /* ignorar líneas no-JSON */
        }
        index = buffer.indexOf("\n");
      }
    };
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      rejectPromise(
        new Error(`HTTP server terminó antes del ready (code=${code})`),
      );
    });
  });
  // Consumimos stderr en modo drenaje para que el buffer del pipe no se llene
  // durante la ejecución del test (los logs de request siguen siendo emitidos).
  child.stderr?.resume();

  const handle: ServerHandle = {
    port,
    token,
    dataDir,
    async close(): Promise<void> {
      child.kill("SIGTERM");
      await new Promise<void>((resolvePromise) => {
        child.once("exit", () => resolvePromise());
      });
    },
  };

  try {
    // Ahora que las migraciones han corrido, inyectamos el fixture mínimo.
    const db = new Database(join(dataDir, "collection.db"));
    db.prepare(
      "INSERT OR IGNORE INTO expansions (id, name, packs) VALUES ('t1', 'Test set', '[]')",
    ).run();
    const insert = db.prepare(`
      INSERT OR IGNORE INTO cards (id, name, expansion_id, expansion_name, number, rarity)
      VALUES (?, ?, 't1', 'Test set', ?, '◊')
    `);
    for (let number = 1; number <= 3; number++) {
      insert.run(
        `t1-${String(number).padStart(3, "0")}`,
        `Card ${number}`,
        number,
      );
    }
    db.close();
    await run(handle);
  } finally {
    await handle.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

type RawResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

function rawRequest(
  handle: ServerHandle,
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<RawResponse> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: handle.port,
        path,
        method: init.method ?? "GET",
        headers: init.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          settle(() =>
            resolvePromise({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          ),
        );
        res.on("close", () =>
          settle(() =>
            resolvePromise({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          ),
        );
      },
    );
    // El server puede cerrar el socket tras un 413/401 antes de que curl termine
    // de escribir el body. Si ya recibimos statusCode, no tratamos el reset como
    // fallo del test.
    req.on("error", (err) => settle(() => rejectPromise(err)));
    if (init.body) req.write(init.body);
    req.end();
  });
}

test("HTTP anuncia exactamente las 7 tools remotas de solo lectura", async () => {
  await withHttpServer({}, async (handle) => {
    const client = new Client(
      { name: "ptcgp-http-tests", version: "1.0.0" },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle.port}/mcp`),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${handle.token}` },
        },
      },
    );
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      assert.deepEqual(names, [
        "ptcgp_collection_stats",
        "ptcgp_get_card",
        "ptcgp_get_decklist",
        "ptcgp_list_expansions",
        "ptcgp_meta_decks",
        "ptcgp_missing_cards",
        "ptcgp_search_cards",
      ]);
    } finally {
      await transport.close();
    }
  });
});

test("HTTP rechaza peticiones sin cabecera, con esquema distinto o token inválido", async () => {
  await withHttpServer({}, async (handle) => {
    const noHeader = await rawRequest(handle, "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(noHeader.status, 401);
    assert.equal(noHeader.headers["www-authenticate"], "Bearer");

    const wrongScheme = await rawRequest(handle, "/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: "Basic dXNlcjpwYXNz",
      },
      body: "{}",
    });
    assert.equal(wrongScheme.status, 401);

    const badToken = await rawRequest(handle, "/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: "Bearer tokenincorrecto",
      },
      body: "{}",
    });
    assert.equal(badToken.status, 401);
  });
});

test("HTTP limita intentos por IP antes de autenticar", async () => {
  await withHttpServer(
    {
      extraEnv: {
        PTCGP_HTTP_RATE_LIMIT_MAX: "2",
        PTCGP_HTTP_RATE_LIMIT_WINDOW_MS: "60000",
      },
    },
    async (handle) => {
      const request = () =>
        rawRequest(handle, "/mcp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
      assert.equal((await request()).status, 401);
      assert.equal((await request()).status, 401);
      const limited = await request();
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers["retry-after"]) >= 1);
    },
  );
});

test("HTTP rechaza Host y Origin no permitidos", async () => {
  await withHttpServer({}, async (handle) => {
    const badHost = await rawRequest(handle, "/mcp", {
      method: "POST",
      headers: {
        Host: "evil.example",
        Authorization: `Bearer ${handle.token}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(badHost.status, 403);

    const badOrigin = await rawRequest(handle, "/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.token}`,
        Origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(badOrigin.status, 403);
  });
});

test("HTTP devuelve 413 cuando el cuerpo supera el límite configurado", async () => {
  await withHttpServer(
    { extraEnv: { PTCGP_HTTP_BODY_LIMIT_KIB: "1" } },
    async (handle) => {
      const big = "a".repeat(3 * 1024);
      const response = await rawRequest(handle, "/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${handle.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ padding: big }),
      });
      assert.equal(response.status, 413);
    },
  );
});

test("HTTP devuelve 405 en /mcp para métodos no soportados con Allow y JSON-RPC", async () => {
  await withHttpServer({}, async (handle) => {
    const response = await rawRequest(handle, "/mcp", { method: "PUT" });
    assert.equal(response.status, 405);
    assert.equal(response.headers.allow, "GET, POST");
    const parsed = JSON.parse(response.body) as {
      jsonrpc: string;
      error: { code: number; message: string };
      id: null;
    };
    assert.equal(parsed.jsonrpc, "2.0");
    assert.equal(parsed.id, null);
    assert.equal(typeof parsed.error.code, "number");
  });
});

test("/healthz responde 200 con 'ok' plano y no filtra rutas ni versión", async () => {
  await withHttpServer({}, async (handle) => {
    const response = await rawRequest(handle, "/healthz");
    assert.equal(response.status, 200);
    assert.equal(response.body, "ok\n");
    assert.match(
      String(response.headers["content-type"] ?? ""),
      /^text\/plain/,
    );
    assert.doesNotMatch(response.body, /1\.1\.0|PTCGP_|dist\/|\/var\//);
  });
});

test("HTTP ejecuta ptcgp_collection_stats con token válido sobre la base temporal", async () => {
  await withHttpServer({}, async (handle) => {
    const client = new Client(
      { name: "ptcgp-http-tests", version: "1.0.0" },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle.port}/mcp`),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${handle.token}` },
        },
      },
    );
    try {
      await client.connect(transport);
      const result = (await client.callTool({
        name: "ptcgp_collection_stats",
        arguments: {},
      })) as {
        content: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      assert.equal(result.isError, undefined);
      const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
        catalog_total: number;
        owned_unique: number;
      };
      assert.equal(payload.catalog_total, 3);
      assert.equal(payload.owned_unique, 0);
    } finally {
      await transport.close();
    }
  });
});
