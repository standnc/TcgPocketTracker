# Política de seguridad

## Alcance

Este proyecto es un servidor MCP local de un solo usuario. Su base SQLite, las rondas de captura, las capturas de pantalla y cualquier `.env` son datos privados del usuario y nunca deben adjuntarse a un issue público ni a un reporte.

El transporte por defecto sigue siendo stdio (proceso local, sin puerto de red abierto). Adicionalmente existe un entrypoint HTTP opcional (`npm run start:http`, `src/http.ts`) que expone **solo 7 tools de lectura** y requiere token estático. Nunca se registran por HTTP tools de escritura, sincronización, enriquecimiento ni ciclo de vida de rondas — la superficie mutable queda exclusivamente en stdio.

Las tools de sincronización de catálogo, enriquecimiento y mazos meta hacen peticiones HTTPS salientes únicamente cuando se invocan explícitamente. El servidor no requiere ninguna clave de API para operar.

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

## Notas del transporte HTTP

- **Token**: >= 32 caracteres, generado con entropía criptográfica (`openssl rand -hex 32`). Se compara con `crypto.timingSafeEqual`; cuando las longitudes difieren se hashean con SHA-256 antes de comparar para no revelar la diferencia por early return. Nunca lo commitees ni lo pases por CLI en histórico de shell — vive en `/etc/ptcgp-mcp-server/http.env` (modo 0600).
- **Host / Origin**: allowlists explícitas. `Host` protege contra DNS rebinding; `Origin` bloquea cualquier cross-site por defecto (lista vacía) y solo se relaja cuando declaras un origen concreto. Los clientes server-to-server (Inspector CLI, ChatGPT connector) no envían `Origin` y quedan permitidos.
- **Rate limit**: el server aplica una ventana fija en memoria por IP antes de autenticar (60 peticiones/minuto/IP por defecto), con un máximo de claves para impedir crecimiento sin límite. Caddy añade la IP remota a `X-Forwarded-For` y el server consume el último valor, no uno inyectado por el cliente. Si se escala a varias instancias, se necesita un limitador compartido en el proxy o Redis.
- **Body y timeout**: límite de cuerpo por defecto 1 MiB y timeout 30 s, ambos configurables. Cuerpos que exceden se responden con `413` + `Connection: close`; timeouts con `408`.
- **Logs**: cada request se registra con method, path, status, ms, ip y cabeceras redactadas. Nunca se loguean token, cuerpo, resultados de tools ni rutas locales.
- **OAuth 2.1**: sigue siendo obligatorio antes de exposición multiusuario o publicación en directorios MCP. El token estático es un puente para pruebas privadas (Secure MCP Tunnel, Cloudflare Tunnel), no una solución para producción abierta.
- **Superficie mínima**: solo las 7 tools de lectura viajan por HTTP. Las tools destructivas (`set_card_quantity`, `bulk_update_collection`, `mark_range`, `round_finalize`), las que hacen red (`sync_catalog`, `enrich_catalog`) y las de ciclo de vida de rondas nunca se registran remotamente; un prompt injection en un cliente no puede escribir en la base.
