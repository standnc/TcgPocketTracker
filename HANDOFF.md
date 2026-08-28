# Handoff for the next agent

Last updated: 2026-08-28. This file is the operational starting point for a future maintainer or agent. It records verified facts, current decisions, and the safe order for further work. Do not treat roadmap items as already implemented.

## Repository and safety status

- Working repository: `/home/pedro/proyectos/ptcgp-mcp-server` in Kali WSL.
- Current branch: `main`.
- Preparation commits:
  - `587166a chore: establish safe open source baseline`
  - `499fd2a docs: add web tracker implementation plan`
  - `8435178 chore: modernize MCP runtime baseline`
- There is no Git remote configured. Nothing has been pushed, published to npm, registered in MCP registries, or deployed.
- `package.json` has `"private": true`; retain it until the owner explicitly authorizes publication.
- Production SQLite databases, WAL/SHM files, backups, captures, cookies, tokens, `.env` files, logs, and temporary outputs must remain outside Git. `.gitignore` protects these paths, but an ignored file is still private and must not be copied into fixtures or documentation.
- Tests and smoke checks must use a temporary `PTCGP_DATA_DIR`. Do not run a migration, sync, OCR round, or recovery test against the owner’s live directory without explicit approval and a verified SQLite-aware backup.

## What works today

The executable is a provider-neutral MCP server over stdio. It uses the official TypeScript MCP SDK and does not import a model-provider SDK. It exposes exactly these 17 tools:

- Catalog: `ptcgp_search_cards`, `ptcgp_get_card`, `ptcgp_list_expansions`, `ptcgp_sync_catalog`, `ptcgp_enrich_catalog`.
- Collection: `ptcgp_collection_stats`, `ptcgp_missing_cards`, `ptcgp_set_card_quantity`, `ptcgp_bulk_update_collection`, `ptcgp_mark_range`.
- Decks: `ptcgp_meta_decks`, `ptcgp_get_decklist`.
- Capture rounds: `ptcgp_round_start`, `ptcgp_round_analyze_screenshots`, `ptcgp_round_record`, `ptcgp_round_status`, `ptcgp_round_finalize`.

Verified implementation properties:

- SQLite bootstraps a local database, enables WAL, foreign keys, a busy timeout, and versioned forward-only migrations.
- Collection bulk/range changes and round finalization are transactional.
- Round finalization requires `confirm=true` and blocks a mismatch between the expected count and reviewed/detected results.
- PNG, JPEG, and WebP normalization is tested with a generated fixture. OCR uses local Sharp and Tesseract; it does not upload captures.
- Pino writes structured logs to stderr. MCP protocol traffic must remain on stdout.
- `PTCGP_DATA_DIR` and `PTCGP_LOG_LEVEL` are validated through Zod.

## What is not a public guarantee

- OCR accuracy, screenshot coverage, and automatic capture completion are not proven by the public test corpus. Human review before a round is finalized is mandatory.
- HEIC/HEIF is allow-listed in code but not proven across native Sharp/libvips builds.
- Network-based catalog, enrichment, Limitless/meta-deck and decklist features are implementation-present but lack hermetic fixtures, contract tests, source licensing review, and rate-limit policy.
- There is no backup/restore MCP tool, automatic backup before migration, downgrade path, CLI, Streamable HTTP transport, authentication layer, metrics, correlation IDs, or logging redaction policy.
- SQLite is the correct local single-user store today. It is not the chosen store for the future multi-user tracker; see `WEB_TRACKER_PLAN.md`.

## Technology baseline and commands

| Area              | Current choice                                       | Rule for changes                                                       |
| ----------------- | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| Runtime           | Node 24 preferred (`.nvmrc`), Node 22 also supported | Run `npm ci` after changing runtime: `better-sqlite3` is native.       |
| Language          | strict TypeScript 5.9                                | Preserve strictness.                                                   |
| MCP               | `@modelcontextprotocol/sdk` 1.30                     | Keep stdio stable; do not add client/provider coupling.                |
| Schemas/config    | Zod 4                                                | Reuse for CLI/config and tool inputs.                                  |
| Local persistence | `better-sqlite3` 13                                  | Keep migrations forward-only and use temporary databases in tests.     |
| Image/OCR         | Sharp + Tesseract 6                                  | Do not add engines without legal fixtures and accuracy tests.          |
| Logging           | Pino 10 to stderr                                    | Never log raw captures, tokens, full payloads, or local private paths. |
| Quality           | Node test runner, ESLint, Prettier, GitHub Actions   | Keep `npm run verify` green before committing.                         |

