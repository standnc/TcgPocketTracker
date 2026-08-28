# ptcgp-mcp-server

Local MCP server for a Pokémon TCG Pocket card catalog and a personal SQLite collection. It uses the MCP standard and the stdio transport; it has no dependency on Claude, Anthropic, OpenAI, or any specific AI model. Any MCP-compatible client can launch the process.

This is a preparation-stage project, not a published package. Keep personal databases and screenshots outside any future public repository.

## Verified capabilities

- Starts as an MCP server over stdio and exposes 17 tools.
- Creates a local SQLite database in `PTCGP_DATA_DIR` (or a per-user data directory) with WAL, foreign keys, and basic integrity checking.
- Searches catalog data; reports collection statistics, missing cards, card details, expansions, and quantities.
- Updates collection quantities individually, in a bulk transaction, or by card-number range.
- Records capture rounds, validates a header count against detected/confirmed gaps, and applies a valid round in a transaction.
- Normalizes local PNG, JPEG, and WebP images before local Tesseract OCR. HEIC/HEIF are allow-listed in code but are not yet guaranteed across native Sharp/libvips builds.
- Contains tools for catalog synchronization/enrichment and meta-deck/decklist lookup. These use third-party network sources and remain partially tested; see [OPEN_SOURCE_GAP_ANALYSIS.md](OPEN_SOURCE_GAP_ANALYSIS.md).

## Development setup

Node 24 is the preferred development runtime (`.nvmrc`); Node 22 remains supported and covered by CI for compatibility. A clean install and full suite have been verified on Node 22 and Node 24. Run `npm ci` after changing Node versions because `better-sqlite3` is a native dependency and must be installed for that runtime.

```bash
npm ci
export PTCGP_DATA_DIR="$(mktemp -d)"
npm test
npm run smoke
```

`npm test` builds TypeScript and runs the current SQLite/MCP and synthetic-image tests. `npm run smoke` starts the compiled stdio server in a fresh temporary data directory, lists its tools, and runs `PRAGMA quick_check` on that temporary database. `npm run verify` additionally checks formatting, linting and the package contents without publishing anything.

To build only:

```bash
npm run build
```

## MCP client configuration

Build first, choose a private data directory, then configure any MCP-compatible client to run:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/ptcgp-mcp-server/dist/index.js"],
  "env": {
    "PTCGP_DATA_DIR": "/absolute/path/outside-the-repository/ptcgp-mcp-data"
  }
}
```

The server uses stdout for MCP messages. Do not add normal logging to stdout.

Set `PTCGP_LOG_LEVEL` to `fatal`, `error`, `warn`, `info` (default), `debug`, `trace`, or `silent` when diagnostics are needed. Logs are structured JSON written to stderr; do not put captures, credentials, tokens or full tool payloads into logs.

## MCP tools

| Group          | Tools                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Catalog        | `ptcgp_search_cards`, `ptcgp_get_card`, `ptcgp_list_expansions`, `ptcgp_sync_catalog`, `ptcgp_enrich_catalog`                  |
| Collection     | `ptcgp_collection_stats`, `ptcgp_missing_cards`, `ptcgp_set_card_quantity`, `ptcgp_bulk_update_collection`, `ptcgp_mark_range` |
| Decks          | `ptcgp_meta_decks`, `ptcgp_get_decklist`                                                                                       |
| Capture rounds | `ptcgp_round_start`, `ptcgp_round_analyze_screenshots`, `ptcgp_round_record`, `ptcgp_round_status`, `ptcgp_round_finalize`     |

For capture rounds, the safe workflow is start -> analyze -> human review/record -> status -> finalize with `confirm=true`. The count check protects against many incomplete reads, but does not yet prove full screenshot coverage; review is mandatory.

## Data and privacy

- `PTCGP_DATA_DIR` is optional and must not be empty. A relative value is resolved from the process working directory; an absolute directory is clearer for client configuration.
- Do not commit `collection.db`, `-wal`, `-shm`, backups, screenshots, `.env` files, logs, or tool-output captures. The included `.gitignore` protects a future repository only.
- Back up a WAL-backed SQLite database with SQLite-aware tooling while the server is stopped. Copying only the main `.db` file while it is active can be inconsistent.
- The project does not require an API key. It is MIT-licensed but marked `private` in `package.json` to prevent accidental npm publication during this preparation stage. See [SECURITY.md](SECURITY.md) for reporting and local-safety guidance.

## Current limits and next work

There is no public npm package, complete CLI, Streamable HTTP transport, automated backup/restore feature, structured logging, or release process yet. SQLite now records forward-only schema migrations, but it does not yet create an automatic backup before a migration or support downgrade recovery.

Read [ARCHITECTURE.md](ARCHITECTURE.md), [ROADMAP.md](ROADMAP.md), [OPEN_SOURCE_GAP_ANALYSIS.md](OPEN_SOURCE_GAP_ANALYSIS.md), and the future [web tracker plan](WEB_TRACKER_PLAN.md) before extending the project.
