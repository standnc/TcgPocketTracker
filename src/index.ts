#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getDb } from "./db.js";
import { logger } from "./logger.js";
import { registerCatalogTools } from "./tools/catalog.js";
import { registerCollectionTools } from "./tools/collection.js";
import { registerDeckTools } from "./tools/decks.js";
import { registerRoundTools } from "./tools/rounds.js";

const server = new McpServer({
  name: "ptcgp-mcp-server",
  version: "1.1.0",
});

getDb();
registerCatalogTools(server);
registerCollectionTools(server);
registerDeckTools(server);
registerRoundTools(server);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info({ transport: "stdio", version: "1.1.0" }, "MCP server ready");
}

main().catch((error) => {
  logger.fatal({ err: error }, "MCP server failed to start");
  process.exit(1);
});
