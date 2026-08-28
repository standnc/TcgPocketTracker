# Plan del tracker web de Pokémon TCG Pocket

Estado: propuesta de arquitectura y ejecución. Este documento no autoriza desplegar, migrar datos personales ni exponer el MCP por red.

## Decisión recomendada

Construir el tracker como un proyecto web separado, provisionalmente `ptcgp-tracker`, con una API propia y PostgreSQL en el VPS. El repositorio actual sigue siendo el servidor MCP local y, más adelante, se convierte en un adaptador que llama a los mismos casos de uso o a la API autenticada.

No se debe usar el MCP como base de datos, ni dar a la web acceso directo a PostgreSQL. La web, el OCR y el MCP deben entrar por una capa de aplicación que aplica autenticación, autorización, validaciones, transacciones y auditoría.

```text
Navegador web --- HTTPS --- API de aplicación --- PostgreSQL
                                 |       |
                         cola OCR |       +--- almacenamiento privado de imágenes
                                 |
Cliente MCP --- stdio / futuro HTTP --- adaptador MCP ---/
```

### Por qué PostgreSQL

- El tracker tendrá potencialmente sesiones web, OCR en segundo plano y MCP escribiendo a la vez. PostgreSQL proporciona transacciones, aislamiento y control de concurrencia para ese escenario.
- El driver Node recomendado sería `pg`, con pool de conexiones. Elimina el binario nativo `better-sqlite3` que obliga a recompilar al cambiar de ABI de Node.
- El modelo actual es relacional: catálogo, expansiones, cantidades, rondas, observaciones y usuarios. PostgreSQL permite conservarlo sin convertir el dominio en documentos arbitrarios.

SQLite sigue siendo válida para la instalación local actual. No se elimina ni se toca durante las fases del tracker.

## Límites y responsabilidades

| Componente                | Responsabilidad                                                                     | No debe hacer                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Web                       | Mostrar colección, pedir cambios, revisar rondas y mostrar trabajos OCR             | Conectar a PostgreSQL, aplicar reglas de colección en el navegador o guardar secretos |
| API                       | Autenticación, autorización, casos de uso, validación, transacciones e idempotencia | Interpretar protocolos de un cliente MCP concreto                                     |
| Worker OCR                | Recibir una imagen privada, normalizarla, extraer propuestas y devolver confianza   | Cambiar una colección sin pasar por el caso de uso de revisión/finalización           |
| Adaptador MCP             | Traducir tools MCP a los mismos casos de uso o API                                  | Ser dueño de la lógica, exponer rutas locales o aceptar un `user_id` arbitrario       |
| PostgreSQL                | Estado relacional y metadatos                                                       | Guardar imágenes de captura como BLOB o exponerse a Internet                          |
| Almacenamiento de objetos | Capturas originales y derivados temporales con clave opaca                          | Ser público o persistir imágenes sin retención definida                               |

## Modelo de datos objetivo

El catálogo puede ser global; todo estado de colección debe pertenecer a un usuario desde la primera migración.

| Tabla o agregado       | Campos esenciales                                                            | Reglas                                                                     |
| ---------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `users`                | `id`, identidad autenticada, fechas                                          | No usar nombre/email como clave de colección                               |
| `cards`, `expansions`  | Id actual, metadatos de catálogo, procedencia y fecha de sincronización      | Compartido, solo procesos autorizados escriben                             |
| `collection_cards`     | `user_id`, `card_id`, `quantity`, `updated_at`                               | Único por `(user_id, card_id)`; `quantity >= 0`                            |
| `capture_rounds`       | `id`, `user_id`, expansión, modo, contador esperado, estado, auditoría       | Una ronda no aplica nada hasta validación final                            |
| `capture_round_images` | ronda, clave opaca de objeto, hash, dimensiones, orden, análisis             | Nunca ruta absoluta de un equipo ni imagen embebida en respuestas normales |
| `capture_round_cards`  | ronda, número, estado, cantidad, confianza, origen, cantidades antes/después | Conserva trazabilidad de la aplicación                                     |
| `ocr_jobs`             | usuario, imagen, estado, reintentos, error seguro, fecha                     | Asíncrono; no bloquea peticiones HTTP largas                               |
| `idempotency_keys`     | usuario, clave, operación, resultado/respuesta, expiración                   | Evita duplicar cambios al reintentar una petición                          |

