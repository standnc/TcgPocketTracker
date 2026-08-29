#!/usr/bin/env node
import { createServer } from "node:http";
import { getDb } from "./db.js";
import { createHttpApp } from "./http/app.js";
import { resolveHttpConfig } from "./http/config.js";
import { logger } from "./logger.js";
import { SERVER_VERSION } from "./server/factory.js";

async function main(): Promise<void> {
  const config = resolveHttpConfig();
  // Ejecuta migraciones antes de aceptar tráfico: así el primer POST no paga
  // el coste y los operadores ven cualquier error de esquema durante el
  // arranque en vez de en una petición real.
  getDb();
  const server = createServer(createHttpApp(config));

  const shutdown = (signal: string): void => {
    logger.info({ signal }, "MCP HTTP server shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => shutdown(signal));
  }

  await new Promise<void>((resolve) => {
    server.listen(config.port, config.host, () => {
      const address = server.address();
      const port =
        typeof address === "object" && address ? address.port : config.port;
      logger.info(
        {
          transport: "http",
          host: config.host,
          port,
          version: SERVER_VERSION,
        },
        "HTTP server ready",
      );
      resolve();
    });
  });
}

main().catch((error) => {
  logger.fatal({ err: error }, "MCP HTTP server failed to start");
  process.exit(1);
});
