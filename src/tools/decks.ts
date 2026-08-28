import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ownedRepo } from "../repositories/owned.js";
import { fetchMetaDecks, fetchDecklist, type DeckCard } from "../limitless.js";

export function registerDeckTools(server: McpServer): void {
  server.registerTool(
    "ptcgp_meta_decks",
    {
      title: "Mazos meta (Limitless)",
      description: `Obtiene el ranking actual de arquetipos de mazo de Pokémon TCG Pocket desde Limitless (play.limitlesstcg.com, datos de torneos reales). Devuelve { decks: [{rank, name, slug, count, share}] } donde 'count' es nº de apariciones en torneos y 'share' el porcentaje del meta. El 'slug' se usa con ptcgp_get_decklist para ver la lista concreta. Requiere red.`,
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(15)
          .describe("Número de arquetipos a devolver"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ limit }) => {
      try {
        const decks = await fetchMetaDecks(limit);
        const output = { decks };
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error obteniendo meta: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "ptcgp_get_decklist",
    {
      title: "Decklist de torneo (Limitless)",
      description: `Descarga una decklist real de torneo para un arquetipo (slug de ptcgp_meta_decks) y la cruza con la colección del usuario: cada carta indica 'owned' (copias poseídas) y el resumen 'buildable' dice si el mazo es montable, qué cartas faltan y cuántas. finish_index selecciona qué resultado de torneo usar (0 = mejor finish reciente).

Ejemplo de flujo: ptcgp_meta_decks -> elegir slug -> ptcgp_get_decklist(slug) -> "te faltan 2 Espeon (b3a-020) y 1 Cyrus (a2-150)". Requiere red.`,
      inputSchema: {
        slug: z
          .string()
          .min(3)
          .max(120)
          .describe("Slug del arquetipo, ej. 'mega-altaria-ex-b1-espeon-b3a'"),
        finish_index: z
          .number()
          .int()
          .min(0)
          .max(20)
          .default(0)
          .describe("Índice del finish de torneo a usar"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ slug, finish_index }) => {
      try {
        const deck = await fetchDecklist(slug, finish_index);
        const ownedRepository = ownedRepo();
        const missing: {
          card_id: string | null;
          name: string;
          need: number;
          have: number;
        }[] = [];

        function annotate(cards: DeckCard[]): (DeckCard & { owned: number })[] {
          return cards.map((c) => {
            const owned = c.card_id
              ? ownedRepository.getQuantity(c.card_id)
              : 0;
            if (owned < c.count)
              missing.push({
                card_id: c.card_id,
                name: c.name,
                need: c.count,
                have: owned,
              });
            return { ...c, owned };
          });
        }

        const pokemon = annotate(deck.pokemon);
        const trainers = annotate(deck.trainers);
        const output = {
          slug,
          player: deck.player,
          decklist_url: deck.decklist_url,
          pokemon,
          trainers,
          buildable: missing.length === 0,
          missing,
          note: "owned compara contra la carta exacta (misma rareza/print). Variantes de mayor rareza de la misma carta son funcionalmente equivalentes: verificar con ptcgp_search_cards por nombre si falta alguna.",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error obteniendo decklist: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
