import assert from "node:assert/strict";
import test from "node:test";
import { computeQuantity, parseNumbers } from "../domain/collection.js";

test("computeQuantity fija el valor en modo set y nunca baja de 0", () => {
  assert.equal(computeQuantity(0, 7, "set"), 7);
  assert.equal(computeQuantity(9, 2, "set"), 2);
  assert.equal(computeQuantity(5, -3, "set"), 0);
});

test("computeQuantity acumula deltas en modo add con suelo en 0", () => {
  assert.equal(computeQuantity(0, 4, "add"), 4);
  assert.equal(computeQuantity(3, 2, "add"), 5);
  assert.equal(computeQuantity(3, -2, "add"), 1);
  assert.equal(computeQuantity(3, -10, "add"), 0);
});

test("parseNumbers expande rangos y ordena sin duplicados", () => {
  assert.deepEqual(parseNumbers("1,3,7-9"), [1, 3, 7, 8, 9]);
  assert.deepEqual(parseNumbers("5,1,1,3-4,2"), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseNumbers("7 - 9"), [7, 8, 9]);
});

test("parseNumbers ignora partes vacías y espacios", () => {
  assert.deepEqual(parseNumbers("1, ,2,"), [1, 2]);
});

test("parseNumbers rechaza tokens y rangos inválidos", () => {
  assert.throws(() => parseNumbers("1,a"), /Token inválido/);
  assert.throws(() => parseNumbers("5-1"), /Rango inválido/);
  assert.throws(() => parseNumbers("1-600"), /Rango inválido/);
});
