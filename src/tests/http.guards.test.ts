import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import {
  bearerToken,
  BodyTimeoutError,
  BodyTooLargeError,
  isHostAllowed,
  isOriginAllowed,
  readJsonBody,
  redactHeaders,
  verifyToken,
} from "../http/guards.js";

test("bearerToken solo acepta el esquema Bearer", () => {
  assert.equal(bearerToken(undefined), null);
  assert.equal(bearerToken("Basic abc"), null);
  assert.equal(bearerToken("Bearer   "), null);
  assert.equal(bearerToken("Bearer token"), "token");
  assert.equal(bearerToken("Bearer  spaced "), "spaced");
});

test("verifyToken rechaza null y compara con longitud distinta sin filtrar", () => {
  const secret = randomBytes(32).toString("hex");
  assert.equal(verifyToken(null, secret), false);
  assert.equal(verifyToken("short", secret), false);
  const wrong = randomBytes(32).toString("hex");
  assert.equal(verifyToken(wrong, secret), false);
  assert.equal(verifyToken(secret, secret), true);
});

test("isHostAllowed extrae el host sin puerto y respeta la allowlist", () => {
  const allowed = new Set(["localhost", "127.0.0.1", "mcp.example"]);
  assert.equal(isHostAllowed(undefined, allowed), false);
  assert.equal(isHostAllowed("localhost:8787", allowed), true);
  assert.equal(isHostAllowed("MCP.EXAMPLE:443", allowed), true);
  assert.equal(isHostAllowed("evil.example", allowed), false);
  assert.equal(isHostAllowed("[::1]:8787", new Set(["::1"])), true);
});

test("isOriginAllowed acepta ausencia y bloquea cross-site cuando la lista está vacía", () => {
  const empty = new Set<string>();
  assert.equal(isOriginAllowed(undefined, empty), true);
  assert.equal(isOriginAllowed("https://evil.example", empty), false);
  const allowed = new Set(["https://claude.ai"]);
  assert.equal(isOriginAllowed("https://claude.ai", allowed), true);
  assert.equal(isOriginAllowed("https://evil.example", allowed), false);
});

test("readJsonBody rechaza cuerpos que superan el límite", async () => {
  const chunk = Buffer.alloc(64, "a");
  const stream = Readable.from([
    chunk,
    chunk,
    chunk,
  ]) as unknown as IncomingMessage;
  await assert.rejects(readJsonBody(stream, 100, 1000), BodyTooLargeError);
});

test("readJsonBody devuelve el buffer completo cuando cabe", async () => {
  const payload = Buffer.from(JSON.stringify({ hola: "mundo" }));
  const stream = Readable.from([payload]) as unknown as IncomingMessage;
  const received = await readJsonBody(stream, 1024, 1000);
  assert.deepEqual(JSON.parse(received.toString("utf8")), { hola: "mundo" });
});

test("readJsonBody aborta con timeout si el cuerpo no se completa", async () => {
  const stream = new Readable({ read() {} }) as unknown as IncomingMessage;
  await assert.rejects(readJsonBody(stream, 1024, 25), BodyTimeoutError);
});

test("redactHeaders reemplaza cabeceras sensibles sin mutar el original", () => {
  const headers = {
    host: "localhost",
    authorization: "Bearer secret",
    cookie: "session=xyz",
    "content-type": "application/json",
  };
  const redacted = redactHeaders(headers);
  assert.equal(redacted.authorization, "[redacted]");
  assert.equal(redacted.cookie, "[redacted]");
  assert.equal(redacted["content-type"], "application/json");
  assert.equal(headers.authorization, "Bearer secret");
});
