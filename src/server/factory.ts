import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../db.js";
import { registerCatalogTools } from "../tools/catalog.js";
import { registerCollectionTools } from "../tools/collection.js";
import { registerDeckTools } from "../tools/decks.js";
import { registerRoundTools } from "../tools/rounds.js";

export type RegistrarOptions = {
  include?: ReadonlySet<string>;
};

export const SERVER_NAME = "ptcgp-mcp-server";
export const SERVER_VERSION = "1.1.0";

export const REMOTE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "ptcgp_search_cards",
  "ptcgp_get_card",
  "ptcgp_list_expansions",
  "ptcgp_collection_stats",
  "ptcgp_missing_cards",
  "ptcgp_meta_decks",
  "ptcgp_get_decklist",
]);

export function isToolEnabled(
  name: string,
  options?: RegistrarOptions,
): boolean {
  return !options?.include || options.include.has(name);
}

export function createMcpServer(options?: RegistrarOptions): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  getDb();
  registerCatalogTools(server, options);
  registerCollectionTools(server, options);
  registerDeckTools(server, options);
  registerRoundTools(server, options);
  return server;
}
