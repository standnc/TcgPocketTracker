import { z } from "zod";

const csv = (raw: string): string[] =>
  raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

const httpEnvSchema = z
  .object({
    PTCGP_HTTP_HOST: z
      .string()
      .trim()
      .min(1, "PTCGP_HTTP_HOST no puede estar vacío")
      .optional(),
    PTCGP_HTTP_PORT: z
      .string()
      .trim()
      .regex(/^\d+$/, "PTCGP_HTTP_PORT debe ser un entero")
      .optional(),
    PTCGP_HTTP_TOKEN: z
      .string()
      .min(32, "PTCGP_HTTP_TOKEN debe tener al menos 32 caracteres"),
    PTCGP_HTTP_ALLOWED_HOSTS: z.string().optional(),
    PTCGP_HTTP_ALLOWED_ORIGINS: z.string().optional(),
    PTCGP_HTTP_BODY_LIMIT_KIB: z
      .string()
      .trim()
      .regex(/^\d+$/, "PTCGP_HTTP_BODY_LIMIT_KIB debe ser un entero")
      .optional(),
    PTCGP_HTTP_REQUEST_TIMEOUT_MS: z
      .string()
      .trim()
      .regex(/^\d+$/, "PTCGP_HTTP_REQUEST_TIMEOUT_MS debe ser un entero")
      .optional(),
    PTCGP_HTTP_RATE_LIMIT_MAX: z
      .string()
      .trim()
      .regex(/^\d+$/, "PTCGP_HTTP_RATE_LIMIT_MAX debe ser un entero")
      .optional(),
    PTCGP_HTTP_RATE_LIMIT_WINDOW_MS: z
      .string()
      .trim()
      .regex(/^\d+$/, "PTCGP_HTTP_RATE_LIMIT_WINDOW_MS debe ser un entero")
      .optional(),
    PTCGP_HTTP_RATE_LIMIT_MAX_KEYS: z
      .string()
      .trim()
      .regex(/^\d+$/, "PTCGP_HTTP_RATE_LIMIT_MAX_KEYS debe ser un entero")
      .optional(),
  })
  .passthrough();

export type HttpConfig = {
  host: string;
  port: number;
  token: string;
  allowedHosts: ReadonlySet<string>;
  allowedOrigins: ReadonlySet<string>;
  bodyLimitBytes: number;
  requestTimeoutMs: number;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  rateLimitMaxKeys: number;
};

export function resolveHttpConfig(
  env: NodeJS.ProcessEnv = process.env,
): HttpConfig {
  const parsed = httpEnvSchema.safeParse(env);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]?.message ?? "configuración inválida";
    throw new Error(`Configuración HTTP inválida: ${issue}.`);
  }
  const data = parsed.data;
  const port = data.PTCGP_HTTP_PORT
    ? Number.parseInt(data.PTCGP_HTTP_PORT, 10)
    : 8787;
  if (port < 0 || port > 65535)
    throw new Error(
      `Configuración HTTP inválida: PTCGP_HTTP_PORT fuera de rango (${port}).`,
    );
  const bodyLimitKib = data.PTCGP_HTTP_BODY_LIMIT_KIB
    ? Number.parseInt(data.PTCGP_HTTP_BODY_LIMIT_KIB, 10)
    : 1024;
  if (bodyLimitKib < 1)
    throw new Error(
      `Configuración HTTP inválida: PTCGP_HTTP_BODY_LIMIT_KIB debe ser >= 1.`,
    );
  const requestTimeoutMs = data.PTCGP_HTTP_REQUEST_TIMEOUT_MS
    ? Number.parseInt(data.PTCGP_HTTP_REQUEST_TIMEOUT_MS, 10)
    : 30000;
  if (requestTimeoutMs < 1000)
    throw new Error(
      `Configuración HTTP inválida: PTCGP_HTTP_REQUEST_TIMEOUT_MS debe ser >= 1000.`,
    );
  const rateLimitMax = data.PTCGP_HTTP_RATE_LIMIT_MAX
    ? Number.parseInt(data.PTCGP_HTTP_RATE_LIMIT_MAX, 10)
    : 60;
  if (rateLimitMax < 1)
    throw new Error(
      "Configuración HTTP inválida: PTCGP_HTTP_RATE_LIMIT_MAX debe ser >= 1.",
    );
  const rateLimitWindowMs = data.PTCGP_HTTP_RATE_LIMIT_WINDOW_MS
    ? Number.parseInt(data.PTCGP_HTTP_RATE_LIMIT_WINDOW_MS, 10)
    : 60_000;
  if (rateLimitWindowMs < 1000)
    throw new Error(
      "Configuración HTTP inválida: PTCGP_HTTP_RATE_LIMIT_WINDOW_MS debe ser >= 1000.",
    );
  const rateLimitMaxKeys = data.PTCGP_HTTP_RATE_LIMIT_MAX_KEYS
    ? Number.parseInt(data.PTCGP_HTTP_RATE_LIMIT_MAX_KEYS, 10)
    : 10_000;
  if (rateLimitMaxKeys < 1)
    throw new Error(
      "Configuración HTTP inválida: PTCGP_HTTP_RATE_LIMIT_MAX_KEYS debe ser >= 1.",
    );

  const allowedHosts = new Set(
    data.PTCGP_HTTP_ALLOWED_HOSTS
      ? csv(data.PTCGP_HTTP_ALLOWED_HOSTS)
      : ["localhost", "127.0.0.1"],
  );
  const allowedOrigins = new Set(
    data.PTCGP_HTTP_ALLOWED_ORIGINS ? csv(data.PTCGP_HTTP_ALLOWED_ORIGINS) : [],
  );

  return {
    host: data.PTCGP_HTTP_HOST ?? "127.0.0.1",
    port,
    token: data.PTCGP_HTTP_TOKEN,
    allowedHosts,
    allowedOrigins,
    bodyLimitBytes: bodyLimitKib * 1024,
    requestTimeoutMs,
    rateLimitMax,
    rateLimitWindowMs,
    rateLimitMaxKeys,
  };
}
