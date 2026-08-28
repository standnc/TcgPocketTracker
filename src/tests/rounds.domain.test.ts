import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDetections,
  planFinalize,
  planRecord,
  summarizeRoundValidation,
  validateRoundStart,
  type RoundObservation,
} from "../domain/rounds.js";

function confirmedMissing(card_number: number): RoundObservation {
  return {
    card_number,
    state: "missing",
    quantity: 0,
    confidence: 1,
    confirmed: true,
    source: "confirmed-review",
  };
}

test("validateRoundStart bloquea un total poseído mayor que el catálogo", () => {
  const error = validateRoundStart(5, 6, "t1");
  assert.ok(error);
  assert.match(error.message, /supera las 5 cartas/);
  assert.equal(validateRoundStart(5, 5, "t1"), null);
  assert.equal(validateRoundStart(5, undefined, "t1"), null);
});

test("planFinalize resuelve la ronda válida de referencia (modo minimum)", () => {
  const plan = planFinalize({
    expansion_id: "t1",
    expected_total: 5,
    quantity_mode: "minimum",
    expected_owned_unique: 3,
    observations: [confirmedMissing(2), confirmedMissing(5)],
    use_auto_detections: false,
    expansion_numbers: [1, 2, 3, 4, 5],
    previous_quantities: new Map(),
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.missing_count, 2);
  assert.equal(plan.changed, 3);
  assert.equal(plan.preserved_higher_quantities, 0);
  assert.deepEqual(plan.excluded_auto_detections, []);
  assert.deepEqual(
    plan.writes.map((write) => write.applied),
    [1, 0, 1, 1, 0],
  );
  assert.deepEqual(
    plan.writes.map((write) => write.card_id),
    ["t1-001", "t1-002", "t1-003", "t1-004", "t1-005"],
  );
  assert.deepEqual(
    plan.writes.map((write) => write.state),
    ["owned", "missing", "owned", "owned", "missing"],
  );
  assert.equal(plan.writes[0].source, "full-round-complement");
});

test("planFinalize bloquea cuando el recuento no cuadra", () => {
  const plan = planFinalize({
    expansion_id: "t1",
    expected_total: 5,
    quantity_mode: "minimum",
    expected_owned_unique: 2,
    observations: [],
    use_auto_detections: false,
    expansion_numbers: [1, 2, 3, 4, 5],
    previous_quantities: new Map(),
  });
  assert.equal(plan.ok, false);
  if (plan.ok) return;
  assert.match(plan.message, /no cuadra/i);
  assert.match(plan.message, /Faltan 3 huecos/);
});

test("planFinalize exige expected_owned_unique y respeta el techo del catálogo", () => {
  const missing = planFinalize({
    expansion_id: "t1",
    expected_total: 5,
    quantity_mode: "minimum",
    expected_owned_unique: null,
    observations: [],
    use_auto_detections: false,
    expansion_numbers: [1, 2, 3, 4, 5],
    previous_quantities: new Map(),
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.message, /Falta expected_owned_unique/);

  const tooMany = planFinalize({
    expansion_id: "t1",
    expected_total: 5,
    quantity_mode: "minimum",
    expected_owned_unique: 6,
    observations: [],
    use_auto_detections: false,
    expansion_numbers: [1, 2, 3, 4, 5],
    previous_quantities: new Map(),
  });
  assert.equal(tooMany.ok, false);
  if (!tooMany.ok) assert.match(tooMany.message, /supera el total/);
});

test("planFinalize rechaza detecciones OCR de baja confianza cuando se autoaceptan", () => {
  const plan = planFinalize({
    expansion_id: "t1",
    expected_total: 5,
    quantity_mode: "minimum",
    expected_owned_unique: 4,
    observations: [
      {
        card_number: 2,
        state: "missing",
        quantity: 0,
        confidence: 0.5,
        confirmed: false,
        source: "auto",
      },
    ],
    use_auto_detections: true,
    expansion_numbers: [1, 2, 3, 4, 5],
    previous_quantities: new Map(),
  });
  assert.equal(plan.ok, false);
  if (!plan.ok) assert.match(plan.message, /confianza insuficiente/);
});

test("planFinalize sin auto excluye las detecciones no confirmadas del recuento", () => {
  const plan = planFinalize({
    expansion_id: "t1",
    expected_total: 5,
    quantity_mode: "minimum",
    expected_owned_unique: 4,
    observations: [
      {
        card_number: 2,
        state: "missing",
        quantity: 0,
        confidence: 0.9,
        confirmed: false,
        source: "auto",
      },
      confirmedMissing(5),
    ],
    use_auto_detections: false,
    expansion_numbers: [1, 2, 3, 4, 5],
    previous_quantities: new Map(),
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  // Solo el hueco confirmado (5) cuenta; el 2 auto queda excluido.
  assert.equal(plan.missing_count, 1);
  assert.deepEqual(plan.excluded_auto_detections, [2]);
});

test("planFinalize en modo minimum conserva cantidades superiores existentes", () => {
  const plan = planFinalize({
    expansion_id: "t1",
    expected_total: 2,
    quantity_mode: "minimum",
    expected_owned_unique: 1,
    observations: [confirmedMissing(2)],
    use_auto_detections: false,
    expansion_numbers: [1, 2],
    previous_quantities: new Map([[1, 3]]),
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.preserved_higher_quantities, 1);
  assert.equal(plan.changed, 0);
  assert.deepEqual(
    plan.writes.map((write) => write.applied),
    [3, 0],
  );
});

test("planFinalize en modo exact requiere cantidades explícitas por carta poseída", () => {
  const withoutQty = planFinalize({
    expansion_id: "t1",
    expected_total: 2,
    quantity_mode: "exact",
    expected_owned_unique: 1,
    observations: [
      {
        card_number: 1,
        state: "owned",
        quantity: null,
        confidence: 1,
        confirmed: true,
        source: "confirmed-review",
      },
      confirmedMissing(2),
    ],
    use_auto_detections: false,
    expansion_numbers: [1, 2],
    previous_quantities: new Map(),
  });
  assert.equal(withoutQty.ok, false);
  if (!withoutQty.ok) assert.match(withoutQty.message, /modo exact/);

  const withQty = planFinalize({
    expansion_id: "t1",
    expected_total: 2,
    quantity_mode: "exact",
    expected_owned_unique: 1,
    observations: [
      {
        card_number: 1,
        state: "owned",
        quantity: 3,
        confidence: 1,
        confirmed: true,
        source: "confirmed-review",
      },
      confirmedMissing(2),
    ],
    use_auto_detections: false,
    expansion_numbers: [1, 2],
    previous_quantities: new Map(),
  });
  assert.equal(withQty.ok, true);
  if (!withQty.ok) return;
  assert.deepEqual(
    withQty.writes.map((write) => write.applied),
    [3, 0],
  );
});

test("planRecord valida contradicciones, números fuera de rango y modo exact", () => {
  const valid = new Set([1, 2, 3, 4, 5]);

  const overlap = planRecord({
    quantity_mode: "minimum",
    expansion_id: "t1",
    missing: [2],
    owned: [2],
    quantities: [],
    valid_numbers: valid,
  });
  assert.equal(overlap.ok, false);
  if (!overlap.ok) assert.match(overlap.message, /contradictorios/);

  const invalid = planRecord({
    quantity_mode: "minimum",
    expansion_id: "t1",
    missing: [99],
    owned: [],
    quantities: [],
    valid_numbers: valid,
  });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.match(invalid.message, /fuera de t1/);

  const exact = planRecord({
    quantity_mode: "exact",
    expansion_id: "t1",
    missing: [],
    owned: [1],
    quantities: [],
    valid_numbers: valid,
  });
  assert.equal(exact.ok, false);
  if (!exact.ok) assert.match(exact.message, /modo exact requiere quantity/);

  const empty = planRecord({
    quantity_mode: "minimum",
    expansion_id: "t1",
    missing: [],
    owned: [],
    quantities: [],
    valid_numbers: valid,
  });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.match(empty.message, /Indica missing_numbers/);
});

test("planRecord construye los upserts confirmados con sus cantidades", () => {
  const plan = planRecord({
    quantity_mode: "minimum",
    expansion_id: "t1",
    missing: [2, 5],
    owned: [1],
    quantities: [{ number: 3, quantity: 2 }],
    valid_numbers: new Set([1, 2, 3, 4, 5]),
  });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.confirmed_missing, 2);
  assert.equal(plan.confirmed_owned, 2);
  assert.deepEqual(plan.upserts, [
    { card_number: 2, state: "missing", quantity: 0 },
    { card_number: 5, state: "missing", quantity: 0 },
    { card_number: 1, state: "owned", quantity: 1 },
    { card_number: 3, state: "owned", quantity: 2 },
  ]);
});

test("classifyDetections separa contradicciones de huecos a registrar", () => {
  const result = classifyDetections(new Set([3]), [
    {
      path: "a.png",
      detected_missing: [
        { number: 3, confidence: 0.9 },
        { number: 4, confidence: 0.8 },
      ],
    },
    { path: "b.png", detected_missing: [{ number: 3, confidence: 0.95 }] },
  ]);
  assert.deepEqual(result.contradictions, [
    { number: 3, confirmed_state: "owned", source: "a.png" },
    { number: 3, confirmed_state: "owned", source: "b.png" },
  ]);
  assert.deepEqual(result.upserts, [
    { card_number: 4, confidence: 0.8, source: "a.png" },
  ]);
});

test("summarizeRoundValidation calcula el cuadre y las cartas sin confirmar", () => {
  const balanced = summarizeRoundValidation(5, 3, [
    { card_number: 2, state: "missing", confirmed: true },
    { card_number: 5, state: "missing", confirmed: true },
  ]);
  assert.equal(balanced.counts_match, true);
  assert.equal(balanced.implied_owned_unique, 3);
  assert.deepEqual(balanced.unconfirmed, []);

  const pending = summarizeRoundValidation(5, 3, [
    { card_number: 2, state: "missing", confirmed: false },
  ]);
  assert.equal(pending.counts_match, false);
  assert.deepEqual(pending.unconfirmed, [2]);

  const noHeader = summarizeRoundValidation(5, null, []);
  assert.equal(noHeader.counts_match, null);
});
