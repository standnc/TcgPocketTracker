# Arquitectura

## Estado actual

El servidor es un único proceso Node/TypeScript. La composición del `McpServer` vive en `src/server/factory.ts`; los dos entrypoints (stdio y HTTP) reutilizan esa factoría y difieren solo en el transporte y en la lista de tools registradas. Stdio expone las 17 tools completas; HTTP expone exclusivamente 7 tools de lectura mediante una allowlist (`REMOTE_TOOL_NAMES`). Las reglas de negocio con más invariantes —rondas de captura y mutaciones de colección— viven ya en un núcleo framework-free (`src/domain/`), y sus tools MCP son adaptadores finos que leen/escriben SQLite y delegan las decisiones en ese núcleo. Las demás tools (catálogo, mazos) todavía registran su Zod schema y ejecutan SQL directamente dentro del callback del handler; migrarlas es trabajo incremental pendiente.

```text
src/index.ts                 Entrypoint stdio: usa la factoría con las 17 tools completas
src/http.ts                  Entrypoint HTTP: arranca node:http con createHttpApp y publica /mcp + /healthz
src/server/factory.ts        Factoría createMcpServer({ include? }) y REMOTE_TOOL_NAMES (7 tools de lectura)
src/http/config.ts           Zod + resolveHttpConfig(env): host, puerto, token, allowlists, body-limit, timeout y rate limit
src/http/guards.ts           bearerToken/verifyToken (timingSafeEqual), Host/Origin, readJsonBody, redactHeaders
src/http/rate-limit.ts       Ventana fija en memoria por IP, acotada por max_keys
src/http/app.ts              RequestListener: rutas POST/GET /mcp con transport stateless + rate limit + 405/404 + /healthz
src/config.ts                Configuración validada con Zod (PTCGP_DATA_DIR, PTCGP_LOG_LEVEL)
src/logger.ts                Logger Pino a stderr
src/db.ts                    Conexión SQLite, pragmas, migraciones, backup previo a migrar, helpers de mapeo de cartas
src/domain/rounds.ts         Reglas puras de rondas de captura (functional core, sin MCP/Zod/SQL)
src/domain/collection.ts     Reglas puras de colección (parseo de rangos, aritmética de cantidad)
src/domain/errors.ts         Tipo de error de dominio compartido
src/remote-validation.ts     Guardia Zod para respuestas de red no confiables
src/screenshot-analyzer.ts   Normalización de imagen (Sharp) + OCR local (Tesseract.js) + heurística de huecos
src/sync.ts                  Sincronización de catálogo (GitHub raw) + enriquecimiento (TCGdex), con respuestas validadas por Zod
src/limitless.ts             Scraping HTML de Limitless TCG para mazos meta y decklists, con datos parseados validados por Zod
src/tools/catalog.ts         Registro de tools MCP: búsqueda/consulta/listado/sync/enrich (aceptan allowlist)
src/tools/collection.ts      Registro de tools MCP: stats/missing/set/bulk/mark_range (aceptan allowlist)
src/tools/decks.ts           Registro de tools MCP: meta_decks/get_decklist (aceptan allowlist)
src/tools/rounds.ts          Registro de tools MCP: ciclo de vida de rondas (aceptan allowlist)
src/scripts/smoke.ts         Smoke stdio: lista tools sobre base temporal
src/scripts/smoke-http.ts    Smoke HTTP: arranca dist/http.js con token efímero y verifica las 7 tools
src/scripts/sync-catalog.ts  Script para ejecutar la sincronización fuera del servidor MCP
src/tests/*                  Tests con el runner nativo de Node (incluye http.test.ts y http.guards.test.ts)
deploy/                       Plantillas genéricas de systemd, Caddy y environment file (sin secretos)
```

Puntos fuertes de este estado, verificados en la auditoría de esta fase:

- `screenshot-analyzer.ts` ya es prácticamente framework-free: recibe rutas y un total esperado, devuelve datos tipados, sin ningún acoplamiento a MCP ni a SQLite. Es el módulo más fácil de reutilizar tal cual desde una futura CLI.
- `db.ts` centraliza pragmas y migraciones; el resto del código nunca abre una conexión SQLite por su cuenta.
- Todo el SQL usa sentencias preparadas parametrizadas, incluso el `WHERE` dinámico de `ptcgp_search_cards` y `ptcgp_missing_cards`.

Punto débil histórico (ya abordado en su mayor parte): la lógica de negocio con más reglas (validación de rondas, cálculo de cantidades finales, contradicciones OCR-vs-confirmado, aritmética de cantidad de colección) vivía mezclada con el mapeo Zod→SQL dentro de `src/tools/rounds.ts` y `src/tools/collection.ts`. Se ha extraído a `src/domain/rounds.ts` y `src/domain/collection.ts` como funciones puras; los handlers quedan como adaptadores que leen el estado, llaman al dominio y aplican el plan resultante en una transacción. El acoplamiento restante es el SQL directo en los adaptadores, que el puerto de repositorio (ver abajo) moverá detrás de una interfaz explícita.

## Arquitectura objetivo (incremental, no una reescritura)

La dirección recomendada es separar por capas, migrando un caso de uso cada vez y manteniendo los 17 nombres de tools y su comportamiento observable estables durante todo el proceso:

