import { fail, type DomainError } from "./errors.js";

/**
 * Framework-free capture-round rules. These functions decide *what* should
 * happen given plain data; they never touch SQLite, MCP or Zod. The tool
 * adapter reads the current state, calls one of these to obtain a plan (or a
 * {@link DomainError}), and applies the plan transactionally.
 */

export type QuantityMode = "minimum" | "exact";
export type RoundCardState = "owned" | "missing";

/** One reviewed/detected observation for a card inside a round. */
export interface RoundObservation {
  card_number: number;
  state: RoundCardState;
  quantity: number | null;
  confidence: number;
  confirmed: boolean;
  source: string | null;
}

/** Minimal per-card shape needed to summarize a round's validation state. */
export interface RoundValidationCard {
  card_number: number;
  state: RoundCardState;
  confirmed: boolean;
}

export interface RoundValidationSummary {
  missing_count: number;
  implied_owned_unique: number;
  expected_owned_unique: number | null;
  counts_match: boolean | null;
  unconfirmed: number[];
}

/**
 * Validates the header count supplied when starting a round. Existence of the
 * expansion and an empty catalog are infrastructure checks that stay in the
 * adapter; this only enforces the "cannot own more than the catalog holds" rule.
 */
export function validateRoundStart(
  expected_total: number,
  expected_owned_unique: number | undefined,
  expansion_id: string,
): DomainError | null {
  if (
    expected_owned_unique !== undefined &&
    expected_owned_unique > expected_total
  ) {
    return fail(
      `expected_owned_unique=${expected_owned_unique} supera las ${expected_total} cartas del catálogo para ${expansion_id}.`,
    );
  }
  return null;
}

/** Confirmed observation to upsert after {@link planRecord}. */
export interface RecordUpsert {
  card_number: number;
  state: RoundCardState;
  quantity: number;
}

export interface RecordPlan {
  ok: true;
  upserts: RecordUpsert[];
  confirmed_missing: number;
  confirmed_owned: number;
}

export interface RecordInput {
  quantity_mode: QuantityMode;
  expansion_id: string;
  /** Numbers confirmed as gaps (already parsed and de-duplicated). */
  missing: number[];
  /** Numbers confirmed as owned (OCR false positives corrected by review). */
  owned: number[];
  quantities: { number: number; quantity: number }[];
  valid_numbers: Set<number>;
}

/**
 * Validates a manual review and returns the confirmed upserts to persist, or a
 * {@link DomainError} describing the first inconsistency found. Does not mutate
 * the collection.
 */
export function planRecord(input: RecordInput): RecordPlan | DomainError {
  const {
    quantity_mode,
    expansion_id,
    missing,
    owned,
    quantities,
    valid_numbers,
  } = input;

  if (!missing.length && !owned.length && !quantities.length) {
    return fail("Indica missing_numbers, owned_numbers o quantities.");
  }

  const missingSet = new Set(missing);
  const ownedSet = new Set(owned);
  for (const item of quantities) ownedSet.add(item.number);

  const overlap = [...missingSet].filter((number) => ownedSet.has(number));
  if (overlap.length) {
    return fail(
      `Números contradictorios como owned y missing: ${overlap.join(", ")}`,
    );
  }

  const invalid = [...missingSet, ...ownedSet].filter(
    (number) => !valid_numbers.has(number),
  );
  if (invalid.length) {
    return fail(
      `Números fuera de ${expansion_id}: ${[...new Set(invalid)].join(", ")}`,
    );
  }

  const quantityMap = new Map(
    quantities.map((item) => [item.number, item.quantity]),
  );
  if (quantity_mode === "exact") {
    const withoutQuantity = [...ownedSet].filter(
      (number) => !quantityMap.has(number),
    );
    if (withoutQuantity.length) {
      return fail(
        `El modo exact requiere quantity para: ${withoutQuantity.join(", ")}`,
      );
    }
  }

  const upserts: RecordUpsert[] = [];
  for (const number of missingSet) {
    upserts.push({ card_number: number, state: "missing", quantity: 0 });
  }
  for (const number of ownedSet) {
    upserts.push({
      card_number: number,
      state: "owned",
      quantity: quantityMap.get(number) ?? 1,
    });
  }

  return {
    ok: true,
    upserts,
    confirmed_missing: missingSet.size,
    confirmed_owned: ownedSet.size,
  };
}

/** Detection carried by an analyzed screenshot, reduced to what rules need. */
export interface Detection {
  number: number;
  confidence: number;
}

export interface AnalyzedImageDetections {
  path: string;
  detected_missing: Detection[];
}

export interface DetectionContradiction {
  number: number;
  confirmed_state: string;
  source: string;
}

export interface DetectionUpsert {
  card_number: number;
  confidence: number;
  source: string;
}

export interface ClassifiedDetections {
  contradictions: DetectionContradiction[];
  upserts: DetectionUpsert[];
}

/**
 * Splits OCR detections into contradictions (numbers already confirmed as
 * owned by a human review, which the OCR must not override) and upserts (new
 * or still-unconfirmed gaps). The confirmed-owned set is fixed for the whole
 * analysis because detections only ever write unconfirmed 'missing' rows.
 */
export function classifyDetections(
  confirmed_owned: Set<number>,
  images: AnalyzedImageDetections[],
): ClassifiedDetections {
  const contradictions: DetectionContradiction[] = [];
  const upserts: DetectionUpsert[] = [];
  for (const image of images) {
    for (const detection of image.detected_missing) {
      if (confirmed_owned.has(detection.number)) {
        contradictions.push({
          number: detection.number,
          confirmed_state: "owned",
          source: image.path,
        });
      } else {
        upserts.push({
          card_number: detection.number,
          confidence: detection.confidence,
          source: image.path,
        });
      }
    }
  }
  return { contradictions, upserts };
}

