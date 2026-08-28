import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname } from "node:path";
import sharp from "sharp";
import { createWorker, PSM, type Worker } from "tesseract.js";
import engData from "@tesseract.js-data/eng";

const NORMALIZED_WIDTH = 600;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_PIXELS = 80_000_000;
const ALLOWED_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".heic",
  ".heif",
]);

export interface DetectedMissingSlot {
  number: number;
  confidence: number;
  source_path: string;
  column: number;
  normalized_top: number;
  ocr_votes: number;
}

export interface AnalyzedScreenshot {
  path: string;
  sha256: string;
  width: number;
  height: number;
  format: string;
  detected_missing: DetectedMissingSlot[];
  warnings: string[];
}

interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: 1 | 2 | 3 | 4;
}

interface Metrics {
  mean: number;
  deviation: number;
  saturation: number;
  edgeDensity: number;
  blank: boolean;
  cellLike: boolean;
  score: number;
}

interface IntegralImage {
  width: number;
  height: number;
  stride: number;
  luma: Float64Array;
  lumaSquared: Float64Array;
  saturation: Float64Array;
  edges: Uint32Array;
}

function validatePath(inputPath: string): string {
  const resolved = realpathSync(inputPath);
  const stat = statSync(resolved);
  if (!stat.isFile()) throw new Error(`No es un fichero: ${inputPath}`);
  if (stat.size > MAX_IMAGE_BYTES)
    throw new Error(
      `Captura demasiado grande (${stat.size} bytes): ${inputPath}`,
    );
  if (!ALLOWED_EXTENSIONS.has(extname(resolved).toLowerCase())) {
    throw new Error(
      `Formato no admitido: ${extname(resolved) || "sin extensión"}`,
    );
  }
  return resolved;
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function normalizeImage(path: string): Promise<{
  raw: RawImage;
  originalWidth: number;
  originalHeight: number;
  format: string;
}> {
  const pipeline = sharp(path, { limitInputPixels: MAX_PIXELS }).rotate();
  const metadata = await pipeline.metadata();
  if (!metadata.width || !metadata.height || !metadata.format)
    throw new Error(`No se pudo leer la captura: ${path}`);
  const orientedWidth = metadata.autoOrient?.width ?? metadata.width;
  const orientedHeight = metadata.autoOrient?.height ?? metadata.height;
  const scale = NORMALIZED_WIDTH / orientedWidth;
  const normalizedHeight = Math.max(1, Math.round(orientedHeight * scale));
  const { data, info } = await pipeline
    .resize({
      width: NORMALIZED_WIDTH,
      height: normalizedHeight,
      fit: "fill",
      kernel: sharp.kernel.lanczos3,
    })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    raw: {
      data,
      width: info.width,
      height: info.height,
      channels: info.channels,
    },
    originalWidth: orientedWidth,
    originalHeight: orientedHeight,
    format: metadata.format,
  };
}

function buildIntegral(raw: RawImage): IntegralImage {
  const { data, width, height, channels } = raw;
  const stride = width + 1;
  const length = stride * (height + 1);
  const luma = new Float64Array(length);
  const lumaSquared = new Float64Array(length);
  const saturation = new Float64Array(length);
  const edges = new Uint32Array(length);
  let previousRow = new Float64Array(width);

  for (let y = 0; y < height; y++) {
    const currentRow = new Float64Array(width);
    let rowLuma = 0;
    let rowLumaSquared = 0;
    let rowSaturation = 0;
    let rowEdges = 0;
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels;
      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      const value = 0.299 * r + 0.587 * g + 0.114 * b;
      currentRow[x] = value;
      const colorSpread = Math.max(r, g, b) - Math.min(r, g, b);
      const horizontal = x > 0 ? Math.abs(value - currentRow[x - 1]) : 0;
      const vertical = y > 0 ? Math.abs(value - previousRow[x]) : 0;
      const isEdge = horizontal + vertical > 42 ? 1 : 0;

      rowLuma += value;
      rowLumaSquared += value * value;
      rowSaturation += colorSpread;
      rowEdges += isEdge;
      const index = (y + 1) * stride + x + 1;
      const above = index - stride;
      luma[index] = luma[above] + rowLuma;
      lumaSquared[index] = lumaSquared[above] + rowLumaSquared;
      saturation[index] = saturation[above] + rowSaturation;
      edges[index] = edges[above] + rowEdges;
    }
    previousRow = currentRow;
  }
  return { width, height, stride, luma, lumaSquared, saturation, edges };
}

