# Arquitectura

## Estado actual

El servidor es un único proceso Node/TypeScript que expone 17 tools MCP sobre transporte stdio. No hay separación formal entre "lógica de negocio" y "adaptador MCP": cada tool registra su propio Zod schema y ejecuta SQL directamente dentro del callback del handler.

```text
src/index.ts                 Arranque del McpServer, conexión StdioServerTransport
src/config.ts                Configuración validada con Zod (PTCGP_DATA_DIR, PTCGP_LOG_LEVEL)
src/logger.ts                Logger Pino a stderr
src/db.ts                    Conexión SQLite, pragmas, migraciones, helpers de mapeo de cartas
src/screenshot-analyzer.ts   Normalización de imagen (Sharp) + OCR local (Tesseract.js) + heurística de huecos
src/sync.ts                  Sincronización de catálogo (GitHub raw) + enriquecimiento (TCGdex)
src/limitless.ts             Scraping HTML de Limitless TCG para mazos meta y decklists
src/tools/catalog.ts         Registro de tools MCP: búsqueda/consulta/listado/sync/enrich
src/tools/collection.ts      Registro de tools MCP: stats/missing/set/bulk/mark_range
src/tools/decks.ts           Registro de tools MCP: meta_decks/get_decklist
src/tools/rounds.ts          Registro de tools MCP: ciclo de vida de rondas de captura
src/scripts/smoke.ts         Smoke test aislado (stdio + SQLite temporal)
src/scripts/sync-catalog.ts  Script para ejecutar la sincronización fuera del servidor MCP
src/tests/*                  Tests con el runner nativo de Node
```

Puntos fuertes de este estado, verificados en la auditoría de esta fase:

- `screenshot-analyzer.ts` ya es prácticamente framework-free: recibe rutas y un total esperado, devuelve datos tipados, sin ningún acoplamiento a MCP ni a SQLite. Es el módulo más fácil de reutilizar tal cual desde una futura CLI.
- `db.ts` centraliza pragmas y migraciones; el resto del código nunca abre una conexión SQLite por su cuenta.
- Todo el SQL usa sentencias preparadas parametrizadas, incluso el `WHERE` dinámico de `ptcgp_search_cards` y `ptcgp_missing_cards`.

Punto débil principal: la lógica de negocio con más reglas (validación de rondas, cálculo de cantidades finales, contradicciones OCR-vs-confirmado) vive mezclada con el mapeo Zod→SQL dentro de `src/tools/rounds.ts` y `src/tools/collection.ts`. Eso funciona bien mientras solo exista un transporte (stdio) y un cliente (el propio agente MCP), pero duplicaría lógica en cuanto exista una CLI o un segundo transporte.

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

De mayor a menor prioridad, basado en dónde vive hoy la lógica más compleja y mejor cubierta por tests:

1. **Reglas de rondas de captura** (`src/tools/rounds.ts`): es el código con más invariantes (contradicciones OCR-vs-confirmado, modo `minimum` vs `exact`, cuadre de contadores) y ya tiene dos tests de comportamiento (ronda válida, ronda que no cuadra) que sirven de red de seguridad al extraerlo.
2. **Mutaciones de colección** (`src/tools/collection.ts`): `setQty`/`parseNumbers` son pequeñas pero se repiten en tres tools distintas (`set_card_quantity`, `bulk_update_collection`, `mark_range`); extraerlas a un único caso de uso elimina esa triplicación real detectada en la auditoría.
3. **Puerto de repositorio SQLite**: una vez movidas las reglas de negocio fuera de los handlers, mover el SQL detrás de una interfaz explícita es mecánico y de bajo riesgo.
4. **Backup antes de migrar + test de recuperación**: depende de tener ya un repositorio SQLite aislado para poder probarlo sin tocar datos reales.
5. **Política de redacción de logs**: de baja prioridad mientras el logging operativo casi no exista; solo se vuelve urgente antes de exponer un transporte en red.

### Streamable HTTP: solo documentado, no implementado

Esta fase mantiene stdio como único transporte. Si en el futuro se añade Streamable HTTP (según la especificación MCP), debería:

- reutilizar el mismo `McpServer` y los mismos casos de uso, registrando un transporte adicional en vez de un segundo servidor;
- añadir autenticación/autorización explícita, porque a diferencia de stdio (proceso local de un único usuario), un transporte HTTP expone el servidor a una superficie de red compartida;
- definirse en un documento propio antes de tocar código, dado que introduce preguntas (sesiones, CORS, límites de payload) que hoy no existen.

No se implementa nada de esto todavía; queda registrado aquí como dirección, no como trabajo pendiente de esta fase.
