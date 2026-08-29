# TCG Pocket MCP remoto para ChatGPT

## Propuesta de valor

Permitir que el propietario consulte su catálogo y colección de Pokémon TCG Pocket desde una conversación de ChatGPT sin exponer operaciones de escritura por red.

**Usuario inicial:** el propietario de la colección.

**Acciones principales:** consultar estadísticas y cartas faltantes, buscar cartas y comparar mazos con la colección.

## Por qué un LLM

El usuario puede expresar filtros, objetivos de colección y preferencias de mazo en lenguaje natural. El modelo interpreta la intención y combina resultados de varias tools; el MCP aporta los datos privados y actuales que el modelo no conoce.

## Experiencia

- El usuario conecta el MCP privado a ChatGPT en modo desarrollador.
- ChatGPT descubre exclusivamente las tools remotas de lectura.
- El usuario pregunta por su progreso, cartas o mazos y recibe una respuesta basada en los resultados estructurados del MCP.
- No se ofrece UI embebida en esta fase.

## Contexto del producto

- Servidor existente: TypeScript/Node.js con MCP sobre `stdio`.
- Datos: SQLite local mediante `PTCGP_DATA_DIR`.
- Transporte remoto: MCP Streamable HTTP en `/mcp`.
- Despliegue: proceso Node persistente en VPS detrás de HTTPS.
- Autenticación inicial: token secreto para despliegue privado.
- Evolución de autenticación: OAuth 2.1 antes de acceso multiusuario o publicación.
- El transporte `stdio` y sus 17 tools permanecen sin cambios.

## Flujos UX

### Consultar progreso de colección

1. El usuario pregunta por el estado global o por una expansión.
2. ChatGPT llama a estadísticas y, si hace falta, al listado de expansiones.
3. ChatGPT resume cifras, porcentajes y prioridades.

### Encontrar cartas y faltantes

1. El usuario describe una carta, filtro o set en lenguaje natural.
2. ChatGPT busca cartas o consulta faltantes.
3. Si necesita detalle, reutiliza el identificador estable con `ptcgp_get_card`.

### Evaluar un mazo

1. El usuario pide opciones del meta o menciona un arquetipo.
2. ChatGPT consulta los mazos actuales.
3. ChatGPT obtiene una decklist y la cruza con la colección para explicar qué falta.

Estos flujos no necesitan UI embebida en la primera versión: los resultados estructurados y una respuesta conversacional son suficientes.

## Superficie remota inicial

- `ptcgp_search_cards`
- `ptcgp_get_card`
- `ptcgp_list_expansions`
- `ptcgp_collection_stats`
- `ptcgp_missing_cards`
- `ptcgp_meta_decks`
- `ptcgp_get_decklist`

Todas deben anunciar `readOnlyHint: true`, `destructiveHint: false` y `openWorldHint` según su comportamiento real. Las tools que escriben en SQLite, sincronizan el catálogo, enriquecen datos o gestionan rondas no se registran en el servidor remoto.

## Requisitos operativos y de seguridad

- HTTPS público estable, preferiblemente `https://mcp.tcg-pocket.xyz/mcp`.
- Token fuera de Git y comparación resistente a timing.
- Límite de cuerpo, timeout, rate limiting por IP en el server y validación de `Origin`/`Host`. Caddy añade la IP remota al encabezado reenviado y el server consume el último valor.
- Logs por request y tool sin token, payload completo, resultados privados ni rutas locales.
- SQLite en disco local persistente del VPS; nunca sobre NFS/SMB.
- Backup consistente antes de copiar la base inicial y backups periódicos del volumen.
- Healthcheck separado que no revele datos de la colección.

## Requisitos mínimos del VPS

