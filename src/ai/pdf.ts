/**
 * Local PDF → text extraction, for providers that (unlike Anthropic) can't read
 * an inline PDF. Uses pdfjs-dist, which is pure JS (no native module — safe for
 * the Electron ABI setup), loaded lazily so the app boots fine even where the
 * dependency isn't installed (an online-updated install whose bundled
 * node_modules predate it) — extraction then degrades to a clear message
 * instead of crashing.
 *
 * Text-based PDFs (cotizaciones, facturas, listas) extract well. Scanned
 * image-only PDFs yield no text; callers surface that instead of guessing.
 */

const MAX_PAGES = 30;
const MAX_CHARS = 60_000;

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsPromise: Promise<PdfJs | null> | null = null;

function pdfjs(): Promise<PdfJs | null> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').catch(() => null);
  }
  return pdfjsPromise;
}

export interface PdfText {
  ok: boolean;
  text: string;
  pages: number;
  /** Why extraction produced nothing useful (Spanish, user-facing). */
  note?: string;
}

export async function extractPdfText(data: Buffer): Promise<PdfText> {
  const lib = await pdfjs();
  if (!lib) {
    return {
      ok: false,
      text: '',
      pages: 0,
      note: 'Este proveedor no puede leer PDFs en esta instalación (falta el componente de extracción; usa Anthropic para PDFs o actualiza la app).',
    };
  }
  const task = lib.getDocument({ data: new Uint8Array(data), useSystemFonts: true });
  try {
    const doc = await task.promise;
    const pages = Math.min(doc.numPages, MAX_PAGES);
    let out = '';
    for (let p = 1; p <= pages && out.length < MAX_CHARS; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const line = content.items
        .map((it) => ('str' in it ? it.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (line) out += `\n[página ${p}]\n${line}\n`;
    }
    const numPages = doc.numPages;
    await task.destroy();
    const text = out.trim().slice(0, MAX_CHARS);
    if (!text) {
      return {
        ok: false,
        text: '',
        pages: numPages,
        note: 'El PDF no contiene texto extraíble (probablemente es un escaneo/imagen).',
      };
    }
    return { ok: true, text, pages: numPages };
  } catch (err) {
    return {
      ok: false,
      text: '',
      pages: 0,
      note: `No se pudo leer el PDF (${err instanceof Error ? err.message.slice(0, 80) : 'error'}).`,
    };
  }
}
