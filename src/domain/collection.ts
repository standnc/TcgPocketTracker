/**
 * Framework-free collection rules: parsing the compact number/range spec used
 * by the manual-entry tools, and the owned-quantity arithmetic shared by
 * set/add across `set_card_quantity`, `bulk_update_collection` and
 * `mark_range`. No SQLite, MCP or Zod here.
 */

/**
 * Expands a compact spec such as `"1,3,7-15"` into a sorted, de-duplicated list
 * of numbers. Throws on an inverted/oversized range or an unrecognized token so
 * the adapter can surface the message to the user.
 */
export function parseNumbers(spec: string): number[] {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const t = part.trim();
    if (!t) continue;
    const range = t.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const a = parseInt(range[1], 10),
        b = parseInt(range[2], 10);
      if (a > b || b - a > 500) throw new Error(`Rango inválido: '${t}'`);
      for (let i = a; i <= b; i++) out.add(i);
    } else if (/^\d+$/.test(t)) {
      out.add(parseInt(t, 10));
    } else {
      throw new Error(
        `Token inválido: '${t}'. Usa números y rangos: "1,3,7-15"`,
      );
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Resolves the new owned quantity for a card. `set` writes the value; `add`
 * accumulates a (possibly negative) delta. Both are floored at 0 so a card is
 * never stored with a negative count.
 */
export function computeQuantity(
  previous: number,
  value: number,
  mode: "set" | "add",
): number {
  return mode === "add" ? Math.max(previous + value, 0) : Math.max(value, 0);
}
