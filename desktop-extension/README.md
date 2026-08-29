# ptcgp-mcp-server · Desktop Extension (MCPB) para Windows

Empaquetado como **MCP Bundle (`.mcpb`)** siguiendo la especificación
[modelcontextprotocol/mcpb](https://github.com/modelcontextprotocol/mcpb)
(`manifest_version: 0.3`). Formato actual — no confundir con el antiguo `.dxt`.

**Objetivo declarado**: Claude Desktop en **Windows x64**. El artefacto se
construye con dependencias runtime resueltas para `--os=win32 --cpu=x64`.

## Qué contiene el bundle

Al ejecutar `npm run mcpb:build` se crea `desktop-extension/build/` con:

- `manifest.json` (MCPB 0.3)
- `dist/` — el servidor MCP stdio ya compilado (`dist/index.js`), sin tests,
  sin smoke scripts y sin `dist/http.js` (el bundle no expone el transporte HTTP)
- `package.json` runtime aislado (solo dependencias de producción)
- `node_modules/` con los binarios nativos de **better-sqlite3** y **sharp**
  descargados en su variante Windows x64 vía `npm install --os=win32 --cpu=x64`

Después, `npm run mcpb:pack` lo empaqueta en
`artifacts/ptcgp-mcp-server-desktop-extension.mcpb` (carpeta ignorada por git).

## Requisitos y limitaciones

- Cliente destino: **Claude Desktop for Windows** con soporte MCPB (versión reciente).
- La `manifest.compatibility.runtimes.node` declara `>=22 <25` (coherente con
  el `engines` del proyecto principal). Claude Desktop suele traer un Node
  embebido; si tu versión de Claude Desktop no lo trae o no cumple ese rango,
  el bundle no arrancará.
- **`better-sqlite3`** y **`sharp`** son dependencias nativas:
  - `better-sqlite3` incluye prebuilds Windows x64 vía `prebuild-install`.
  - `sharp` publica variantes por plataforma como optional deps
    (`@img/sharp-win32-x64`, `@img/sharp-libvips-win32-x64`). El flag
    `--os=win32 --cpu=x64` fuerza a npm 10+ a instalarlas incluso desde WSL/Linux.
  - El build **no compila desde fuentes** para Windows: si ni el prebuild ni el
    optional dep están disponibles, la instalación fallará ruidosamente y
    tendrás que reconstruir el bundle desde una máquina Windows con toolchain
    nativa. En ese caso este README quedaría desactualizado — abre un issue.
- **Este bundle solo se construye y valida desde WSL/Linux; su ejecución dentro
  de Claude Desktop en Windows no está verificada en este entorno.** Trátalo
  como un artefacto reproducible pero pendiente de prueba manual en Windows.
- El bundle **no incluye** `collection.db`, backups, capturas, tokens ni
  ningún dato personal. La primera vez que arranque creará la base SQLite
  vacía en el `PTCGP_DATA_DIR` que elijas en el diálogo de configuración de
  Claude Desktop.
- HEIC/HEIF sigue sin estar soportado por el build de Sharp usado; el bundle
  hereda esa limitación (ver README raíz).

## Configuración expuesta al usuario

Definida en `manifest.json` → `user_config`:

| Clave       | Tipo      | Requerido | Valor por defecto                 | Uso                                                                                                                         |
| ----------- | --------- | --------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `data_dir`  | directory | sí        | `${HOME}/AppData/Local/ptcgp-mcp` | Se pasa al proceso como `PTCGP_DATA_DIR`. Elige una carpeta que respaldes.                                                  |
| `log_level` | string    | no        | `info`                            | Se pasa como `PTCGP_LOG_LEVEL`. Uno de `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`. Se registra en stderr. |

En Windows, el valor por defecto se resuelve a algo como
`C:\Users\<tu-usuario>\AppData\Local\ptcgp-mcp`. Ese directorio contendrá
`collection.db` y la subcarpeta `backups/` que crea el propio servidor antes
de aplicar una migración con datos.

## Instalación en Claude Desktop (Windows)

1. Descarga o construye `artifacts/ptcgp-mcp-server-desktop-extension.mcpb`.
2. En Claude Desktop, ve a **Settings → Extensions** y arrastra el `.mcpb` a
   la ventana (o usa el botón _Install extension_ si tu build lo expone).
3. Cuando pida configuración, indica una carpeta segura para `PTCGP_DATA_DIR`
   (por ejemplo `C:\Users\<tu-usuario>\AppData\Local\ptcgp-mcp`). Deja
   `log_level` en `info` salvo que estés depurando.
4. Reinicia Claude Desktop si te lo pide. Al abrir un chat nuevo, las
   17 herramientas `ptcgp_*` deberían aparecer disponibles.

## Cómo desinstalarlo

- En Claude Desktop, **Settings → Extensions → Pokémon TCG Pocket → Remove**.
  Esto elimina el bundle desempaquetado del directorio de extensiones de
  Claude Desktop.
- Tus datos **no** se borran: siguen en la carpeta `PTCGP_DATA_DIR` que
  configuraste. Bórrala manualmente si quieres empezar de cero.

## Verificaciones ejecutables (desde WSL/Linux)

Desde la raíz del repositorio:

```bash
npm run build         # tsc → dist/
npm test              # suite Node test runner sobre PTCGP_DATA_DIR temporal
npm run smoke         # levanta stdio y lista tools contra base temporal
npm run mcpb:build    # dist + install runtime con prebuilds Windows x64
npm run mcpb:validate # npx @anthropic-ai/mcpb validate del manifest generado
npm run mcpb:pack     # produce artifacts/ptcgp-mcp-server-desktop-extension.mcpb
```

Lo que **no** se puede validar desde WSL en este entorno:

- Que Claude Desktop en Windows acepte e instale el `.mcpb`.
- Que los binarios nativos descargados para `win32-x64` realmente carguen en
  el Node embebido de Claude Desktop (versión concreta y ABI).
- Cualquier interacción real de las 17 herramientas dentro de la app.

Prueba manual mínima recomendada en Windows: instalar el bundle, abrir un
chat y pedirle a Claude que ejecute `ptcgp_list_expansions`. Si responde con
la lista vacía o con un error de SQLite, es que el `PTCGP_DATA_DIR` no es
escribible o el prebuild nativo no cargó — recogen `stderr` en los logs de
Claude Desktop.

## Alternativa rápida: puente WSL (sin bundle)

Si aún no quieres empaquetar y solo necesitas probar el servidor desde
Claude Desktop en Windows contra tu checkout de WSL, añade **manualmente** a
`%APPDATA%\Claude\claude_desktop_config.json` (yo no lo modifico por ti):

```json
{
  "mcpServers": {
    "ptcgp-wsl": {
      "command": "C:\\Windows\\System32\\wsl.exe",
      "args": [
        "-d",
        "kali-linux",
        "-u",
        "pedro",
        "--cd",
        "/home/pedro/proyectos/ptcgp-mcp-server",
        "--",
        "/home/pedro/.local/share/fnm/aliases/default/bin/node",
        "/home/pedro/proyectos/ptcgp-mcp-server/dist/index.js"
      ],
      "env": {}
    }
  }
}
```

Requisitos: haber ejecutado `npm run build` en el checkout de WSL para que
`dist/index.js` exista. `PTCGP_DATA_DIR` no se pasa aquí: el servidor caerá
en el valor por defecto de Linux (`/home/pedro/.local/share/ptcgp-mcp`, tu
base real). Si quieres apuntar a una base temporal para pruebas, añade
`"env": { "PTCGP_DATA_DIR": "/tmp/ptcgp-test" }`.

Este puente evita el bundle nativo pero **usa tu SQLite real** por defecto,
así que asegúrate de tener backups antes de tocar rondas o mutaciones.