/**
 * Recomputes the validation block shown by the status tool: how many gaps are
 * reviewed, the implied owned-unique count, whether it matches the header, and
 * which cards are still unconfirmed.
 */
export function summarizeRoundValidation(
  expected_total: number,
  expected_owned_unique: number | null,
  cards: RoundValidationCard[],
): RoundValidationSummary {
  const missingCount = cards.filter((card) => card.state === "missing").length;
  const impliedOwned = expected_total - missingCount;
  return {
    missing_count: missingCount,
    implied_owned_unique: impliedOwned,
    expected_owned_unique,
    counts_match:
      expected_owned_unique === null
        ? null
        : impliedOwned === expected_owned_unique,
    unconfirmed: cards
      .filter((card) => !card.confirmed)
      .map((card) => card.card_number),
  };
}

/** A single owned/audit write produced by {@link planFinalize}. */
export interface FinalizeWrite {
  card_number: number;
  card_id: string;
  previous: number;
  applied: number;
  state: RoundCardState;
  source: string;
}

export interface FinalizePlan {
  ok: true;
  expected_owned_unique: number;
  missing_count: number;
  changed: number;
  preserved_higher_quantities: number;
  excluded_auto_detections: number[];
  writes: FinalizeWrite[];
}

export interface FinalizeInput {
  expansion_id: string;
  expected_total: number;
  quantity_mode: QuantityMode;
  /** Header count resolved from the finalize argument or the stored round. */
  expected_owned_unique: number | null;
  observations: RoundObservation[];
  use_auto_detections: boolean;
  /** Every card number of the expansion, ascending. */
  expansion_numbers: number[];
  /** Current owned quantity per card number (defaults to 0 when absent). */
  previous_quantities: Map<number, number>;
}

/**
 * Reconciles a round against its header count and, if it balances, produces the
 * full list of owned writes to apply. Returns a {@link DomainError} (leaving the
 * collection untouched) when the counts do not match, confidence is too low, or
 * exact mode lacks explicit quantities.
 */
export function planFinalize(input: FinalizeInput): FinalizePlan | DomainError {
  const {
    expansion_id,
    expected_total,
    quantity_mode,
    expected_owned_unique,
    observations,
    use_auto_detections,
    expansion_numbers,
    previous_quantities,
  } = input;

  if (expected_owned_unique === null) {
    return fail(
      "Falta expected_owned_unique. Lee y suma los contadores de la cabecera de la expansión.",
    );
  }
  if (expected_owned_unique > expected_total) {
    return fail("expected_owned_unique supera el total de la expansión.");
  }

  const excludedAuto = observations.filter(
    (item) => !item.confirmed && !use_auto_detections,
  );
  const lowConfidence = observations.filter(
    (item) => !item.confirmed && use_auto_detections && item.confidence < 0.84,
  );
  if (lowConfidence.length) {
    return fail(
      `OCR con confianza insuficiente; confirma manualmente: ${lowConfidence
        .map((item) => item.card_number)
        .join(", ")}`,
    );
  }

  const usable = observations.filter(
    (item) => item.confirmed || use_auto_detections,
  );
  const missing = new Set(
    usable
      .filter((item) => item.state === "missing")
      .map((item) => item.card_number),
  );
  const impliedOwned = expected_total - missing.size;
  if (impliedOwned !== expected_owned_unique) {
    return fail(
      `La ronda no cuadra: catálogo=${expected_total}, huecos=${missing.size}, poseídas implícitas=${impliedOwned}, ` +
        `pero la cabecera indica ${expected_owned_unique}. Faltan ${Math.abs(impliedOwned - expected_owned_unique)} huecos por revisar.`,
    );
  }

  if (quantity_mode === "exact") {
    const explicitOwned = usable.filter(
      (item) => item.state === "owned" && item.quantity !== null,
    );
    if (explicitOwned.length !== expected_owned_unique) {
      return fail(
        `El modo exact necesita cantidades explícitas para las ${expected_owned_unique} cartas poseídas; hay ${explicitOwned.length}.`,
      );
    }
  }

  const observationMap = new Map(
    usable.map((item) => [item.card_number, item]),
  );
  const writes: FinalizeWrite[] = [];
  let changed = 0;
  let preservedHigherQuantities = 0;
  for (const number of expansion_numbers) {
    const cardId = `${expansion_id}-${String(number).padStart(3, "0")}`;
    const previous = previous_quantities.get(number) ?? 0;
    const observation = observationMap.get(number);
    let applied: number;
    if (missing.has(number)) {
      applied = 0;
    } else if (quantity_mode === "exact") {
      applied = observation?.quantity ?? 0;
    } else {
      applied = Math.max(previous, observation?.quantity ?? 1);
      if (previous > 1 && applied === previous) preservedHigherQuantities++;
    }
    if (applied !== previous) changed++;
    writes.push({
      card_number: number,
      card_id: cardId,
      previous,
      applied,
      state: applied > 0 ? "owned" : "missing",
      source: observation?.source ?? "full-round-complement",
    });
  }

  return {
    ok: true,
    expected_owned_unique,
    missing_count: missing.size,
    changed,
    preserved_higher_quantities: preservedHigherQuantities,
    excluded_auto_detections: excludedAuto.map((item) => item.card_number),
    writes,
  };
}
