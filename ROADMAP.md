# Roadmap

Fases ordenadas por prioridad, tal como se acordó para esta preparación open source. Ningún ítem de una fase posterior debería empezar antes de cerrar razonablemente la anterior. Nada de lo listado en fases 3-7 está implementado todavía; son planificación, no trabajo hecho.

## Fase 1 — Preparación y privacidad

- [x] `.gitignore` excluye bases SQLite (y sidecars WAL/SHM), backups, capturas reales, `.env`, logs y temporales — verificado contra `git ls-files`.
- [x] Directorio de datos desacoplado de rutas personales vía `PTCGP_DATA_DIR`, con valor por defecto XDG-like (`~/.local/share/ptcgp-mcp`) en vez de una ruta hardcodeada al proyecto.
- [x] Auditoría de código para SQL sin parametrizar o credenciales embebidas: ninguna encontrada.
- [x] Escaneo de secretos sobre el historial completo de Git (2026-08-28): sin credenciales filtradas. Pendiente decidir qué hacer con el email real del autor de los commits (`standnc@proton.me`) antes de la fase 6 — ver `OPEN_SOURCE_GAP_ANALYSIS.md`.
- [x] Revisión de términos de uso de las fuentes externas (2026-08-28): dataset de cartas MIT (v4) pero sin pin de commit; TCGdex sin ToS explícito en su web; Limitless sin `/terms` y con robots.txt ambiguo. Ninguna bloquea el uso actual, pero ninguna está formalmente autorizada tampoco — riesgo abierto, no resuelto, antes de redistribuir datos derivados públicamente.
- [x] HEIC/HEIF confirmado como **no soportado** por el build de Sharp instalado (no solo "sin verificar"). Pendiente: retirar la promesa de `.heic`/`.heif` del código/README o instalar una build de Sharp con soporte HEIC real.

## Fase 2 — Núcleo genérico

Parcialmente completada (2026-08-28): rondas y mutaciones de colección extraídas a `src/domain/`, validación Zod de respuestas de red y copia de seguridad previa a migración. Quedan el puerto de repositorio SQLite y la política de redacción de logs.

- [x] Extraer casos de uso framework-free para rondas de captura, empezando por la lógica ya cubierta por tests en `src/tools/rounds.ts`. → `src/domain/rounds.ts` (functional core: `planFinalize`, `planRecord`, `classifyDetections`, `summarizeRoundValidation`, `validateRoundStart`); el handler MCP queda como shell fino de I/O.
- [x] Extraer casos de uso para mutaciones de colección (`setQty`/`parseNumbers`), eliminando la triplicación actual entre `set_card_quantity`, `bulk_update_collection` y `mark_range`. → `src/domain/collection.ts` (`parseNumbers`, `computeQuantity`).
- [ ] Definir un puerto de repositorio SQLite y mover el SQL directo detrás de él de forma incremental. (Siguiente paso: el SQL sigue en los adaptadores; el dominio ya no depende de él.)
- [x] Añadir copia de seguridad automática antes de aplicar una migración, más un test de recuperación sobre una base temporal. → `backupBeforeMigration` en `src/db.ts` (`VACUUM INTO` consistente a `<data_dir>/backups/`, solo si hay migraciones pendientes sobre una base con datos); test en `src/tests/backup.test.ts`.
- [x] Validar con Zod la forma de las respuestas de red en `src/sync.ts` y `src/limitless.ts`, para fallar con un error claro en vez de romper silenciosamente ante un cambio de esquema upstream. → helper `src/remote-validation.ts` + esquemas en ambos módulos; test en `src/tests/remote-validation.test.ts`.
- [ ] Definir una política de redacción de logs y empezar a usar el logger dentro de las tools (hoy solo se usa en el arranque del proceso).

Criterio de aceptación de esta fase: las 17 tools mantienen su nombre y comportamiento observable, los 6 tests iniciales siguen en verde, y cada caso de uso extraído añade sus propios tests sin abrir nunca un directorio de datos real. Estado 2026-08-28: 34 tests en verde (los 6 iniciales + 28 nuevos), `npm run verify` y `npm audit --omit=dev` limpios. La finalización de rondas realiza la lectura, planificación y escritura bajo una transacción SQLite inmediata, por lo que una segunda instancia local no puede sobrescribir cantidades superiores entre el cálculo y su aplicación. Única desviación deliberada de "comportamiento observable": `ptcgp_round_status` devolvía `validation.unconfirmed` como lista de `null` (leía `card.card_number` sobre filas aliaseadas a `number`); la extracción lo corrige para devolver los números reales, con test que lo fija.

## Fase 3 — Facilidad de instalación y CLI

- [ ] CLI mínima que reutilice los casos de uso de la fase 2 para operaciones de un solo comando (ej. `ptcgp stats`, `ptcgp sync`) sin necesidad de un cliente MCP.
- [ ] Asistente de instalación/configuración que genere `PTCGP_DATA_DIR` y valide requisitos (Node, `better-sqlite3` nativo) antes del primer arranque.
- [ ] Documentar `npx @modelcontextprotocol/inspector` (ya usado en `npm run inspect`) como forma recomendada de probar el servidor sin escribir un cliente propio.

## Fase 4 — Compatibilidad con diferentes clientes MCP

- [ ] Matriz de pruebas manuales/automatizadas contra distintos clientes stdio compatibles con MCP (no solo el usado durante el desarrollo).
- [ ] Documentar explícitamente qué capacidades MCP usa el servidor (tools; sin resources/prompts por ahora) para que un cliente nuevo sepa qué esperar.
- [ ] Revisar límites de tamaño/tiempo de respuesta de las tools más pesadas (`ptcgp_round_analyze_screenshots`, sincronización) frente a timeouts típicos de cliente.

## Fase 5 — Empaquetado npm

- [ ] Retirar `"private": true` de `package.json` solo cuando el propietario lo autorice explícitamente.
- [ ] Comprobar disponibilidad del nombre de paquete y decidir scope (`@usuario/ptcgp-mcp-server` vs nombre plano).
- [ ] Política de versionado semántico y changelog.
- [ ] Verificar que `npm pack --dry-run` (ya parte de `npm run verify`) solo incluye `dist/`, `README.md`, `LICENSE`, `SECURITY.md` — nunca fuentes de test ni datos.

## Fase 6 — GitHub y documentación pública

- [ ] Crear el repositorio remoto (permanece privado/local hasta entonces) y revisar una última vez el historial completo antes de la primera `push`.
- [ ] Plantillas de issues/PR, `CODE_OF_CONDUCT.md` si el propietario lo quiere.
- [ ] Publicar el repositorio como público solo tras aprobación explícita — no es una acción que deba tomarse de forma autónoma.

## Fase 7 — Registro oficial MCP y Smithery

- [ ] Preparar el manifiesto/metadata que exige el registro oficial de MCP.
- [ ] Evaluar los requisitos de Smithery (empaquetado, licencia, documentación) una vez el paquete esté publicado en npm.
- [ ] Ninguna acción de registro se realiza sin aprobación explícita del propietario; esta fase es la última y depende de que todas las anteriores estén cerradas.