- Sistema: Ubuntu 24.04 LTS o Debian 12 de 64 bits.
- Recursos mínimos: 1 vCPU, 1 GiB RAM y 10 GiB SSD.
- Recomendado: 2 vCPU, 2 GiB RAM y 20 GiB SSD, especialmente si se ejecutan OCR o sincronizaciones en la misma máquina.
- Acceso: usuario SSH con `sudo` y autenticación por clave. No documentar ni compartir contraseñas o claves privadas.
- Red: puertos 22, 80 y 443; el proceso Node solo debe escuchar en loopback o en una red privada.
- DNS para HTTPS público: registro `A`/`AAAA` de `mcp.tcg-pocket.xyz` hacia el VPS. Puede estar proxied por Cloudflare si se valida el streaming extremo a extremo.
- Runtime: Node.js 22 LTS o 24, respetando `engines` y recompilando `better-sqlite3` mediante `npm ci` en el VPS.
- Proxy/TLS: Caddy 2 recomendado; Nginx es una alternativa válida si conserva streaming y desactiva buffering para `/mcp`.
- Persistencia local: `/var/lib/ptcgp-mcp/collection.db`, propiedad de un usuario de servicio sin login. No usar NFS, SMB ni una carpeta sincronizada.
- Código: `/opt/ptcgp-mcp-server/current`.
- Configuración/secrets: `/etc/ptcgp-mcp-server/http.env`, modo `0600`, fuera del repositorio.
- Servicio: systemd con usuario dedicado, reinicio automático, límites y hardening.
- Backup: snapshot SQLite consistente hacia almacenamiento cifrado externo; conservar al menos una copia fuera del VPS.

## Variables previstas

- `PTCGP_DATA_DIR=/var/lib/ptcgp-mcp`
- `PTCGP_LOG_LEVEL=info`
- `PTCGP_HTTP_HOST=127.0.0.1`
- `PTCGP_HTTP_PORT=8787`
- `PTCGP_HTTP_ALLOWED_HOSTS=mcp.tcg-pocket.xyz,localhost,127.0.0.1`
- `PTCGP_HTTP_ALLOWED_ORIGINS=` lista explícita cuando un cliente navegador lo necesite
- `PTCGP_HTTP_TOKEN=` secreto aleatorio de al menos 32 bytes para staging/Inspector

No añadir valores reales de secretos a `.env.example`, documentación, logs, commits o unidades systemd.

## Autenticación y exposición

### Prueba privada

Usar OpenAI Secure MCP Tunnel desde el VPS o una conexión equivalente privada. El token estático puede proteger MCP Inspector y pruebas HTTP controladas.

### Endpoint público de ChatGPT

Antes de conectar datos privados a través de un endpoint público, implementar OAuth 2.1 conforme a MCP: protected-resource metadata, discovery del authorization server, PKCE S256, validación de audiencia/scopes y desafíos `WWW-Authenticate`. Un token estático no se considera sustituto de OAuth para publicación o uso multiusuario.

## Plan de implementación para Claude Code

1. Crear una factoría compartida de `McpServer`; `src/index.ts` debe seguir usando todas las tools por `stdio`.
2. Permitir que los registradores de catálogo y colección omitan sus tools mutables sin duplicar handlers.
3. Crear un entrypoint HTTP separado, preferiblemente con un módulo de app importable y un módulo mínimo de arranque.
4. Usar `StreamableHTTPServerTransport` en modo stateless, salvo que una prueba demuestre que una tool requiere estado de sesión MCP.
5. Registrar en HTTP exactamente las siete tools de la sección «Superficie remota inicial»; no registrar rondas, sync, enrich ni mutaciones.
6. Aplicar límite de JSON, rate limit, validación de Host/Origin, timeout, token de staging con comparación resistente a timing y logs redactados.
7. Añadir `GET /healthz` sin datos privados y devolver `405` MCP válido para métodos no soportados en `/mcp`.
8. Añadir scripts `start:http` y, si procede, `inspect:http` sin cambiar `start` ni el binario `stdio`.
9. Añadir ejemplos de systemd, Caddy y entorno bajo `deploy/`; no incluir IP, usuario real ni secretos.
10. Actualizar README/arquitectura indicando claramente qué está implementado y qué sigue siendo futuro.

## Prompt de ejecución para Claude Code: VPS disponible

El propietario ya ha creado el VPS. Conéctate usando la clave SSH local del propietario mediante:

```bash
ssh root@172.233.56.173
```

No solicites ni escribas contraseñas o claves privadas en el repositorio, en logs o en el chat. El acceso inicial como `root` es solo para preparar la máquina; crea un usuario de servicio sin login para ejecutar el MCP y aplica hardening de systemd.

Orden obligatorio de trabajo:

