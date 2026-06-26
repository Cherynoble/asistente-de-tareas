import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { anthropicClient } from '../settings.js';

/** Image media types the API accepts directly. */
const NATIVE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * Stay under Claude's 10 MB per-image limit. The limit is measured on the
 * BASE64 string, which is ~4/3 the raw size — so a ~7.8 MB file already exceeds
 * it. Keep raw bytes under ~7 MB (base64 ≈ 9.3 MB) and downscale anything larger.
 */
const MAX_IMAGE_BYTES = 7_000_000;

/** Cap the long edge so even huge photos come in well under the size limit. */
const MAX_LONG_EDGE = '2000';

const PROMPT = `A client sent this to a trading-company owner. In one or two short lines: (1) say what it shows, and (2) if it implies something he should do — source a product, send a quote, follow up — state that task plainly. If it's not business-relevant, just say so. Reply in Spanish (neutral Latin-American Spanish); keep product and brand names as-is.`;

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

function textOf(resp: Anthropic.Message): string {
  const block = resp.content.find((b) => b.type === 'text');
  return block && block.type === 'text' ? block.text.trim() : '';
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
 * Describe an image or PDF attachment and surface any implied task. Never
 * throws — a problem with one attachment returns a short note so the batch
 * keeps going.
 */
export async function describeAttachment(filePath: string, mime: string): Promise<string> {
  try {
    if (mime === 'application/pdf') {
      const abs = expandHome(filePath);
      if (!fs.existsSync(abs)) return '(file not found)';
      const resp = await anthropicClient().messages.create({
        model: config.model,
        max_tokens: 300,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: fs.readFileSync(abs).toString('base64') },
              },
              { type: 'text', text: PROMPT },
            ],
          },
        ],
      });
      return textOf(resp);
    }

    if (mime.startsWith('image/')) {
      const img = loadImage(filePath, mime);
      if (!img) return '(could not load/convert image)';
      const resp = await anthropicClient().messages.create({
        model: config.model,
        max_tokens: 300,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: img.mediaType as 'image/jpeg', data: img.data } },
              { type: 'text', text: PROMPT },
            ],
          },
        ],
      });
      return textOf(resp);
    }

    return '(unsupported attachment type)';
  } catch (err) {
    return `(vision unavailable: ${err instanceof Error ? err.message.slice(0, 90) : 'error'})`;
  }
}
