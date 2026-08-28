# ptcgp-mcp-server

Servidor MCP local para un catálogo de Pokémon TCG Pocket y una colección personal en SQLite. Usa el estándar MCP con transporte stdio; no depende de Claude, Anthropic, OpenAI ni de ningún modelo concreto — cualquier cliente compatible con MCP puede lanzar el proceso.

Este es un proyecto en fase de preparación, todavía no publicado. No lo instales pensando en usarlo como paquete público: hoy es un checkout local (`package.json` marcado como `"private": true`, sin remoto Git configurado).

## Qué funciona hoy (verificado)

- Arranca como servidor MCP sobre stdio y expone **17 tools** (tabla más abajo). Verificado con `npm run smoke`, que levanta el binario compilado contra un directorio de datos temporal y lista las tools reales.
- Crea una base SQLite local en `PTCGP_DATA_DIR` (o en `~/.local/share/ptcgp-mcp` por defecto) con WAL, claves foráneas y migraciones versionadas forward-only.
- Todas las escrituras de colección (individual, masiva, por rango) usan sentencias SQL parametrizadas y corren dentro de una transacción cuando afectan a varias filas.
- Las rondas de captura validan un contador de cabecera contra los huecos detectados/confirmados y solo aplican cambios a la colección de forma transaccional, con `confirm=true` explícito.
- Normaliza capturas PNG/JPEG/WebP (con corrección de orientación) y ejecuta OCR local con Tesseract; ninguna imagen sale de la máquina. **HEIC/HEIF está en la lista de formatos aceptados en el código pero no está soportado por el build de Sharp instalado en este entorno** — no lo des por bueno sin comprobarlo tú mismo.
- Incluye tools de sincronización/enriquecimiento de catálogo y de consulta de mazos meta, que dependen de fuentes de red de terceros (GitHub, TCGdex, Limitless TCG) y son la parte menos robusta del proyecto: ver [OPEN_SOURCE_GAP_ANALYSIS.md](OPEN_SOURCE_GAP_ANALYSIS.md) para el detalle de por qué.

## Instalación para desarrollo

Node 22 o 24 (`.nvmrc` fija 24 como preferido; CI cubre ambas). `better-sqlite3` es una dependencia nativa: tras cambiar de versión de Node, vuelve a instalar.

```bash
npm ci
export PTCGP_DATA_DIR="$(mktemp -d)"
npm test
npm run smoke
```

- `npm test` compila y ejecuta la suite (`node --test`) sobre un directorio de datos que tú controlas.
- `npm run smoke` arranca el servidor stdio compilado en un directorio temporal propio, lista sus tools y ejecuta `PRAGMA quick_check` sobre esa base temporal.
- `npm run verify` añade formato (`prettier --check`), lint (`eslint`) y `npm pack --dry-run` — no publica nada.

Nunca ejecutes tests, sync o rondas contra tu `PTCGP_DATA_DIR` real sin backup previo.

## Configurar un cliente MCP

```json
{
  "command": "node",
  "args": ["/ruta/absoluta/a/ptcgp-mcp-server/dist/index.js"],
  "env": {
    "PTCGP_DATA_DIR": "/ruta/absoluta/fuera-del-repo/ptcgp-mcp-data"
  }
}
```

El servidor usa stdout exclusivamente para el protocolo MCP; nunca escribas ahí manualmente. `PTCGP_LOG_LEVEL` acepta `fatal|error|warn|info|debug|trace|silent` (por defecto `info`) y controla logs estructurados en stderr — hoy el logging operativo es mínimo (solo arranque/errores fatales), así que no confíes en él para depurar el comportamiento de una tool concreta todavía.

## Tools MCP

| Grupo             | Tools                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Catálogo          | `ptcgp_search_cards`, `ptcgp_get_card`, `ptcgp_list_expansions`, `ptcgp_sync_catalog`, `ptcgp_enrich_catalog`                  |
| Colección         | `ptcgp_collection_stats`, `ptcgp_missing_cards`, `ptcgp_set_card_quantity`, `ptcgp_bulk_update_collection`, `ptcgp_mark_range` |
| Mazos             | `ptcgp_meta_decks`, `ptcgp_get_decklist`                                                                                       |
| Rondas de captura | `ptcgp_round_start`, `ptcgp_round_analyze_screenshots`, `ptcgp_round_record`, `ptcgp_round_status`, `ptcgp_round_finalize`     |

Flujo seguro de una ronda: `round_start` → `round_analyze_screenshots` → revisión humana con `round_record` → `round_status` → `round_finalize(confirm=true)`. La comprobación de contadores protege contra muchas lecturas incompletas, pero no prueba por sí sola que las capturas cubran toda la expansión: la revisión visual sigue siendo obligatoria.

## Datos y privacidad

- No se versiona ninguna base de datos, backup, captura real, `.env` ni log — `.gitignore` los excluye y esto se verificó contra `git ls-files`, no solo se asume.
- Haz backup de una base SQLite con WAL usando herramientas conscientes de SQLite y con el servidor parado; copiar solo el `.db` mientras está activo puede dejarlo inconsistente.
- El proyecto no requiere ninguna clave de API. Está bajo licencia MIT pero marcado `"private": true` para evitar una publicación accidental en npm mientras dure esta fase de preparación.

## Límites actuales

No hay CLI, transporte Streamable HTTP, backup/restore como funcionalidad del servidor, ni proceso de publicación. Las tools que dependen de red (sync de catálogo, enriquecimiento, mazos meta) no tienen tests de contrato ni protección ante cambios de esquema/maquetación upstream. Antes de ampliar el proyecto, lee [HANDOFF.md](HANDOFF.md), [ARCHITECTURE.md](ARCHITECTURE.md), [ROADMAP.md](ROADMAP.md) y [OPEN_SOURCE_GAP_ANALYSIS.md](OPEN_SOURCE_GAP_ANALYSIS.md).