1. Ejecuta primero un inventario de solo lectura: distribución/versión, arquitectura, CPU/RAM/disco, versión de Node/npm, systemd, puertos escuchando, estado del firewall y conectividad saliente. Informa de cualquier requisito ausente antes de improvisar.
2. Comprueba que el checkout local contiene los cambios de Streamable HTTP y que `npm run verify` está verde. No incluyas `.backups/`, `SPEC.md`, `.env`, bases SQLite, capturas ni claves en un artefacto de despliegue.
3. Prepara `/opt/ptcgp-mcp-server/current`, `/var/lib/ptcgp-mcp` y `/etc/ptcgp-mcp-server/http.env` con permisos mínimos. Ejecuta `npm ci` y `npm run build` en el VPS con Node 22 LTS o 24.
4. Instala y configura el servicio systemd y Caddy según los templates de `deploy/`. El proceso Node debe escuchar solo en `127.0.0.1:8787`; Caddy termina TLS y publica `/mcp` y `/healthz`.
5. Genera `PTCGP_HTTP_TOKEN` aleatorio solo en el VPS. No lo muestres completo en la salida. Mantén el endpoint como staging privado: el token no sustituye OAuth 2.1 para una publicación pública.
6. Configura `PTCGP_DATA_DIR=/var/lib/ptcgp-mcp`. No copies `/home/pedro/.local/share/ptcgp-mcp/collection.db` automáticamente. Si se necesita una copia inicial, detén el servicio, realiza un backup SQLite consistente y solicita confirmación antes de transferirla.
7. Antes de abrir tráfico público, comprueba que el DNS de `mcp.tcg-pocket.xyz` apunta a `172.233.56.173`, que los puertos 80/443 son accesibles y que Caddy obtiene el certificado. Si el DNS aún no está preparado, deja el servicio local y reporta el registro necesario.
8. Verifica desde el propio VPS `GET /healthz`, autenticación `401`, inicialización MCP y que `/mcp` anuncia exactamente las siete tools de solo lectura. Ejecuta una llamada de lectura contra una base temporal o vacía; no uses la colección personal sin autorización expresa.
9. Devuelve un informe con: comandos ejecutados, versiones, estado systemd/Caddy, URL final, pruebas realizadas, archivos modificados y cualquier pendiente. No borres datos, no cambies los DNS de correo y no desactives protecciones de SSH sin documentarlo.

Objetivo de esta ejecución: dejar el transporte HTTP desplegado y verificable en el VPS, manteniendo `stdio` intacto y sin exponer todavía herramientas de escritura, OCR, rondas, sincronización o enriquecimiento.

## Pruebas obligatorias

- Toda prueba debe fijar un `PTCGP_DATA_DIR` temporal antes de importar módulos que abran SQLite.
- Confirmar que el smoke `stdio` sigue anunciando exactamente 17 tools.
- Confirmar que HTTP con token válido anuncia exactamente siete tools.
- Probar `401` sin cabecera, con esquema incorrecto y con token incorrecto.
- Probar `200` de `/healthz` sin revelar rutas, recuentos o versión de la base.
- Ejecutar al menos una tool de lectura por HTTP con una base fixture temporal.
- Probar rechazo de Host/Origin no permitidos y payload demasiado grande.
- Ejecutar `npm run verify` y `npm audit --omit=dev`.
- No abrir, migrar, copiar ni escribir `/home/pedro/.local/share/ptcgp-mcp/collection.db` durante las pruebas.

## Fuera de alcance de esta fase

- Publicación en el directorio de plugins o registros MCP.
- Acceso multiusuario.
- Migración a PostgreSQL/D1.
- Exposición remota de escritura, OCR o gestión de rondas.
- Copiar automáticamente la base personal al VPS sin backup consistente y confirmación explícita.
- Modificar DNS, firewall o la máquina remota hasta disponer del acceso y autorización concreta.

## Criterios de aceptación

- Las 17 tools `stdio` conservan nombres y comportamiento.
- El endpoint remoto anuncia exactamente las siete tools permitidas.
- Las peticiones sin token o con token incorrecto reciben `401`.
- MCP Inspector puede inicializar y ejecutar las siete tools por Streamable HTTP.
- Las pruebas usan `PTCGP_DATA_DIR` temporal; no abren ni modifican la base real.
- Reiniciar el servicio conserva la base alojada en el volumen del VPS.