Usar `uuid`, `timestamptz`, restricciones `CHECK`, claves foráneas e índices por `user_id`, ronda y carta. Los campos de análisis estructurado pueden ser `jsonb`, pero las reglas consultadas con frecuencia deben seguir en columnas normales.

## Necesidades de infraestructura en el VPS

Para un prototipo personal con API, worker OCR y PostgreSQL: Linux actualizado, Docker Engine con Compose, 2 vCPU, 4 GB de RAM y al menos 40 GB SSD son un punto de partida razonable. Ajustar con métricas reales si se procesan muchas capturas o hay más usuarios.

Necesitarás además:

1. Un dominio solo cuando expongas la web; mientras tanto se puede desarrollar con acceso privado.
2. Proxy inverso con HTTPS automático, por ejemplo Caddy o Nginx. Solo el proxy publica 80/443.
3. PostgreSQL y servicios internos en una red Docker privada; nunca publicar `5432`.
4. Almacenamiento privado para imágenes: inicialmente un volumen cifrado y con permisos restrictivos; para producción, almacenamiento S3-compatible o equivalente con copias externas.
5. Copias de seguridad cifradas fuera del VPS: dump consistente de PostgreSQL, objetos de imágenes y prueba periódica de restauración.
6. Secretos fuera de Git: archivo con permisos restrictivos o gestor de secretos. Separar desarrollo, staging y producción.
7. SSH con claves, actualizaciones de seguridad, firewall, monitorización de espacio, alertas de backup fallido y registros redactados.
8. Política de retención: cuánto tiempo se guardan capturas originales, derivados OCR, rondas canceladas y logs.

No pongas API keys, cookies, contraseñas de PostgreSQL ni rutas de capturas en el frontend, repositorio, logs públicos o respuestas MCP.

## Autenticación y autorización

Aunque el primer uso sea personal, crear el concepto de usuario ahora evita una migración difícil después.

- La API deriva el usuario de la sesión o token; nunca confía en un `user_id` enviado por el navegador o MCP.
- Cada consulta y mutación de colección filtra por ese usuario dentro de la capa de repositorio/caso de uso.
- El adaptador MCP debe usar un token o identidad de servicio limitada y asociarla a un usuario explícitamente autorizado.
- Para el MVP se debe elegir una estrategia: proveedor de identidad externo, correo/contraseña con recuperación, o acceso cerrado de un único propietario. No se debe inventar este mecanismo durante el despliegue.
- Registrar acciones sensibles: importación, aplicación de ronda, borrado, cambio de permisos y restauración.

## Flujo de imagen a cartas

1. La web o cliente MCP pide una carga autorizada.
2. La imagen se guarda con una clave opaca, hash y metadatos mínimos; no con una ruta local del cliente.
3. Se encola `ocr_job`; el worker ejecuta Sharp/Tesseract u otro motor futuro dentro de un límite de tamaño, píxeles y tiempo.
4. El worker crea propuestas de huecos/posesión con confianza, sin escribir `collection_cards`.
5. El usuario revisa la ronda; la API aplica la misma validación actual de contador esperado y cobertura.
6. Una transacción final actualiza la colección, la auditoría de ronda y el resultado idempotente.
7. Una tarea de retención elimina originales/derivados vencidos según política.

El OCR es ayuda, no fuente de verdad. No finalizar automáticamente una ronda por detección de imagen sin la revisión y reglas de conteo.

## Plan de migración desde la SQLite actual

La migración será de una sola dirección y con ventana de mantenimiento; evitar escritura dual entre SQLite y PostgreSQL.

1. Inventariar esquema y conteos de la SQLite, sin mostrar ni subir datos personales.
2. Con el MCP detenido, crear un backup consistente mediante una API SQLite, no copiando solo el `.db` con WAL activo.
3. Definir y probar migraciones PostgreSQL sobre una base vacía y datos ficticios.
4. Crear un exportador que produzca un formato privado y validable; incluir catálogo, cantidades, rondas y auditoría necesaria, pero no imágenes por defecto.
5. Importar a una base PostgreSQL de staging aislada.
6. Comparar conteos por tabla, por expansión, cartas únicas y copias; revisar muestras de rondas aplicadas y ejecutar comprobaciones de integridad.
7. Repetir sobre producción durante la ventana acordada, conservar el backup SQLite como solo lectura y cambiar la configuración de la aplicación.
8. Declarar terminado solo tras probar restauración PostgreSQL y verificar la colección desde web y MCP.

