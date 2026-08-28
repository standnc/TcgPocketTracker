import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { analyzeScreenshots } from "../screenshot-analyzer.js";

test(
  "normaliza una imagen sintética con distinto tamaño, formato y orientación móvil",
  { timeout: 60_000 },
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "ptcgp-images-"));
    try {
      const fixture = join(temp, "synthetic-grid.png");
      const small = join(temp, "small.jpg");
      const large = join(temp, "large.webp");
      const oriented = join(temp, "mobile-orientation.jpg");
      await sharp({
        create: { width: 600, height: 800, channels: 3, background: "#e0e0e0" },
      })
        .png()
        .toFile(fixture);
      await sharp(fixture)
        .resize({ width: 360 })
        .jpeg({ quality: 88 })
        .toFile(small);
      await sharp(fixture)
        .resize({ width: 900 })
        .webp({ quality: 88 })
        .toFile(large);
      await sharp(fixture)
        .rotate(270)
        .withMetadata({ orientation: 6 })
        .jpeg({ quality: 90 })
        .toFile(oriented);
      const results = await analyzeScreenshots(
        [fixture, small, large, oriented],
        103,
      );
      assert.deepEqual(
        results.map((result) => result.format),
        ["png", "jpeg", "webp", "jpeg"],
      );
      assert.ok(
        results.every((result) => result.width > 0 && result.height > 0),
      );
      assert.ok(
        results.every((result) => result.detected_missing.length === 0),
      );
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
