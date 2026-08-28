# Security policy

## Supported scope

This project is a local MCP server. Its SQLite collection, capture rounds, screenshots and environment files are private user data and must never be committed or attached to public issues.

The server currently uses the stdio transport. Catalog enrichment and deck tools make outbound HTTPS requests only when their corresponding MCP tool or sync script is invoked. The project does not require an API key.

## Reporting a vulnerability

Until a public repository and contact channel exist, report security issues privately to the maintainer. Do not include collection databases, screenshots, absolute local paths, tokens, cookies, or unredacted logs in a public report.

Include a minimal reproduction, affected version or commit, impact, and any safe mitigation you found. Please allow the maintainer time to investigate before public disclosure.

## Local safety notes

- Keep `PTCGP_DATA_DIR` outside a clone intended for publication.
- Back up SQLite using SQLite-aware tooling while the server is stopped; do not copy only a WAL-backed `.db` file while it is in use.
- Review `git status --ignored` before the first commit. `.gitignore` cannot remove data already committed in another repository or archive.