No borrar la SQLite original ni sus backups durante esta migración.

## Fases de implementación

### Fase 0 — Decisiones y entorno local

- Elegir nombre del tracker, propietario, licencia del nuevo repositorio, dominio futuro y nivel de apertura.
- Crear repositorio separado y un entorno Docker local con PostgreSQL; todavía sin VPS.
- Definir contrato de API, modelo de usuario, retención de imágenes y fuentes de catálogo permitidas.
- Criterio de salida: `docker compose up` crea una base vacía, migrada y testeable sin datos reales.

### Fase 1 — Núcleo backend PostgreSQL

- Extraer casos de uso de colección/rondas del MCP actual a un paquete reutilizable o reimplementarlos con pruebas de contrato.
- Crear repositorio PostgreSQL, migraciones, transacciones, idempotencia y auditoría.
- Implementar API autenticada mínima para catálogo, colección y ronda manual.
- Criterio de salida: dos usuarios de prueba no pueden leer/modificar datos ajenos; una ronda inválida no cambia la colección.

### Fase 2 — Importación segura

- Crear exportador SQLite y cargador PostgreSQL, exclusivamente con directorios temporales y backups consistentes.
- Añadir informes de conteos y modo simulación.
- Criterio de salida: importación de datos ficticios y una copia de prueba validada de extremo a extremo; sin tocar la colección de uso diario hasta aprobación explícita.

### Fase 3 — Web MVP

- Login elegido, vista de colección, búsqueda, cantidades manuales, estadísticas y revisión de rondas.
- Añadir API de carga privada, límites y validación de tipo/tamaño de imagen.
- Criterio de salida: un usuario puede gestionar su colección manualmente desde navegador sin MCP.

### Fase 4 — OCR asíncrono

- Worker aislado, cola persistente, progreso, reintentos limitados, resultados revisables y retención.
- Añadir fixtures legales/sintéticas y medición de precisión por tipo de captura.
- Criterio de salida: imágenes de prueba producen propuestas sin bloquear la web ni aplicar cambios automáticos.

### Fase 5 — Puente MCP

- Mantener stdio para clientes locales; el adaptador usa la API autenticada o el paquete de casos de uso compartido.
- Diseñar HTTP MCP solo si un cliente real lo exige; añadir autenticación, rate limit y pruebas antes de exponerlo.
- Criterio de salida: una operación hecha por MCP y otra por web respetan las mismas reglas y auditoría.

### Fase 6 — VPS y operación

- Desplegar primero en entorno privado, con HTTPS, firewall, secretos, backups externos y monitorización.
- Probar restauración, rotación de secretos, actualización y respuesta ante caída.
- Criterio de salida: ninguna base ni imagen es pública y una restauración reproducible ha sido comprobada.

## Orden de trabajo recomendado

1. Crear el nuevo repositorio del tracker y Docker local con PostgreSQL.
2. Diseñar el contrato API y la identidad de usuario antes de la interfaz.
3. Implementar colección y rondas manuales con PostgreSQL y pruebas.
4. Hacer una importación de prueba, no de producción.
5. Construir el MVP web.
6. Integrar OCR/cola.
7. Convertir el MCP en adaptador de la misma capa.
8. Desplegar en VPS únicamente cuando backups, HTTPS y autorización estén probados.

## Decisiones que necesita el propietario

- ¿Será solo para ti al principio, o habrá otros usuarios/invitaciones?
- ¿Quieres acceso mediante proveedor de identidad, correo/contraseña o acceso cerrado?
- ¿Qué datos de captura quieres conservar y durante cuánto tiempo?
- ¿Tienes dominio y proveedor de backups externos, o prefieres empezar solo en local?
- ¿Qué fuentes de catálogo, imágenes y mazos tienen permiso explícito de uso y redistribución?
- ¿El tracker y el MCP compartirán marca/repositorio, o se mantendrán como proyectos independientes?

## Referencias técnicas

- PostgreSQL: [control de concurrencia y MVCC](https://www.postgresql.org/docs/current/mvcc-intro.html).
- node-postgres: [pool de conexiones](https://node-postgres.com/apis/pool) y [transacciones](https://node-postgres.com/features/transactions).

Las referencias explican capacidades técnicas; no sustituyen una revisión legal de fuentes de cartas, imágenes o datos de terceros.