```text
dominio / casos de uso     Funciones puras, sin Zod ni SQL ni MCP: reciben inputs tipados
                            y un "puerto" de repositorio, devuelven resultados tipados o un
                            error de dominio (no una excepción genérica de SQLite).

persistencia (SQLite)      Un puerto/interfaz por agregado (CardsRepository, OwnedRepository,
                            RoundsRepository) implementado con better-sqlite3. db.ts sigue
                            siendo responsable solo de la conexión, pragmas y migraciones.

OCR / imágenes             screenshot-analyzer.ts se mantiene casi igual; se invoca desde el
                            caso de uso de rondas en vez de desde el tool handler.

tools MCP                  Adaptadores finos: Zod schema de entrada -> llamar al caso de uso
                            -> mapear el resultado a { content, structuredContent }.

transporte stdio           index.ts sigue siendo el único transporte activo.

configuración               config.ts se reutiliza tal cual desde CLI y desde MCP.

CLI (futura)                 Importa los mismos casos de uso; imprime salida legible para
                            humanos en vez de JSON de MCP. No necesita levantar un servidor.

transportes futuros          Streamable HTTP registraría un transporte adicional sobre el
                            mismo McpServer, o expondría los mismos casos de uso vía HTTP;
                            no debería duplicar reglas de negocio.
```

### Por qué este orden de extracción

De mayor a menor prioridad, basado en dónde vive la lógica más compleja y mejor cubierta por tests. Estado a 2026-08-28 anotado en cada punto:

1. **Reglas de rondas de captura** — hecho. Extraídas a `src/domain/rounds.ts`; los dos tests de comportamiento (ronda válida, ronda que no cuadra) siguen verdes y se añadieron tests unitarios del núcleo puro.
2. **Mutaciones de colección** — hecho. `parseNumbers` y la aritmética de cantidad (`computeQuantity`) viven en `src/domain/collection.ts`; el `setQty` del adaptador las reutiliza, sin duplicar la regla entre `set_card_quantity`, `bulk_update_collection` y `mark_range`.
3. **Puerto de repositorio SQLite** — pendiente. Con las reglas ya fuera de los handlers, mover el SQL detrás de una interfaz explícita (Cards/Owned/Rounds) es mecánico y de bajo riesgo.
4. **Backup antes de migrar + test de recuperación** — hecho. `backupBeforeMigration` (`VACUUM INTO` a `<data_dir>/backups/`) en `src/db.ts` y `src/tests/backup.test.ts`, solo sobre bases temporales. No requirió el puerto de repositorio: `VACUUM INTO` produce un snapshot consistente directamente.
5. **Política de redacción de logs** — pendiente. De baja prioridad mientras el logging operativo casi no exista; solo se vuelve urgente antes de exponer un transporte en red.

Además, y aunque no es una extracción, se cerró el otro ítem frágil de la fase 2: validación Zod de las respuestas de red (`src/remote-validation.ts`, con esquemas en `sync.ts` y `limitless.ts`), para fallar con un error claro y con la fuente/ruta ante un cambio de esquema upstream.

### Streamable HTTP: fase inicial implementada

La primera versión del transporte HTTP MCP Streamable ya está en el árbol y coexiste con stdio. Ambos comparten la factoría `createMcpServer` y difieren solo en dos ejes:

- **Transporte**: stdio (`src/index.ts`) monta un `StdioServerTransport` de por vida; HTTP (`src/http.ts`) monta `node:http` y por cada `POST /mcp` crea un `StreamableHTTPServerTransport` en modo **stateless** (`sessionIdGenerator: undefined`, `enableJsonResponse: true`) contra un `McpServer` recién construido con `include = REMOTE_TOOL_NAMES`. Al terminar el request se cierra transport y server.
- **Superficie**: stdio anuncia 17 tools; HTTP anuncia exclusivamente 7 tools de lectura. No hay tools duplicadas ni handlers separados: cada `registerXxxTools` acepta `options.include` y envuelve cada `server.registerTool(...)` con un guard.

Guardias del entrypoint HTTP, todas ejecutadas antes de instanciar el server MCP:

1. `Host` (allowlist configurable). Rechazo 403.
2. `Origin` (allowlist configurable; vacía = deniega cross-site, permite ausencia). Rechazo 403.
3. `Authorization: Bearer <token>` obligatorio; comparación `crypto.timingSafeEqual` con normalización SHA-256 cuando las longitudes difieren. Rechazo 401 con `WWW-Authenticate: Bearer`.
4. Rate limit en memoria por IP antes de autenticar (60/min/IP por defecto; Caddy reescribe `X-Forwarded-For`). Rechazo 429.
5. Lectura del cuerpo con límite y timeout. Excede → 413 con `Connection: close`; timeout → 408.
6. `POST` y `GET` en `/mcp`, resto → 405 con `Allow: GET, POST` y cuerpo JSON-RPC.
7. `GET /healthz` sin auth → 200 `text/plain "ok\n"`.

Cada request se registra con method, path, status, ms y ip; las cabeceras `authorization` y `cookie` se redactan antes de loguear. El logger sigue emitiendo pino JSON a stderr — stdout queda reservado para clientes stdio.

Fuera de alcance de esta fase, documentado y sin implementar aún: OAuth 2.1 conforme al spec MCP (protected-resource metadata, discovery del authorization server, PKCE S256, validación de audiencia/scopes, `WWW-Authenticate` challenge), acceso multiusuario, publicación en directorios de plugins/MCP y migración de SQLite. Antes de exponer datos privados a un endpoint público real (multi-usuario o publicación) hay que implementar OAuth 2.1: el token estático solo se acepta como puente durante pruebas privadas.
