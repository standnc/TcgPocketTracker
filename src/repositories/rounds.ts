import { getDb } from "../db.js";

/** Connection type, derived from the single accessor so this port never imports
 * the better-sqlite3 module directly. */
type Db = ReturnType<typeof getDb>;

export type RoundStatus = "open" | "review" | "applied" | "cancelled";
export type QuantityMode = "minimum" | "exact";
export type RoundCardState = "owned" | "missing";

/** A `capture_rounds` row. */
export interface RoundRow {
  id: string;
  expansion_id: string;
  label: string | null;
  status: RoundStatus;
  quantity_mode: QuantityMode;
  expected_total: number;
  expected_owned_unique: number | null;
  created_at: string;
  updated_at: string;
  finalized_at: string | null;
  summary: string | null;
}

/** A `capture_round_cards` row, as read for finalize/observations. */
export interface RoundCardRow {
  card_number: number;
  state: RoundCardState;
  quantity: number | null;
  confidence: number;
  confirmed: number;
  source: string | null;
}

export interface NewRound {
  id: string;
  expansion_id: string;
  label: string | null;
  quantity_mode: QuantityMode;
  expected_total: number;
  expected_owned_unique: number | null;
  created_at: string;
  updated_at: string;
}

export interface RoundImageInsert {
  round_id: string;
  path: string;
  sha256: string;
  width: number;
  height: number;
  capture_order: number;
  analysis: string;
  created_at: string;
}

export interface DetectionInsert {
  round_id: string;
  card_number: number;
  confidence: number;
  source: string;
  updated_at: string;
}

export interface ConfirmedInsert {
  round_id: string;
  card_number: number;
  state: RoundCardState;
  quantity: number;
  updated_at: string;
}

export interface AuditInsert {
  round_id: string;
  card_number: number;
  state: RoundCardState;
  quantity: number;
  source: string;
  previous_quantity: number;
  applied_quantity: number;
  updated_at: string;
}

export interface MarkAppliedInput {
  round_id: string;
  expected_owned_unique: number;
  updated_at: string;
  finalized_at: string;
  summary: string;
}

/** A `capture_round_cards` row projected for the status/analyze responses,
 * with `card_number` aliased to `number` exactly as the tools emit it. */
export interface RoundCardView {
  number: number;
  state: RoundCardState;
  quantity: number | null;
  confidence: number;
  confirmed: number;
  source: string | null;
}

export interface RoundImageView {
  path: string;
  sha256: string;
  width: number;
  height: number;
  capture_order: number;
}

export interface DetectedMissingRow {
  number: number;
  confidence: number;
  confirmed: number;
  source: string | null;
}

export interface RoundListRow extends RoundRow {
  images: number;
  missing_detected: number;
  pending_review: number;
}

/**
 * Persistence port for the capture-round aggregate (`capture_rounds`,
 * `capture_round_images`, `capture_round_cards`). Rules live in the domain
 * (`src/domain/rounds.ts`); this port only reads and writes rows. Multi-step
 * writes are composed by the adapter inside a single transaction, so every
 * statement here runs on the shared connection.
 */
export interface RoundsRepository {
  create(round: NewRound): void;
  get(id: string): RoundRow | undefined;
  maxCaptureOrder(roundId: string): number;
  confirmedOwnedNumbers(roundId: string): Set<number>;
  insertImage(image: RoundImageInsert): void;
  upsertDetection(detection: DetectionInsert): void;
  detectedMissing(roundId: string): DetectedMissingRow[];
  upsertConfirmed(card: ConfirmedInsert): void;
  writeAudit(card: AuditInsert): void;
  setStatus(roundId: string, status: RoundStatus, updatedAt: string): void;
  markApplied(input: MarkAppliedInput): void;
  observations(roundId: string): RoundCardRow[];
  cards(roundId: string): RoundCardView[];
  images(roundId: string): RoundImageView[];
  listRecent(limit?: number): RoundListRow[];
}