```bash
# In Kali WSL, from the repository
npm ci
export PTCGP_DATA_DIR="$(mktemp -d)"
npm run verify
npm audit --omit=dev
```

`npm run verify` performs format, lint, build/tests, a temporary SQLite/MCP stdio smoke test, and `npm pack --dry-run`. It does not publish a package. The baseline was verified with clean installs on Node 22.23.2 and Node 24.15.0, six passing tests, `PRAGMA quick_check = ok`, and zero production dependency audit findings.

## Code map

```text
src/index.ts                 MCP server setup and stdio transport
src/config.ts                validated environment configuration
src/logger.ts                Pino stderr logger
src/db.ts                    SQLite pragmas and migration runner
src/tools/catalog.ts         catalog and remote-source MCP tools
src/tools/collection.ts      collection MCP tools
src/tools/rounds.ts          capture-round MCP tools
src/tools/decks.ts           deck MCP tools
src/screenshot-analyzer.ts   local normalization and OCR helper
src/sync.ts                  catalog sync/enrichment support
src/limitless.ts             deck/meta source support
src/tests/*                  MCP, SQLite migration/round, image tests
src/scripts/smoke.ts         isolated stdio tool-list and SQLite smoke test
```

The desired direction is documented in `ARCHITECTURE.md`: MCP, a future CLI, and a possible future Streamable HTTP adapter should be thin adapters over application use cases. Do not perform a large rewrite. Extract one cohesive use case at a time behind a tested interface.

## Recommended next phase: generic core

The next agent should work only on roadmap phase 2, in this order:

1. Add focused tests around the existing round finalization and collection mutation rules before moving logic.
2. Extract a framework-free collection use-case module with typed inputs/results; leave existing MCP responses as an adapter layer.
3. Extract capture-round validation/finalization with the same transaction semantics and idempotency behavior.
4. Define a SQLite repository port and move direct SQL behind it incrementally.
5. Add SQLite-aware backup-before-migrate and recovery tests using a temporary database only.
6. Add redaction tests and a safe error taxonomy for logs.

Acceptance criteria: all 17 tools keep their names and observed behavior, the existing six tests remain green, new tests cover the extracted use cases, and no live data directory is opened or changed.

## Explicit non-goals until approved

- No npm publication, remote push, official MCP registry, Smithery, or public GitHub repository changes.
- No Streamable HTTP, web UI, complete CLI, OAuth/auth, VPS deployment, PostgreSQL migration, or new OCR engine in this repository.
- No copying real screenshots, databases, backups, browser cookies, source data, or third-party card images into Git, tests, issues, or package artifacts.

## Related tracker project

`WEB_TRACKER_PLAN.md` is a design document for a separate future web/API project. Its intended architecture is PostgreSQL + authenticated application API + private image storage + OCR worker, with this MCP eventually acting as an adapter to the same use cases/API. It does not authorize deployment, migration, or exposure of the MCP over a network.

## Documentation map

- `README.md`: verified use, installation, client configuration, tool list, and limits.
- `OPEN_SOURCE_GAP_ANALYSIS.md`: audited evidence, remaining risks, and technical choices.
- `ARCHITECTURE.md`: current structure and incremental target architecture.
- `ROADMAP.md`: ordered product/release phases.
- `WEB_TRACKER_PLAN.md`: separate future tracker design and PostgreSQL/VPS plan.
- `SECURITY.md`: basic disclosure and local data handling guidance.
- `CONTRIBUTING.md`: contributor expectations.

Before a future public release, re-run a full history/secret scan, verify third-party source rights, add release provenance/changelog policies, and require maintainer approval.
