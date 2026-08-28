import { z } from "zod";
import { getDb } from "./db.js";
import { parseRemote } from "./remote-validation.js";

const UA = "Mozilla/5.0 (compatible; ptcgp-mcp/1.0; personal collection tool)";
const ENERGY: Record<string, string> = {
  G: "Grass",
  R: "Fire",
  W: "Water",
  L: "Lightning",
  P: "Psychic",
  F: "Fighting",
  D: "Darkness",
  M: "Metal",
  C: "Colorless",
};

export function limitlessSetId(exp: string): string {
  if (exp === "pa") return "P-A";
  if (exp === "pb") return "P-B";
  return exp.charAt(0).toUpperCase() + exp.slice(1);
}

async function fetchHtml(url: string): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  return null;
}

function strip(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&#?\w+;/g, (m) => {
      const map: Record<string, string> = {
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&quot;": '"',
        "&#039;": "'",
        "&nbsp;": " ",
      };
      return map[m] ?? "";
    })
    .replace(/\s+/g, " ")
    .trim();
}

interface ParsedCard {
  category: string | null;
  stage: string | null;
  evolve_from: string | null;
  retreat: number | null;
  effect: string | null;
  attacks: { name: string; cost: string[]; damage?: string; effect?: string }[];
  abilities: { name: string; type: string; effect: string }[];
  weaknesses: { type: string; value: string }[];
  max_damage: number;
}