function rectSum(
  values: Float64Array | Uint32Array,
  integral: IntegralImage,
  x: number,
  y: number,
  width: number,
  height: number,
): number {
  const x0 = Math.max(0, Math.min(integral.width, x));
  const y0 = Math.max(0, Math.min(integral.height, y));
  const x1 = Math.max(x0, Math.min(integral.width, x + width));
  const y1 = Math.max(y0, Math.min(integral.height, y + height));
  const { stride } = integral;
  return (
    values[y1 * stride + x1] -
    values[y0 * stride + x1] -
    values[y1 * stride + x0] +
    values[y0 * stride + x0]
  );
}

function cellGeometry(
  width: number,
  column: number,
): { left: number; width: number; height: number } {
  const cellWidth = Math.round(width * 0.181);
  return {
    left: Math.round(width * (0.009 + column * 0.1935)),
    width: cellWidth,
    height: Math.round(cellWidth * 1.42),
  };
}

function metricsAt(
  integral: IntegralImage,
  column: number,
  top: number,
): Metrics {
  const geometry = cellGeometry(integral.width, column);
  const requestedX = geometry.left + Math.round(geometry.width * 0.12);
  const requestedY = top + Math.round(geometry.height * 0.1);
  const requestedWidth = Math.round(geometry.width * 0.76);
  const requestedHeight = Math.round(geometry.height * 0.8);
  const x = Math.max(0, requestedX);
  const y = Math.max(0, requestedY);
  const width = Math.max(
    1,
    Math.min(integral.width, requestedX + requestedWidth) - x,
  );
  const height = Math.max(
    1,
    Math.min(integral.height, requestedY + requestedHeight) - y,
  );
  const count = width * height;
  const sum = rectSum(integral.luma, integral, x, y, width, height);
  const squared = rectSum(integral.lumaSquared, integral, x, y, width, height);
  const mean = sum / count;
  const deviation = Math.sqrt(Math.max(0, squared / count - mean * mean));
  const saturation =
    rectSum(integral.saturation, integral, x, y, width, height) / count;
  const edgeDensity =
    rectSum(integral.edges, integral, x, y, width, height) / count;
  const blank =
    mean > 190 &&
    mean < 250 &&
    deviation < 19 &&
    saturation < 34 &&
    edgeDensity < 0.012;
  const cellLike =
    blank || deviation > 25 || saturation > 42 || edgeDensity > 0.018;
  const score = deviation + saturation * 0.35 + edgeDensity * 300;
  return { mean, deviation, saturation, edgeDensity, blank, cellLike, score };
}

async function createOcrWorker(): Promise<Worker> {
  const worker = await createWorker("eng", 1, {
    langPath: engData.langPath,
    cacheMethod: "none",
    logger: () => undefined,
  });
  await worker.setParameters({
    tessedit_char_whitelist: "0123456789",
    tessedit_pageseg_mode: PSM.SPARSE_TEXT,
    user_defined_dpi: "300",
  });
  return worker;
}

