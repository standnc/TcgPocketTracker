#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { logger } from "./logger.js";
import { createMcpServer, SERVER_VERSION } from "./server/factory.js";

const server = createMcpServer();

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info(
    { transport: "stdio", version: SERVER_VERSION },
    "MCP server ready",
  );
}

main().catch((error) => {
  logger.fatal({ err: error }, "MCP server failed to start");
  process.exit(1);
});