export function parseLimitlessCard(html: string): ParsedCard {
  const out: ParsedCard = {
    category: null,
    stage: null,
    evolve_from: null,
    retreat: null,
    effect: null,
    attacks: [],
    abilities: [],
    weaknesses: [],
    max_damage: 0,
  };

  const typeM = html.match(/card-text-type">([\s\S]*?)<\/p>/);
  if (typeM) {
    const parts = strip(typeM[1]).split(/\s+-\s+/);
    out.category = parts[0]?.replace("Pokémon", "Pokemon") ?? null;
    if (parts[1]) {
      const st = parts[1].trim();
      out.stage = st === "Basic" ? "Basic" : st.replace(/\s+/g, "");
      if (
        out.stage !== "Basic" &&
        out.stage !== "Stage1" &&
        out.stage !== "Stage2" &&
        out.category === "Pokemon"
      ) {
        out.stage = st;
      }
    }
    const evo = strip(typeM[1]).match(/Evolves from\s+(.+)$/);
    if (evo) out.evolve_from = evo[1].trim();
    if (out.category !== "Pokemon" && parts[1]) out.stage = null;
    if (out.category === "Trainer" && parts[1]) out.effect = null;
  }

  for (const m of html.matchAll(
    /card-text-attack">[\s\S]*?card-text-attack-info">([\s\S]*?)<\/p>(?:[\s\S]*?card-text-attack-effect">([\s\S]*?)<\/p>)?/g,
  )) {
    const info = m[1];
    const costM = info.match(/ptcg-symbol">([A-Z]*)<\/span>/);
    const cost = costM ? [...costM[1]].map((c) => ENERGY[c] ?? c) : [];
    const rest = strip(
      info.replace(/<span class="ptcg-symbol">[^<]*<\/span>/, ""),
    );
    const dmgM = rest.match(/^(.*?)\s+(\d+[+x×]?)$/);
    const name = dmgM ? dmgM[1] : rest;
    const damage = dmgM ? dmgM[2] : undefined;
    const effect = m[2] ? strip(m[2]) : undefined;
    out.attacks.push({
      name,
      cost,
      ...(damage ? { damage } : {}),
      ...(effect ? { effect } : {}),
    });
    const n = damage ? parseInt(damage, 10) : 0;
    if (n > out.max_damage) out.max_damage = n;
  }

  for (const m of html.matchAll(
    /card-text-ability">[\s\S]*?card-text-ability-info">([\s\S]*?)<\/p>[\s\S]*?card-text-ability-effect">([\s\S]*?)<\/p>/g,
  )) {
    out.abilities.push({
      name: strip(m[1]).replace(/^Ability:\s*/, ""),
      type: "Ability",
      effect: strip(m[2]),
    });
  }

  const wrr = html.match(/card-text-wrr">([\s\S]*?)<\/p>/);
  if (wrr) {
    const t = strip(wrr[1]);
    const w = t.match(/Weakness:\s*(\w+)/);
    if (w && w[1] !== "none") out.weaknesses.push({ type: w[1], value: "+20" });
    const r = t.match(/Retreat:\s*(\d+)/);
    if (r) out.retreat = parseInt(r[1], 10);
  }

  if (out.category === "Trainer") {
    const sections = [
      ...html.matchAll(/<div class="card-text-section">([\s\S]*?)<\/div>/g),
    ]
      .map((m) => m[1])
      .filter(
        (s) =>
          !s.includes("card-text-title") &&
          !s.includes("card-text-type") &&
          !s.includes("card-text-attack") &&
          !s.includes("card-text-ability") &&
          !s.includes("card-text-wrr"),
      );
    const candidate = sections.map(strip).find((s) => s.length > 10);
    if (candidate) out.effect = candidate;
  }

  return out;
}

export async function enrichFromLimitless(
  opts: {
    expansion?: string;
    concurrency?: number;
    limit?: number;
    ids?: string[];
  } = {},
): Promise<{
  enriched: number;
  not_found: number;
  errors: number;
  pending_total: number;
}> {
  const db = getDb();
  const where = ["enriched_at IS NULL"];
  const args: Record<string, unknown> = {};
  if (opts.expansion) {
    where.push("expansion_id = @exp");
    args.exp = opts.expansion.toLowerCase();
  }
  let rows = db
    .prepare(
      `SELECT id, expansion_id, number FROM cards WHERE ${where.join(" AND ")} ORDER BY id`,
    )
    .all(args) as { id: string; expansion_id: string; number: number }[];
  if (opts.ids) {
    const allowed = new Set(opts.ids);
    rows = rows.filter((row) => allowed.has(row.id));
  }
  if (opts.limit) rows = rows.slice(0, opts.limit);

  const update = db.prepare(`
    UPDATE cards SET category=@category, stage=@stage, evolve_from=@evolve_from, suffix=NULL,
      retreat=@retreat, effect=@effect, attacks=@attacks, abilities=@abilities,
      weaknesses=@weaknesses, max_damage=@max_damage, enriched_at=@enriched_at
    WHERE id=@id
  `);

  let enriched = 0,
    notFound = 0,
    errors = 0;
  const queue = [...rows];
  const concurrency = opts.concurrency ?? 4;

  async function worker(): Promise<void> {
    while (queue.length) {
      const row = queue.shift();
      if (!row) return;
      try {
        const url = `https://pocket.limitlesstcg.com/cards/${limitlessSetId(row.expansion_id)}/${row.number}`;
        const html = await fetchHtml(url);
        if (html === null || !html.includes("card-text")) {
          notFound++;
          continue;
        }
        const p = parseLimitlessCard(html);
        update.run({
          id: row.id,
          category: p.category,
          stage: p.stage,
          evolve_from: p.evolve_from,
          retreat: p.retreat,
          effect: p.effect,
          attacks: p.attacks.length ? JSON.stringify(p.attacks) : null,
          abilities: p.abilities.length ? JSON.stringify(p.abilities) : null,
          weaknesses: p.weaknesses.length ? JSON.stringify(p.weaknesses) : null,
          max_damage: p.max_damage || null,
          enriched_at: new Date().toISOString(),
        });
        enriched++;
        await new Promise((r) => setTimeout(r, 150));
      } catch {
        errors++;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const pending = (
    db
      .prepare("SELECT COUNT(*) AS n FROM cards WHERE enriched_at IS NULL")
      .get() as { n: number }
  ).n;
  return { enriched, not_found: notFound, errors, pending_total: pending };
}

export interface MetaDeck {
  rank: number;
  name: string;
  slug: string;
  count: number;
  share: string;
}

// The meta table is scraped by regex; this locks the shape each parsed row must
// keep so a silent layout change surfaces as a clear error instead of garbage.
export const metaDeckSchema = z.object({
  rank: z.number().int().min(1),
  name: z.string().min(1),
  slug: z.string().min(1),
  count: z.number().int().min(0),
  share: z.string(),
});

export async function fetchMetaDecks(limit: number): Promise<MetaDeck[]> {
  const html = await fetchHtml(
    "https://play.limitlesstcg.com/decks?game=POCKET",
  );
  if (!html)
    throw new Error("No se pudo cargar la página de mazos de Limitless");
  const decks: MetaDeck[] = [];
  for (const m of html.matchAll(
    /<tr[^>]*>\s*<td>(\d+)<\/td>[\s\S]*?<a href="\/decks\/([^"?]+)\?[^"]*">([^<]+)<\/a><\/td><td[^>]*>(\d+)<\/td><td>([\d.]+%)<\/td>/g,
  )) {
    decks.push({
      rank: parseInt(m[1], 10),
      slug: m[2],
      name: strip(m[3]),
      count: parseInt(m[4], 10),
      share: m[5],
    });
    if (decks.length >= limit) break;
  }
  if (!decks.length) {
    throw new Error(
      "No se reconoció ningún mazo en la página de Limitless; el formato de la página pudo cambiar.",
    );
  }
  return parseRemote(z.array(metaDeckSchema), decks, "Limitless meta-decks");
}

export interface DeckCard {
  count: number;
  name: string;
  card_id: string | null;
}

export const deckCardSchema = z.object({
  count: z.number().int().min(1),
  name: z.string().min(1),
  card_id: z.string().nullable(),
});

export async function fetchDecklist(
  slug: string,
  finishIndex: number,
): Promise<{
  player: string | null;
  decklist_url: string;
  pokemon: DeckCard[];
  trainers: DeckCard[];
}> {
  const archHtml = await fetchHtml(
    `https://play.limitlesstcg.com/decks/${slug}?game=POCKET&format=standard`,
  );
  if (!archHtml)
    throw new Error(
      `Arquetipo '${slug}' no encontrado. Obtén el slug con ptcgp_meta_decks.`,
    );
  const links = [
    ...archHtml.matchAll(
      /href="(\/tournament\/[^"]+\/player\/([^"/]+)\/decklist)"/g,
    ),
  ];
  if (!links.length)
    throw new Error("Sin decklists publicadas para este arquetipo");
  const pick = links[Math.min(finishIndex, links.length - 1)];
  const url = `https://play.limitlesstcg.com${pick[1]}`;
  const html = await fetchHtml(url);
  if (!html) throw new Error(`No se pudo cargar la decklist ${url}`);

  function parseSection(heading: string): DeckCard[] {
    const sec = html!.match(
      new RegExp(`heading">${heading}[^<]*</div>([\\s\\S]*?)</div>`),
    );
    if (!sec) return [];
    const cards: DeckCard[] = [];
    for (const m of sec[1].matchAll(
      /cards\/([\w-]+)\/(\d+)"[^>]*>(\d+)\s+([^<(]+)/g,
    )) {
      const exp =
        m[1] === "P-A" ? "pa" : m[1] === "P-B" ? "pb" : m[1].toLowerCase();
      cards.push({
        count: parseInt(m[3], 10),
        name: m[4].trim(),
        card_id: `${exp}-${m[2].padStart(3, "0")}`,
      });
    }
    return cards;
  }

  const pokemon = parseRemote(
    z.array(deckCardSchema),
    parseSection("Pokémon"),
    "Limitless decklist (Pokémon)",
  );
  const trainers = parseRemote(
    z.array(deckCardSchema),
    parseSection("Trainer"),
    "Limitless decklist (Trainer)",
  );
  const cardCount = [...pokemon, ...trainers].reduce(
    (sum, card) => sum + card.count,
    0,
  );
  if (cardCount !== 20) {
    throw new Error(
      `Decklist incompleta o formato de Limitless no reconocido: se detectaron ${cardCount}/20 cartas`,
    );
  }

  return {
    player: pick[2] ?? null,
    decklist_url: url,
    pokemon,
    trainers,
  };
}