async function recognizeMissingNumbers(
  raw: RawImage,
  integral: IntegralImage,
  worker: Worker,
  expectedTotal: number,
  sourcePath: string,
): Promise<DetectedMissingSlot[]> {
  const scale = 1200 / raw.width;
  const padding = 40;
  const votes = new Map<
    number,
    { count: number; confidence: number; column: number; top: number }
  >();
  for (const threshold of [205, 210, 215]) {
    const prepared = await sharp(raw.data, {
      raw: { width: raw.width, height: raw.height, channels: raw.channels },
    })
      .resize({ width: 1200, kernel: sharp.kernel.lanczos3 })
      .grayscale()
      .threshold(threshold)
      .extend({
        top: padding,
        bottom: padding * 2,
        left: padding,
        right: padding,
        background: "white",
      })
      .png()
      .withMetadata({ density: 300 })
      .toBuffer();
    const result = await worker.recognize(prepared, {}, { blocks: true });
    const blocks = (result.data.blocks ?? []) as unknown as Array<{
      paragraphs: Array<{
        lines: Array<{
          words: Array<{
            text: string;
            confidence: number;
            bbox: { x0: number; y0: number; x1: number; y1: number };
          }>;
        }>;
      }>;
    }>;
    const words = blocks
      .flatMap((block) => block.paragraphs)
      .flatMap((paragraph) => paragraph.lines)
      .flatMap((line) => line.words);
    for (const word of words) {
      const digits = word.text.replace(/\D/g, "");
      if (digits.length !== 3 || word.confidence < 80) continue;
      const number = Number.parseInt(digits, 10);
      if (number < 1 || number > expectedTotal) continue;
      const centerX = ((word.bbox.x0 + word.bbox.x1) / 2 - padding) / scale;
      const centerY = ((word.bbox.y0 + word.bbox.y1) / 2 - padding) / scale;
      const columns = Array.from({ length: 5 }, (_, column) => {
        const geometry = cellGeometry(raw.width, column);
        return {
          column,
          distance: Math.abs(centerX - (geometry.left + geometry.width / 2)),
        };
      }).sort((a, b) => a.distance - b.distance);
      const nearest = columns[0];
      const geometry = cellGeometry(raw.width, nearest.column);
      if (nearest.distance > geometry.width * 0.42) continue;
      const top = Math.round(centerY - geometry.height * 0.5);
      if (
        top + geometry.height * 0.45 > raw.height ||
        top + geometry.height * 0.9 < 0
      )
        continue;
      const targetMetrics = metricsAt(integral, nearest.column, top);
      if (!targetMetrics.blank || targetMetrics.deviation < 3.5) continue;
      const rowSupport = Array.from({ length: 5 }, (_, column) =>
        metricsAt(integral, column, top),
      ).filter(
        (item) =>
          (item.blank && item.deviation >= 3.5) ||
          item.deviation > 25 ||
          item.saturation > 42 ||
          item.edgeDensity > 0.018,
      ).length;
      const requiredSupport =
        number > expectedTotal - 5 ? Math.min(4, expectedTotal % 5 || 5) : 4;
      if (rowSupport < requiredSupport) continue;
      const previous = votes.get(number);
      if (!previous) {
        votes.set(number, {
          count: 1,
          confidence: word.confidence,
          column: nearest.column,
          top,
        });
      } else {
        previous.count++;
        previous.confidence = Math.max(previous.confidence, word.confidence);
      }
    }
  }
  return [...votes.entries()]
    .filter(([, value]) => value.count >= 2 || value.confidence >= 94)
    .map(([number, value]) => ({
      number,
      confidence: Math.min(
        0.99,
        0.68 + value.count * 0.1 + value.confidence / 1000,
      ),
      source_path: sourcePath,
      column: value.column + 1,
      normalized_top: value.top,
      ocr_votes: value.count,
    }))
    .sort((a, b) => a.number - b.number);
}

export async function analyzeScreenshots(
  paths: string[],
  expectedTotal: number,
): Promise<AnalyzedScreenshot[]> {
  if (!paths.length) throw new Error("La ronda necesita al menos una captura");
  const worker = await createOcrWorker();
  try {
    const results: AnalyzedScreenshot[] = [];
    for (const inputPath of paths) {
      const path = validatePath(inputPath);
      const normalized = await normalizeImage(path);
      const integral = buildIntegral(normalized.raw);
      const detected = await recognizeMissingNumbers(
        normalized.raw,
        integral,
        worker,
        expectedTotal,
        path,
      );
      const bestByNumber = new Map<number, DetectedMissingSlot>();
      for (const item of detected) {
        const previous = bestByNumber.get(item.number);
        if (!previous || previous.confidence < item.confidence)
          bestByNumber.set(item.number, item);
      }
      const warnings: string[] = [];
      if (!bestByNumber.size)
        warnings.push(
          "No se leyeron huecos con confianza alta; puede ser una captura sin faltantes o requerir revisión visual.",
        );
      results.push({
        path,
        sha256: hashFile(path),
        width: normalized.originalWidth,
        height: normalized.originalHeight,
        format: normalized.format,
        detected_missing: [...bestByNumber.values()].sort(
          (a, b) => a.number - b.number,
        ),
        warnings,
      });
    }
    return results;
  } finally {
    await worker.terminate();
  }
}
