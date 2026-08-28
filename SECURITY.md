# Política de seguridad

## Alcance

Este proyecto es un servidor MCP local de un solo usuario. Su base SQLite, las rondas de captura, las capturas de pantalla y cualquier `.env` son datos privados del usuario y nunca deben adjuntarse a un issue público ni a un reporte.

El único transporte activo es stdio (proceso local, sin puerto de red abierto). Las tools de sincronización de catálogo, enriquecimiento y mazos meta hacen peticiones HTTPS salientes únicamente cuando se invocan explícitamente. El servidor no requiere ninguna clave de API.

Fuentes de red usadas actualmente por el código (ver `OPEN_SOURCE_GAP_ANALYSIS.md` para el detalle de robustez de cada una):

- `raw.githubusercontent.com` (dataset base de cartas, `src/sync.ts`)
- API de TCGdex (`src/sync.ts`)
- Limitless TCG, vía scraping HTML (`src/limitless.ts`)

## Reportar una vulnerabilidad

Mientras no exista un repositorio remoto ni un canal de contacto público, reporta cualquier problema de seguridad de forma privada al mantenedor. No incluyas en el reporte: bases de datos de colección, capturas de pantalla reales, rutas absolutas locales, tokens, cookies ni logs sin redactar.

Incluye una reproducción mínima, la versión o commit afectado, el impacto, y cualquier mitigación segura que hayas encontrado. Da tiempo al mantenedor para investigar antes de una divulgación pública.

## Notas de seguridad local

- Mantén `PTCGP_DATA_DIR` fuera de cualquier clon pensado para publicación.
- Haz backup de la base SQLite con herramientas conscientes de SQLite y con el servidor parado; no copies solo el `.db` mientras está en uso con WAL activo, puede quedar inconsistente.
- Revisa `git status --ignored` antes del primer commit hacia un remoto nuevo. `.gitignore` no elimina datos que ya estuvieran comprometidos en otro repositorio, backup o archivo comprimido.
- Antes de conectar cualquier remoto público (fase 6 del roadmap), escanea el historial completo de Git en busca de secretos, no solo el árbol de trabajo actual.
