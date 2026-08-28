# Architecture

## Current architecture

The process has one entry point: `src/index.ts` constructs an official MCP `McpServer`, registers tool modules, and connects it to stdio. Tools call SQLite and image/network helpers directly.

```text
MCP client
  -> stdio transport (`src/index.ts`)
    -> MCP tool modules (`src/tools/*`)
      -> SQLite helper (`src/db.ts`) -> local collection.db
      -> OCR helper (`src/screenshot-analyzer.ts`) -> Sharp + Tesseract
      -> catalog/deck helpers (`src/sync.ts`, `src/limitless.ts`) -> third-party HTTPS
```

`PTCGP_DATA_DIR` selects the mutable data directory; without it, the process uses a per-user local data directory. The server must write protocol traffic only to stdout; diagnostics currently use stderr.

## Target architecture, introduced incrementally

```text
MCP stdio adapter        Future CLI adapter       Future Streamable HTTP adapter
          \                    |                              /
                         application use cases
       collection | catalog | rounds | image-analysis | decks
                                  |
                           domain models/ports
          SQLite repository | OCR port | catalog source ports | logger
                                  |
                SQLite / Sharp+Tesseract / approved remote sources
```

The target is provider-agnostic: an MCP client supplies requests, and no domain module knows whether the client is Claude, ChatGPT, OpenAI, Anthropic, or another compatible client. MCP is the integration boundary, not a model SDK dependency.

### Separation plan

- **Domain and use cases:** move collection quantities, round validation/finalization, and catalog rules into framework-free functions with typed inputs/results.
- **Persistence:** introduce a repository interface backed by SQLite. Put schema initialization, migration runner, transactions, backup-before-migrate, and connection options in one persistence module.
- **OCR:** retain Sharp/Tesseract behind an image-analysis port. Inputs should be bytes or a controlled local-file abstraction; OCR results should contain confidence and warnings, not tool response formatting.
- **MCP tools:** keep Zod schemas and client-facing text/structured responses in adapters. They should translate a use case result rather than hold SQL or OCR logic.
- **Configuration:** centralize validated environment/config-file parsing. Configuration must be documented and never contain a personal path by default in repository files.
- **CLI:** later add a thin adapter for setup, diagnostics, backup, and migration status. It should reuse the same use cases and configuration.
- **Additional transports:** keep stdio unchanged. A future Streamable HTTP adapter should authenticate, bind safely, set request limits/timeouts, and call the same MCP server/use-case layer; it is not implemented in this phase.

## Persistence rules for the next phase

1. Maintain the versioned, forward-only `schema_migrations` ledger rather than scattered `ALTER TABLE` checks.
2. Add a consistent SQLite backup using a SQLite-aware backup API before future data-changing migrations while the database is quiescent.
3. Enable foreign keys on every connection, keep WAL for local single-user operation, and define lock/retry behaviour.
4. Add migration, integrity, rollback-recovery, and concurrent-access tests against temporary directories.

## Boundaries that must remain explicit

- Remote data sources are optional adapters; a local collection must remain usable without a model provider or remote sync.
- Stored capture paths and image hashes are private local metadata, not publishable sample data.
- A client-facing tool description is not evidence of a feature: claims in README must follow executable tests or a documented manual verification.
