import type {
  IncomingMessage,
  RequestListener,
  ServerResponse,
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { logger } from "../logger.js";
import { createMcpServer, REMOTE_TOOL_NAMES } from "../server/factory.js";
import type { HttpConfig } from "./config.js";
import {
  BodyTimeoutError,
  BodyTooLargeError,
  bearerToken,
  isHostAllowed,
  isOriginAllowed,
  readJsonBody,
  redactHeaders,
  verifyToken,
} from "./guards.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";

const MCP_PATH = "/mcp";
const HEALTH_PATH = "/healthz";

type JsonRpcErrorBody = {
  jsonrpc: "2.0";
  error: { code: number; message: string };
  id: null;
};

function jsonRpcError(code: number, message: string): JsonRpcErrorBody {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  for (const [key, value] of Object.entries(extraHeaders))
    res.setHeader(key, value);
  res.end(JSON.stringify(body));
}

function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    // Caddy elimina cualquier valor entrante y establece este header con la
    // IP remota. Usamos el último valor por defensa adicional si otro proxy
    // fiable añadiese la cabecera a una cadena existente.
    return forwarded.split(",").at(-1)?.trim() || "";
  }
  return req.socket.remoteAddress ?? "";
}

async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  config: HttpConfig,
): Promise<void> {
  if (!isHostAllowed(req.headers.host, config.allowedHosts)) {
    writeJson(res, 403, jsonRpcError(-32000, "Host no permitido"));
    return;
  }
  if (!isOriginAllowed(req.headers.origin, config.allowedOrigins)) {
    writeJson(res, 403, jsonRpcError(-32000, "Origin no permitido"));
    return;
  }
  const token = bearerToken(req.headers.authorization);
  if (!verifyToken(token, config.token)) {
    res.setHeader("WWW-Authenticate", "Bearer");
    writeJson(res, 401, jsonRpcError(-32001, "No autorizado"));
    return;
  }

  let body: Buffer;
  try {
    body = await readJsonBody(
      req,
      config.bodyLimitBytes,
      config.requestTimeoutMs,
    );
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      // El body ya fue destruido por readJsonBody; el socket queda inservible.
      res.setHeader("Connection", "close");
      writeJson(res, 413, jsonRpcError(-32000, "Cuerpo demasiado grande"));
      return;
    }
    if (err instanceof BodyTimeoutError) {
      res.setHeader("Connection", "close");
      writeJson(res, 408, jsonRpcError(-32000, "Tiempo de espera agotado"));
      return;
    }
    throw err;
  }

  let parsedBody: unknown = undefined;
  if (body.length > 0) {
    try {
      parsedBody = JSON.parse(body.toString("utf8"));
    } catch {
      writeJson(res, 400, jsonRpcError(-32700, "JSON inválido"));
      return;
    }
  }

  const server = createMcpServer({ include: REMOTE_TOOL_NAMES });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

export function createHttpApp(config: HttpConfig): RequestListener {
  const rateLimiter = new FixedWindowRateLimiter({
    windowMs: config.rateLimitWindowMs,
    maxRequests: config.rateLimitMax,
    maxKeys: config.rateLimitMaxKeys,
  });
  return (req, res) => {
    const start = Date.now();
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    const path = url.split("?")[0];

    res.on("finish", () => {
      logger.info(
        {
          method,
          path,
          status: res.statusCode,
          ms: Date.now() - start,
          ip: clientIp(req),
          headers: redactHeaders(req.headers),
        },
        "http request",
      );
    });

    if (path === HEALTH_PATH) {
      if (method !== "GET" && method !== "HEAD") {
        res.statusCode = 405;
        res.setHeader("Allow", "GET, HEAD");
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end("ok\n");
      return;
    }

    if (path === MCP_PATH) {
      const ip = clientIp(req);
      if (!rateLimiter.allow(ip)) {
        res.setHeader("Retry-After", String(rateLimiter.retryAfterSeconds(ip)));
        writeJson(res, 429, jsonRpcError(-32000, "Demasiadas peticiones"));
        return;
      }
      if (method === "POST" || method === "GET") {
        handleMcp(req, res, config).catch((err) => {
          logger.error({ err }, "http mcp handler failed");
          if (!res.headersSent) {
            writeJson(res, 500, jsonRpcError(-32000, "Error interno"));
          } else {
            res.end();
          }
        });
        return;
      }
      res.setHeader("Allow", "GET, POST");
      writeJson(res, 405, jsonRpcError(-32000, "Método HTTP no soportado"));
      return;
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("not found\n");
  };
}
