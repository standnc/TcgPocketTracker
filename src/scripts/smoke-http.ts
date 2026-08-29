import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function main(): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "ptcgp-mcp-http-smoke-"));
  const token = randomBytes(32).toString("hex");
  const child = spawn(process.execPath, [resolve("dist/http.js")], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      PTCGP_DATA_DIR: dataDir,
      PTCGP_HTTP_HOST: "127.0.0.1",
      PTCGP_HTTP_PORT: "0",
      PTCGP_HTTP_TOKEN: token,
      PTCGP_LOG_LEVEL: "info",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.resume();

  const port = await new Promise<number>((resolvePromise, rejectPromise) => {
    let buffer = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      rejectPromise(new Error("HTTP server no anunció puerto a tiempo"));
    }, 10000);
    child.stderr?.on("data", (chunk: Buffer) => {
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
          /* ignorar */
        }
        index = buffer.indexOf("\n");
      }
    });
    child.once("exit", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      rejectPromise(
        new Error(`HTTP server terminó antes del ready (code=${code})`),
      );
    });
  });
  child.stderr?.resume();

  const client = new Client(
    { name: "ptcgp-http-smoke", version: "1.0.0" },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  );
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools
      .map((tool) => tool.name)
      .sort();
    console.log(
      JSON.stringify(
        {
          ok: tools.length === 7,
          port,
          tools,
        },
        null,
        2,
      ),
    );
  } finally {
    await transport.close();
    child.kill("SIGTERM");
    await new Promise<void>((r) => child.once("exit", () => r()));
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exit(1);
});
