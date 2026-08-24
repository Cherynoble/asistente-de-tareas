import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { aiProvider, type AiPart } from '../ai/index.js';

/** Image media types the APIs accept directly. */
const NATIVE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * Stay under Claude's 10 MB per-image limit (the strictest of the providers).
 * The limit is measured on the BASE64 string, which is ~4/3 the raw size — so a
 * ~7.8 MB file already exceeds it. Keep raw bytes under ~7 MB (base64 ≈ 9.3 MB)
 * and downscale anything larger.
 */
const MAX_IMAGE_BYTES = 7_000_000;

/** Cap the long edge so even huge photos come in well under the size limit. */
const MAX_LONG_EDGE = '2000';

const PROMPT = `A client sent this to a trading-company owner. In one or two short lines: (1) say what it shows, and (2) if it implies something he should do — source a product, send a quote, follow up — state that task plainly. If it's not business-relevant, just say so. Reply in Spanish (neutral Latin-American Spanish); keep product and brand names as-is.`;

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * Load an image as base64 the API accepts. Pass through already-supported types
 * that are safely under the size cap; otherwise convert + downscale to a bounded
 * JPEG via macOS `sips` (handles HEIC and oversized photos). Returns null on
 * missing file or conversion failure.
 */
function loadImage(filePath: string, mime: string): { data: string; mediaType: string } | null {
  const abs = expandHome(filePath);
  if (!fs.existsSync(abs)) return null;

  let smallEnough = false;
  try {
    smallEnough = fs.statSync(abs).size <= MAX_IMAGE_BYTES;
  } catch {
    smallEnough = false;
  }

  if (NATIVE_IMAGE_TYPES.has(mime) && smallEnough) {
    return { data: fs.readFileSync(abs).toString('base64'), mediaType: mime };
  }

  const tmp = path.join(os.tmpdir(), `dadsapp-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
  try {
    execFileSync(
      '/usr/bin/sips',
      ['-s', 'format', 'jpeg', '-Z', MAX_LONG_EDGE, abs, '--out', tmp],
      { stdio: 'ignore' },
    );
    const data = fs.readFileSync(tmp).toString('base64');
    fs.unlinkSync(tmp);
    return { data, mediaType: 'image/jpeg' };
  } catch {
    return null;
  }
}

/**
 * Describe an image or PDF attachment and surface any implied task, using the
 * CONFIGURED provider. Never throws — a problem with one attachment returns a
 * short note so the batch keeps going. `opts.prompt`/`opts.maxTokens` override
 * the terse extraction defaults — the chat "read this file" tool passes a
 * fuller prompt so the assistant can actually quote figures/details.
 *
 * Provider differences are absorbed here and in the adapters: Anthropic reads
 * PDFs natively; OpenAI-compatible providers get the PDF's locally-extracted
 * text (ai/pdf.ts). Images require a vision-capable model — otherwise a clear
 * note comes back instead of a doomed API call.
 */
export async function describeAttachment(
  filePath: string,
  mime: string,
  opts: { prompt?: string; maxTokens?: number } = {},
): Promise<string> {
  const prompt = opts.prompt ?? PROMPT;
  const maxTokens = opts.maxTokens ?? 300;
  try {
    const provider = aiProvider();
    let part: AiPart;

    if (mime === 'application/pdf') {
      const abs = expandHome(filePath);
      if (!fs.existsSync(abs)) return '(file not found)';
      part = { type: 'pdf', dataBase64: fs.readFileSync(abs).toString('base64') };
    } else if (mime.startsWith('image/')) {
      if (!provider.supportsVision) {
        return '(el modelo de IA configurado no acepta imágenes — elige un modelo con visión en Ajustes)';
      }
      const img = loadImage(filePath, mime);
      if (!img) return '(could not load/convert image)';
      part = { type: 'image', mediaType: img.mediaType, dataBase64: img.data };
    } else {
      return '(unsupported attachment type)';
    }

    const resp = await provider.chat({
      maxTokens,
      messages: [{ role: 'user', content: [part, { type: 'text', text: prompt }] }],
    });
    return resp.text.trim();
  } catch (err) {
    return `(vision unavailable: ${err instanceof Error ? err.message.slice(0, 90) : 'error'})`;
  }
}
