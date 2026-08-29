#!/usr/bin/env node
// Prepara desktop-extension/build/ con:
//   - manifest.json
//   - package.json (runtime aislado, sin devDependencies)
//   - dist/ (solo el servidor stdio; sin tests ni smokes ni HTTP CLI script)
//   - node_modules/ con binarios precompilados para win32-x64
//
// No compila el proyecto principal: hazlo antes con `npm run build` o encadena
// desde el script mcpb:build del package.json raíz.
//
// Uso:
//   node desktop-extension/scripts/build.mjs

import { execSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = resolve(here, "..");
const repoRoot = resolve(extensionDir, "..");
const buildDir = join(extensionDir, "build");
const distSrc = join(repoRoot, "dist");

if (!existsSync(distSrc)) {
  console.error(
    "[mcpb:build] Falta dist/. Ejecuta `npm run build` antes que este script.",
  );
  process.exit(1);
}

console.log(`[mcpb:build] Limpiando ${buildDir}`);
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });

// Copiar dist/ sin tests, sin scripts internos y sin el binario HTTP.
const distDst = join(buildDir, "dist");
const excludedDirs = new Set(["tests", "scripts"]);
const excludedFiles = new Set(["http.js"]);
cpSync(distSrc, distDst, {
  recursive: true,
  filter: (src) => {
    const rel = src.slice(distSrc.length + 1);
    if (!rel) return true;
    const [top, ...rest] = rel.split(/[\\/]/);
    if (excludedDirs.has(top)) return false;
    if (rest.length === 0 && excludedFiles.has(top)) return false;
    return true;
  },
});

// Copiar manifest.json literal.
cpSync(join(extensionDir, "manifest.json"), join(buildDir, "manifest.json"));

// Copiar runtime-package.json como package.json del bundle.
const runtimePkg = JSON.parse(
  readFileSync(join(extensionDir, "runtime-package.json"), "utf8"),
);
writeFileSync(
  join(buildDir, "package.json"),
  JSON.stringify(runtimePkg, null, 2) + "\n",
);

// Incluir LICENSE y README de la extensión si existen.
for (const asset of ["LICENSE"]) {
  const src = join(repoRoot, asset);
  if (existsSync(src)) cpSync(src, join(buildDir, asset));
}
for (const asset of ["README.md"]) {
  const src = join(extensionDir, asset);
  if (existsSync(src)) cpSync(src, join(buildDir, asset));
}

console.log(
  "[mcpb:build] Instalando dependencias runtime (Windows x64 prebuilds)…",
);
// --os/--cpu/--libc fuerzan a npm 10+ a descargar los optional deps de sharp
// (@img/sharp-win32-x64, @img/sharp-libvips-win32-x64) y el prebuild de
// better-sqlite3 correcto para Windows x64. Requiere npm >=10.
execSync(
  "npm install --omit=dev --no-audit --no-fund --loglevel=error --os=win32 --cpu=x64 --libc=",
  { cwd: buildDir, stdio: "inherit" },
);

// No hay lockfile propio del bundle: bórralo si npm lo generó para mantener
// el artefacto limpio (los rangos vienen fijados por runtime-package.json).
const lockfile = join(buildDir, "package-lock.json");
if (existsSync(lockfile)) rmSync(lockfile);

console.log(`[mcpb:build] Listo. Contenido preparado en ${buildDir}`);
