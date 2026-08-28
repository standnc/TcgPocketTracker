# Roadmap

This roadmap is ordered. Items are proposals, not functionality already delivered.

## 1. Preparation and privacy

- Initialize or locate the intended Git repository before any public work; inspect history and tracked files for private data.
- Keep databases, WAL/SHM sidecars, backups, screenshots, `.env` files, logs, and temporary files excluded.
- Choose a license and contributor/security policy with the maintainer.
- Replace the remaining private-data verification dependency with a legal synthetic/consented OCR fixture corpus and document its limits.
- Establish a supported Node LTS range and reproducible clean-install command.

## 2. Generic core

- Extract collection and capture-round use cases from MCP tool adapters.
- Add repository interfaces, backup-before-migrate, and migration-recovery tests around the existing versioned SQLite migration ledger.
- Define a portable import/export format that excludes images and has explicit privacy controls.
- Add structured, redacted stderr logging and error taxonomy.

## 3. Installation ease and CLI

- Provide a small CLI for initialization, configuration diagnostics, catalog sync, safe backup, and migration status.
- Provide sample configuration that always uses a user-selected data directory.
- Improve actionable errors for missing native dependencies and an empty catalog.

## 4. Compatibility with MCP clients

- Test the stdio server against multiple MCP-compatible clients without client-specific runtime dependencies.
- Document client-neutral configuration examples and protocol/version support.
- Design, security-review, and then implement Streamable HTTP only when a real remote-use case requires it.

## 5. npm packaging

- Define package files, `engines`, ESM entry points, native dependency behaviour, and a clean install smoke test.
- Publish only after package provenance, license, changelog, and release process are ready.

## 6. GitHub and public documentation

- Add CI for clean install, build, unit/integration tests, lint/format, dependency audit, and secret scanning.
- Add issue/PR templates, CODEOWNERS or maintainer policy, source attribution, limitations, and contribution guidance.
- Review all examples and release artifacts for data leakage.

## 7. Official MCP registry and Smithery

- Complete package, security, compatibility, and operational documentation first.
- Then evaluate registry metadata and Smithery requirements against the stable stdio package.
- Do not register or publish until the maintainer explicitly approves a public release.

## Related future project: web tracker

The tracker should not be folded into this server prematurely. Its PostgreSQL, VPS, web/API, OCR and MCP-integration phases are documented in [WEB_TRACKER_PLAN.md](WEB_TRACKER_PLAN.md).
