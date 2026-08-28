import { getDb } from "./db.js";

const CARDS_URL =
  "https://raw.githubusercontent.com/chase-mew/pokemon-tcg-pocket-cards/refs/heads/main/data/v4/cards.json";
const EXPANSIONS_URL =
  "https://raw.githubusercontent.com/chase-mew/pokemon-tcg-pocket-cards/refs/heads/main/data/v4/expansions.json";

interface RawCard {
  id: string;
  name: string;
  rarity: string;
  pack: string;
  health: string;
  image: string;
  fullart: string;
  ex: string;
  artist: string;
  type: string;
}

interface RawExpansion {
  id: string;
  name: string;
  packs: { id: string; name: string; image: string }[];
}

export async function syncCatalog(): Promise<{
  cards: number;
  expansions: number;
  newCards: number;
}> {
  const [cardsRes, expsRes] = await Promise.all([
    fetch(CARDS_URL, { signal: AbortSignal.timeout(30_000) }),
    fetch(EXPANSIONS_URL, { signal: AbortSignal.timeout(30_000) }),
  ]);
  if (!cardsRes.ok || !expsRes.ok) {
    throw new Error(
      `Descarga fallida: cards=${cardsRes.status} expansions=${expsRes.status}. Reintenta o revisa conectividad.`,
    );
  }
  const cards = (await cardsRes.json()) as RawCard[];
  const expansions = (await expsRes.json()) as RawExpansion[];
  const expName = new Map(expansions.map((e) => [e.id, e.name]));

  const db = getDb();
  const before = (
    db.prepare("SELECT COUNT(*) AS n FROM cards").get() as { n: number }
  ).n;

  const upsertExp = db.prepare(
    "INSERT INTO expansions (id, name, packs) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, packs=excluded.packs",
  );
  const upsertCard = db.prepare(`
    INSERT INTO cards (id, name, expansion_id, expansion_name, number, rarity, pack, type, health, is_ex, is_fullart, artist, image)
    VALUES (@id, @name, @expansion_id, @expansion_name, @number, @rarity, @pack, @type, @health, @is_ex, @is_fullart, @artist, @image)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, expansion_name=excluded.expansion_name, rarity=excluded.rarity,
      pack=excluded.pack, type=excluded.type, health=excluded.health,
      is_ex=excluded.is_ex, is_fullart=excluded.is_fullart, artist=excluded.artist, image=excluded.image
  `);

  db.transaction(() => {
    for (const e of expansions) {
      upsertExp.run(e.id, e.name, JSON.stringify(e.packs.map((p) => p.name)));
    }
    for (const c of cards) {
      const dash = c.id.lastIndexOf("-");
      const expId = c.id.slice(0, dash);
      const num = parseInt(c.id.slice(dash + 1), 10);
      upsertCard.run({
        id: c.id,
        name: c.name,
        expansion_id: expId,
        expansion_name: expName.get(expId) ?? expId,
        number: Number.isNaN(num) ? 0 : num,
        rarity: c.rarity,
        pack: c.pack || null,
        type: c.type || null,
        health: c.health ? parseInt(c.health, 10) || null : null,
        is_ex: c.ex === "Yes" ? 1 : 0,
        is_fullart: c.fullart === "Yes" ? 1 : 0,
        artist: c.artist || null,
        image: c.image || null,
      });
    }
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('last_sync', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(new Date().toISOString());
  })();

  const after = (
    db.prepare("SELECT COUNT(*) AS n FROM cards").get() as { n: number }
  ).n;
  return {
    cards: after,
    expansions: expansions.length,
    newCards: after - before,
  };
}

function tcgdexId(localId: string): string {
  const dash = localId.lastIndexOf("-");
  const exp = localId.slice(0, dash);
  const num = localId.slice(dash + 1);
  const expMapped =
    exp === "pa"
      ? "P-A"
      : exp === "pb"
        ? "P-B"
        : exp.charAt(0).toUpperCase() + exp.slice(1);
  return `${expMapped}-${num}`;
}

function parseDamage(d: string | number | undefined): number {
  if (d === undefined || d === null) return 0;
  const m = String(d).match(/\d+/);
  return m ? parseInt(m[0], 10) : 0;
}

interface TcgdexCard {
  category?: string;
  stage?: string;
  evolveFrom?: string;
  suffix?: string;
  retreat?: number;
  effect?: string;
  attacks?: {
    name: string;
    cost?: string[];
    damage?: string | number;
    effect?: string;
  }[];
  abilities?: { name: string; type?: string; effect?: string }[];
  weaknesses?: { type: string; value: string }[];
}

export interface EnrichResult {
  enriched: number;
  skipped: number;
  not_found: number;
  errors: number;
  pending_total: number;
  pending_ids: string[];
}

export async function enrichCards(
  opts: {
    expansion?: string;
    force?: boolean;
    concurrency?: number;
    limit?: number;
  } = {},
): Promise<EnrichResult> {
  const db = getDb();
  const where: string[] = [];
  const args: Record<string, unknown> = {};
  if (!opts.force) where.push("enriched_at IS NULL");
  if (opts.expansion) {
    where.push("expansion_id = @exp");
    args.exp = opts.expansion.toLowerCase();
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  let ids = (
    db.prepare(`SELECT id FROM cards ${whereSql} ORDER BY id`).all(args) as {
      id: string;
    }[]
  ).map((r) => r.id);
  if (opts.limit) ids = ids.slice(0, opts.limit);

  const update = db.prepare(`
    UPDATE cards SET category=@category, stage=@stage, evolve_from=@evolve_from, suffix=@suffix,
      retreat=@retreat, effect=@effect, attacks=@attacks, abilities=@abilities,
      weaknesses=@weaknesses, max_damage=@max_damage, enriched_at=@enriched_at
    WHERE id=@id
  `);

  let enriched = 0,
    notFound = 0,
    errors = 0;
  const concurrency = opts.concurrency ?? 15;
  const queue = [...ids];

  async function fetchWithRetry(url: string): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (res.status === 429 || res.status >= 500) {
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
          continue;
        }
        return res;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
    throw lastErr ?? new Error("retries exhausted");
  }

  async function worker(): Promise<void> {
    while (queue.length) {
      const id = queue.shift();
      if (!id) return;
      try {
        const res = await fetchWithRetry(
          `https://api.tcgdex.net/v2/en/cards/${tcgdexId(id)}`,
        );
        if (res.status === 404) {
          notFound++;
          continue;
        }
        if (!res.ok) {
          errors++;
          continue;
        }
        const c = (await res.json()) as TcgdexCard;
        const maxDmg = Math.max(
          0,
          ...(c.attacks ?? []).map((a) => parseDamage(a.damage)),
        );
        update.run({
          id,
          category: c.category ?? null,
          stage: c.stage ?? null,
          evolve_from: c.evolveFrom ?? null,
          suffix: c.suffix ?? null,
          retreat: c.retreat ?? null,
          effect: c.effect ?? null,
          attacks: c.attacks?.length ? JSON.stringify(c.attacks) : null,
          abilities: c.abilities?.length ? JSON.stringify(c.abilities) : null,
          weaknesses: c.weaknesses?.length
            ? JSON.stringify(c.weaknesses)
            : null,
          max_damage: maxDmg || null,
          enriched_at: new Date().toISOString(),
        });
        enriched++;
      } catch {
        errors++;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const pendingSet = new Set(
    (
      db.prepare("SELECT id FROM cards WHERE enriched_at IS NULL").all() as {
        id: string;
      }[]
    ).map((row) => row.id),
  );
  const pendingIds = ids.filter((id) => pendingSet.has(id));
  const pending = (
    db
      .prepare("SELECT COUNT(*) AS n FROM cards WHERE enriched_at IS NULL")
      .get() as { n: number }
  ).n;
  return {
    enriched,
    skipped: 0,
    not_found: notFound,
    errors,
    pending_total: pending,
    pending_ids: pendingIds,
  };
}
