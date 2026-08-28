# Open-source preparation gap analysis

Audit scope: source tree at the start of this preparation phase, executed with an isolated `PTCGP_DATA_DIR`. No production collection database, backup, or capture was opened for writes.

## Verified working today

| Area                     | Evidence and current behaviour                                                                                                                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP / stdio              | The server starts through `dist/index.js` with `StdioServerTransport`. An isolated smoke test lists 17 tools (listed below).                                                                                                        |
| SQLite bootstrap         | A new data directory creates the `cards`, `owned`, `expansions`, `meta`, and capture-round tables. WAL, foreign keys, and a 5-second busy timeout are enabled. `PRAGMA quick_check` passes in the smoke database.                   |
| Collection writes        | Quantity updates, bulk updates, and range updates use parameterized SQL. Bulk and range operations run inside SQLite transactions. Negative deltas in `mode=add` clamp at zero.                                                     |
| Capture rounds           | A round can be started, manually reviewed, checked against `expected_owned_unique`, and finalized transactionally. The test suite verifies a matching round writes the expected quantities and a mismatch leaves `owned` unchanged. |
| Local image pipeline     | PNG, JPEG, and WebP inputs are normalized with Sharp; the test suite exercises different sizes and JPEG orientation using a generated image. OCR uses local Tesseract data and does not upload images.                              |
| Catalog/deck source code | Catalog sync, TCGdex enrichment, Limitless fallback, meta-deck listing, and decklist comparison are implemented as network-dependent tools.                                                                                         |

The verified tool list is:

- `ptcgp_search_cards`, `ptcgp_get_card`, `ptcgp_list_expansions`, `ptcgp_sync_catalog`, `ptcgp_enrich_catalog`
- `ptcgp_collection_stats`, `ptcgp_missing_cards`, `ptcgp_set_card_quantity`, `ptcgp_bulk_update_collection`, `ptcgp_mark_range`
- `ptcgp_meta_decks`, `ptcgp_get_decklist`
- `ptcgp_round_start`, `ptcgp_round_analyze_screenshots`, `ptcgp_round_record`, `ptcgp_round_status`, `ptcgp_round_finalize`

## Partial or unverified capabilities

| Area                     | Status                     | Why it is not yet a public guarantee                                                                                                                                                                                                                                            |
| ------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OCR gap detection        | Partial                    | The algorithm exists and was locally exercised during this audit on a private capture before sanitizing tests. The public test now only proves safe normalization of synthetic PNG/JPEG/WebP inputs; it does not provide a representative, redistributable OCR accuracy corpus. |
| HEIC / HEIF              | Unverified in this runtime | The extension allow-list includes `.heic` and `.heif`, but the installed Sharp/libvips format report advertises AVIF rather than HEIC filename support. Treat HEIC as environment-dependent until a legal fixture and CI matrix prove it.                                       |
| Capture completeness     | Partial                    | Finalization validates the count of missing numbers against the header total, but does not prove that image paths cover the first-to-last screen of an expansion or that a human performed review.                                                                              |
| Catalog and battle data  | Partial                    | The tools make real requests and parse third-party data/HTML, but there are no hermetic integration tests, response fixtures, rate-limit policy, or source/licensing review.                                                                                                    |
| Meta decks               | Partial                    | Parsing Limitless pages is implementation-dependent and has no fixture contract or integration test.                                                                                                                                                                            |
| Backup / restore         | Missing as a feature       | There is no MCP backup/restore tool, documented retention policy, or automated backup before schema changes.                                                                                                                                                                    |
| Database migrations      | Partial                    | A forward-only `schema_migrations` ledger now records the initial schema and battle-column migration. Automatic backup-before-migrate, recovery testing, and downgrade policy are still missing.                                                                                |
| Logging                  | Partial                    | Structured Pino JSON logs now use stderr with a validated log level. Redaction policy, correlation IDs and operational metrics are still missing.                                                                                                                               |
| CLI and other transports | Missing                    | There is no user CLI, Streamable HTTP transport, or compatibility test matrix. stdio is the sole transport.                                                                                                                                                                     |

## Privacy and repository risks

- This checkout is a Git repository on `main`. Its preparation commits are recorded in `HANDOFF.md`. Current tracked-file checks found no real database, backup, capture, log, or `.env` file: `.env.example` and `screenshots/*/.gitkeep` are intentional public placeholders only.
- Any ignored real screenshot or capture must remain outside future tarballs, issues, test fixtures, and examples. Do not rely on `.gitignore` as permission to share it.
- The live collection and local backups are outside this checkout and were not opened for writes during the audit. SQLite paths and capture image paths may be stored in the local database, so do not publish database files or logs that include tool responses.
- No application credentials, cookies, or API keys were found in the source files scanned during the preparation audit. This is not a substitute for a full history and secret scan before making a remote public.
- External catalog and deck sources need terms-of-use, attribution, stability, and redistribution review before a public release.

## Technical assessment

| Choice               | Current position                            | Problem solved / cost / priority                                                                                                                                                                                               |
| -------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TypeScript strict    | Keep                                        | `strict: true` is already enabled. Add no new type system now; later split modules behind interfaces. High value, low cost.                                                                                                    |
| Node.js LTS          | Node 24 preferred; Node 22 and 24 supported | `.nvmrc` selects Node 24 and CI runs both supported LTS lines. The local audit verified clean installs and the full suite on Node 22 and Node 24. `better-sqlite3` requires a runtime-specific install/rebuild. High priority. |
| Official MCP SDK     | Keep                                        | `@modelcontextprotocol/sdk` and stdio transport are already used. Add compatibility tests before changing transport APIs. High value, low cost.                                                                                |
| Zod                  | Extend modestly                             | It validates tool inputs and the `PTCGP_DATA_DIR` and `PTCGP_LOG_LEVEL` environment values. Reuse it for future CLI/config parsing. High value, low cost.                                                                      |
| Versioned migrations | Baseline implemented                        | The ledger and temporary-database migration test prevent silent schema drift. Add backup-before-migrate and recovery tests next. Medium cost, high risk reduction.                                                             |
| Vitest               | Defer decision                              | Node's built-in test runner is currently adequate for the six existing tests. Adopt Vitest only if mocking, fixtures, coverage, or UI/HTTP needs make it useful. Low immediate priority.                                       |
| ESLint / Prettier    | Baseline implemented                        | ESLint, Prettier, `npm run verify`, and CI now establish contributor consistency. Tune rules only in focused follow-up changes.                                                                                                |
| Structured logging   | Baseline implemented                        | Pino writes structured stderr logs and preserves clean MCP stdout. Add redaction tests, correlation IDs and metrics before remote operation.                                                                                   |
| Reproducible build   | Baseline implemented                        | `npm ci`, the lockfile, `.nvmrc`, clean build, lint and CI checks establish the baseline. Add a release artifact and provenance policy before publication. High priority.                                                      |
| GitHub Actions       | Baseline implemented                        | CI runs clean install, verification, and production dependency audit on Node 22 and 24 when a remote is connected. Add secret scanning and release policy before publication.                                                  |
