import { syncCatalog, enrichCards } from "../sync.js";
import { enrichFromLimitless } from "../limitless.js";

async function main(): Promise<void> {
  const r = await syncCatalog();
  console.log(
    `🟢 Catálogo: ${r.cards} cartas, ${r.expansions} expansiones (${r.newCards} nuevas)`,
  );
  console.log("Fase 1: datos de combate desde TCGdex (incremental)...");
  const e = await enrichCards({ concurrency: 8 });
  console.log(
    `🟢 TCGdex: ${e.enriched} enriquecidas | ${e.not_found} no disponibles | errores: ${e.errors}`,
  );
  if (e.pending_total > 0) {
    console.log(
      `Fase 2: ${e.pending_total} pendientes desde Limitless (sets nuevos, paciencia)...`,
    );
    const l = await enrichFromLimitless({ ids: e.pending_ids });
    console.log(
      `🟢 Limitless: ${l.enriched} enriquecidas | ${l.not_found} no encontradas | errores: ${l.errors} | pendientes: ${l.pending_total}`,
    );
  } else {
    console.log("🟢 Catálogo de combate completo");
  }
}

main().catch((err) => {
  console.error(`🔴 ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
