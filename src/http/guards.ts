import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, IncomingHttpHeaders } from "node:http";

export const BEARER_PREFIX = "Bearer ";

/**
 * Extrae el token de una cabecera `Authorization: Bearer <token>`. Devuelve
 * null cuando falta la cabecera, viene con otro esquema o el token está vacío.
 */
export function bearerToken(
  header: string | string[] | undefined,
): string | null {
  if (typeof header !== "string") return null;
  if (!header.startsWith(BEARER_PREFIX)) return null;
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Comparación de token resistente a timing. Cuando las longitudes no coinciden
 * se comparan hashes SHA-256 de ambos lados para no revelar la diferencia por
 * un early return.
 */
export function verifyToken(
  candidate: string | null,
  expected: string,
): boolean {
  if (candidate === null) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    const ha = createHash("sha256").update(a).digest();
    const hb = createHash("sha256").update(b).digest();
    timingSafeEqual(ha, hb);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * `Host` sin puerto (IPv4 e IPv6 con corchetes). Devuelve null si no puede
 * interpretarse.
 */
function hostname(headerValue: string): string | null {
  const raw = headerValue.trim().toLowerCase();
  if (!raw) return null;
  if (raw.startsWith("[")) {
    const closing = raw.indexOf("]");
    return closing > 0 ? raw.slice(1, closing) : null;
  }
  const colon = raw.indexOf(":");
  return colon >= 0 ? raw.slice(0, colon) : raw;
}

export function isHostAllowed(
  headerValue: string | string[] | undefined,
  allowed: ReadonlySet<string>,
): boolean {
  if (typeof headerValue !== "string") return false;
  const host = hostname(headerValue);
  if (!host) return false;
  return allowed.has(host);
}

/**
 * `Origin` opcional: cuando la lista de orígenes permitidos está vacía se
 * acepta solo si el request llega sin cabecera Origin (clientes server-to-server
 * y Inspector CLI). Cualquier Origin cross-site se rechaza.
 */
export function isOriginAllowed(
  headerValue: string | string[] | undefined,
  allowed: ReadonlySet<string>,
): boolean {
  if (headerValue === undefined) return true;
  if (typeof headerValue !== "string") return false;
  const origin = headerValue.trim().toLowerCase();
  if (!origin) return true;
  return allowed.has(origin);
}

export class BodyTooLargeError extends Error {
  constructor() {
    super("Cuerpo de la petición supera el límite configurado.");
    this.name = "BodyTooLargeError";
  }
}

export class BodyTimeoutError extends Error {
  constructor() {
    super("Cuerpo de la petición no completado a tiempo.");
    this.name = "BodyTimeoutError";
  }
}

/**
 * Lee el cuerpo de un `IncomingMessage` acumulando chunks. Aborta con
 * `BodyTooLargeError` si supera `limitBytes` y con `BodyTimeoutError` si supera
 * `timeoutMs` sin cerrar. Devuelve un Buffer bruto; el parseo JSON lo hace el
 * transport.
 */
export function readJsonBody(
  req: IncomingMessage,
  limitBytes: number,
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    let received = 0;
    const chunks: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      rejectPromise(new BodyTimeoutError());
    }, timeoutMs);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const onData = (chunk: Buffer): void => {
      if (settled) return;
      received += chunk.length;
      if (received > limitBytes) {
        finish(() => {
          // No destruimos el socket aquí: dejamos que el handler HTTP escriba
          // la respuesta de error y sea el `res.end()` (con Connection: close)
          // el que cierre. Solo detenemos la lectura del cuerpo.
          req.off("data", onData);
          req.pause();
          rejectPromise(new BodyTooLargeError());
        });
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.on("end", () => finish(() => resolvePromise(Buffer.concat(chunks))));
    req.on("error", (err) => finish(() => rejectPromise(err)));
  });
}

const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "set-cookie"]);

/**
 * Copia headers reemplazando los sensibles por `"[redacted]"`. Nunca muta el
 * objeto original.
 */
export function redactHeaders(
  headers: IncomingHttpHeaders,
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? "[redacted]" : value;
  }
  return out;
}
