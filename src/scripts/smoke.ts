import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main(): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "ptcgp-mcp-smoke-"));
  const client = new Client(
    { name: "ptcgp-smoke", version: "1.0.0" },
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
    const tools = (await client.listTools()).tools
      .map((tool) => tool.name)
      .sort();
    const database = new Database(join(dataDir, "collection.db"), {
      readonly: true,
    });
    const quickCheck = database.prepare("PRAGMA quick_check").get() as {
      quick_check: string;
    };
    database.close();
    console.log(
      JSON.stringify(
        {
          ok: quickCheck.quick_check === "ok",
          quick_check: quickCheck.quick_check,
          tools,
        },
        null,
        2,
      ),
    );
  } finally {
    await transport.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exit(1);
});
