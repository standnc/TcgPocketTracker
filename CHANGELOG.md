# Registro de cambios

Este documento resume los cambios que llegaron a `landing-clean` desde
`main` entre el 28 y el 29 de agosto de 2026. Es un registro de hechos
verificados en el repositorio; no convierte las tareas futuras en
funcionalidad publicada.

## 2026-08-29 — HTTP remoto, web pública y correcciones de operación

### MCP HTTP de catálogo

- Se añadió un segundo entrypoint HTTP (`src/http.ts`) junto al servidor MCP
  local por `stdio`. La vía HTTP registra únicamente siete herramientas de
  lectura: búsqueda/ficha/listado de catálogo, estadísticas y faltantes de
  colección, y consultas de mazos.
- Se incorporaron configuración validada con Zod, límite de cuerpo y de
  tiempo, token Bearer estático comparado en tiempo constante, allowlists de
  `Host` y `Origin`, y rate limiting en memoria por IP.
- Se añadieron plantillas de despliegue para Caddy y systemd. Las correcciones
  posteriores fijaron la emisión ACME pública tras la recuperación DNS y el
  uso de cabeceras de proxy solo cuando provienen de un proxy de confianza.
- El endpoint no constituye una API multiusuario: no tiene OAuth 2.1, no
  permite mutaciones ni expone las capturas o la colección privada. El 29 de
  agosto se comprobó `GET /healthz` en `https://mcp.tcg-pocket.xyz/healthz`
  con respuesta HTTP 200.

### Sitio web

- Se añadió una landing estática de Cloudflare Pages con favicon, imagen Open
  Graph, `robots.txt`, `sitemap.xml`, y páginas de privacidad y términos.
- El 29 de agosto se comprobó `https://tcg-pocket.xyz/` con respuesta HTTP 200. Esta comprobación acredita disponibilidad en ese momento, no un SLA.

### Núcleo de colección y captura

- Se extrajeron las reglas de colección y de rondas de captura a módulos de
  dominio independientes del adaptador MCP. Las herramientas conservan su
  interfaz observada y actúan como adaptadores delgados.
- Se protegió la finalización de ronda para que lectura, planificación y
  escritura ocurran dentro de la misma transacción inmediata de SQLite. En
  modo `minimum` se preservan cantidades locales mayores cuando hay procesos
  MCP concurrentes.
- La mutación de cantidades se centralizó y se cubrió el caso de decremento;
  se corrigió además la presentación de los números de carta no confirmados
  en el estado de una ronda.
- Se añadieron `OwnedRepository`, `RoundsRepository` y `CardsRepository`,
  moviendo SQL gradualmente detrás de interfaces de repositorio sin una
  reescritura de la aplicación.
- Antes de una migración sobre una base que ya contiene datos se genera una
  copia consistente con `better-sqlite3.backup()`/`VACUUM INTO`; nunca se debe
  copiar solo el archivo `.db` si existe un WAL activo.

### Integraciones y calidad

- Se validan con Zod las respuestas HTTP no confiables de TCGdex y de las
  fuentes remotas. Una respuesta HTTP 200 sin los campos exigidos ya no se
  acepta como un enriquecimiento correcto.
- Se ampliaron las pruebas para dominio, repositorios, migración/backup,
  transporte HTTP, guardias, validación remota y servidor MCP. La verificación
  actual registrada es `npm run verify` con 60 pruebas, más `npm audit
--omit=dev` sin vulnerabilidades de producción.
- Se reforzaron `.gitignore`, ejemplos de entorno, la arquitectura, roadmap,
  análisis de huecos de código abierto, documentación de seguridad y handoff.
  La carpeta local `.backups/` queda ahora excluida explícitamente.

### Límites que continúan vigentes

- El paquete npm permanece marcado como `private`; no hay publicación npm,
  registro MCP ni lanzamiento de un paquete de escritorio.
- Un bundle para Claude Desktop (`.mcpb`) está pendiente. `.dxt` es un nombre
  obsoleto y no debe generarse como segundo artefacto.
- Supabase fue aprovisionado fuera de este repositorio, pero no se ha
  integrado en el código ni se ha migrado la colección local.
- La exactitud OCR, los derechos y estabilidad de fuentes externas, OAuth,
  restauración dentro del MCP, telemetría y una política de redacción de logs
  siguen siendo trabajo pendiente.