export function createSqliteRoundsRepository(db: Db): RoundsRepository {
  const insertRound = db.prepare(`
    INSERT INTO capture_rounds
      (id, expansion_id, label, status, quantity_mode, expected_total, expected_owned_unique, created_at, updated_at)
    VALUES (@id, @expansion_id, @label, 'open', @quantity_mode, @expected_total, @expected_owned_unique, @created_at, @updated_at)
  `);
  const selectRound = db.prepare("SELECT * FROM capture_rounds WHERE id = ?");
  const selectMaxOrder = db.prepare(
    "SELECT COALESCE(MAX(capture_order), -1) AS n FROM capture_round_images WHERE round_id = ?",
  );
  const selectConfirmedOwned = db.prepare(
    "SELECT card_number FROM capture_round_cards WHERE round_id = ? AND confirmed = 1 AND state = 'owned'",
  );
  const upsertImage = db.prepare(`
    INSERT INTO capture_round_images
      (round_id, path, sha256, width, height, capture_order, analysis, created_at)
    VALUES (@round_id, @path, @sha256, @width, @height, @capture_order, @analysis, @created_at)
    ON CONFLICT(round_id, sha256) DO UPDATE SET
      path=excluded.path, width=excluded.width, height=excluded.height, analysis=excluded.analysis
  `);
  const upsertDetectionStmt = db.prepare(`
    INSERT INTO capture_round_cards
      (round_id, card_number, state, quantity, confidence, confirmed, source, updated_at)
    VALUES (@round_id, @card_number, 'missing', 0, @confidence, 0, @source, @updated_at)
    ON CONFLICT(round_id, card_number) DO UPDATE SET
      state=CASE WHEN capture_round_cards.confirmed=0 THEN 'missing' ELSE capture_round_cards.state END,
      quantity=CASE WHEN capture_round_cards.confirmed=0 THEN 0 ELSE capture_round_cards.quantity END,
      confidence=CASE WHEN capture_round_cards.confirmed=0 THEN MAX(capture_round_cards.confidence, excluded.confidence) ELSE capture_round_cards.confidence END,
      source=CASE WHEN capture_round_cards.confirmed=0 THEN excluded.source ELSE capture_round_cards.source END,
      updated_at=excluded.updated_at
  `);
  const selectDetectedMissing = db.prepare(`
    SELECT card_number AS number, confidence, confirmed, source
    FROM capture_round_cards WHERE round_id=? AND state='missing' ORDER BY card_number
  `);
  const upsertConfirmedStmt = db.prepare(`
    INSERT INTO capture_round_cards
      (round_id, card_number, state, quantity, confidence, confirmed, source, updated_at)
    VALUES (@round_id, @card_number, @state, @quantity, 1, 1, 'confirmed-review', @updated_at)
    ON CONFLICT(round_id, card_number) DO UPDATE SET
      state=excluded.state, quantity=excluded.quantity, confidence=1, confirmed=1,
      source=excluded.source, updated_at=excluded.updated_at
  `);
  const writeAuditStmt = db.prepare(`
    INSERT INTO capture_round_cards
      (round_id, card_number, state, quantity, confidence, confirmed, source, previous_quantity, applied_quantity, updated_at)
    VALUES (@round_id, @card_number, @state, @quantity, 1, 1, @source, @previous_quantity, @applied_quantity, @updated_at)
    ON CONFLICT(round_id, card_number) DO UPDATE SET
      state=excluded.state, quantity=excluded.quantity, confirmed=1,
      previous_quantity=excluded.previous_quantity, applied_quantity=excluded.applied_quantity,
      updated_at=excluded.updated_at
  `);
  const updateStatus = db.prepare(
    "UPDATE capture_rounds SET status=?, updated_at=? WHERE id=?",
  );
  const updateApplied = db.prepare(`
    UPDATE capture_rounds SET status='applied', expected_owned_unique=@expected_owned_unique,
      updated_at=@updated_at, finalized_at=@finalized_at, summary=@summary WHERE id=@round_id
  `);
  const selectObservations = db.prepare(`
    SELECT card_number, state, quantity, confidence, confirmed, source
    FROM capture_round_cards WHERE round_id=? ORDER BY card_number
  `);
  const selectCards = db.prepare(`
    SELECT card_number AS number, state, quantity, confidence, confirmed, source
    FROM capture_round_cards WHERE round_id=? ORDER BY card_number
  `);
  const selectImages = db.prepare(`
    SELECT path, sha256, width, height, capture_order FROM capture_round_images
    WHERE round_id=? ORDER BY capture_order
  `);
  const selectRecent = db.prepare(`
    SELECT r.*, COUNT(DISTINCT i.id) AS images,
      COUNT(DISTINCT CASE WHEN rc.state='missing' THEN rc.card_number END) AS missing_detected,
      COUNT(DISTINCT CASE WHEN rc.confirmed=0 THEN rc.card_number END) AS pending_review
    FROM capture_rounds r
    LEFT JOIN capture_round_images i ON i.round_id=r.id
    LEFT JOIN capture_round_cards rc ON rc.round_id=r.id
    GROUP BY r.id ORDER BY r.created_at DESC LIMIT ?
  `);

  return {
    create(round) {
      insertRound.run(round);
    },
    get(id) {
      return selectRound.get(id) as RoundRow | undefined;
    },
    maxCaptureOrder(roundId) {
      return (selectMaxOrder.get(roundId) as { n: number }).n;
    },
    confirmedOwnedNumbers(roundId) {
      return new Set(
        (selectConfirmedOwned.all(roundId) as { card_number: number }[]).map(
          (row) => row.card_number,
        ),
      );
    },
    insertImage(image) {
      upsertImage.run(image);
    },
    upsertDetection(detection) {
      upsertDetectionStmt.run(detection);
    },
    detectedMissing(roundId) {
      return selectDetectedMissing.all(roundId) as DetectedMissingRow[];
    },
    upsertConfirmed(card) {
      upsertConfirmedStmt.run(card);
    },
    writeAudit(card) {
      writeAuditStmt.run(card);
    },
    setStatus(roundId, status, updatedAt) {
      updateStatus.run(status, updatedAt, roundId);
    },
    markApplied(input) {
      updateApplied.run(input);
    },
    observations(roundId) {
      return selectObservations.all(roundId) as RoundCardRow[];
    },
    cards(roundId) {
      return selectCards.all(roundId) as RoundCardView[];
    },
    images(roundId) {
      return selectImages.all(roundId) as RoundImageView[];
    },
    listRecent(limit = 20) {
      return selectRecent.all(limit) as RoundListRow[];
    },
  };
}

let cached: RoundsRepository | null = null;

/** Process-wide {@link RoundsRepository} bound to the shared connection. */
export function roundsRepo(): RoundsRepository {
  if (!cached) cached = createSqliteRoundsRepository(getDb());
  return cached;
}
