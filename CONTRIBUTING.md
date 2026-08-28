# Contributing

This repository is not published yet. Contributions should preserve the local-first, provider-agnostic design and must not contain personal collection data, screenshots, databases, credentials, cookies, or third-party assets without clear redistribution rights.

## Before proposing a change

1. Use a temporary `PTCGP_DATA_DIR`; never test against a collection intended for personal use.
2. Run `npm run verify` with a supported Node.js version.
3. Keep MCP protocol output on stdout and diagnostics on stderr.
4. Add or update tests for behaviour changes, especially SQLite transactions and round validation.
5. Do not add a model-provider SDK to the domain or persistence layers.

## Scope and review

Prefer small, focused changes. Database schema changes need a versioned migration, a temporary-database test, and a documented recovery path. Remote-source changes need fixtures or a clearly stated manual verification path.
