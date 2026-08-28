import pino from "pino";
import { resolveLogLevel } from "./config.js";

/**
 * MCP protocol messages use stdout. Keep operational logs structured and on
 * stderr so compatible clients never receive log lines as protocol data.
 */
export const logger = pino(
  {
    base: { service: "ptcgp-mcp-server" },
    level: resolveLogLevel(),
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination(2),
);
