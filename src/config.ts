import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

const environmentSchema = z
  .object({
    PTCGP_DATA_DIR: z
      .string()
      .trim()
      .min(1, "PTCGP_DATA_DIR no puede estar vacío")
      .optional(),
    PTCGP_LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .optional(),
  })
  .passthrough();

/**
 * Returns the directory used for mutable local data. A relative override is
 * resolved against the process working directory so the resulting path is
 * always explicit in diagnostics and tests.
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const parsed = environmentSchema.safeParse(env);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]?.message ?? "configuración inválida";
    throw new Error(`Configuración inválida: ${issue}.`);
  }
  return resolve(
    parsed.data.PTCGP_DATA_DIR ??
      join(homedir(), ".local", "share", "ptcgp-mcp"),
  );
}

export function resolveLogLevel(
  env: NodeJS.ProcessEnv = process.env,
): z.infer<typeof environmentSchema>["PTCGP_LOG_LEVEL"] {
  const parsed = environmentSchema.safeParse(env);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]?.message ?? "configuración inválida";
    throw new Error(`Configuración inválida: ${issue}.`);
  }
  return parsed.data.PTCGP_LOG_LEVEL ?? "info";
}

export function dataDir(): string {
  return resolveDataDir();
}
