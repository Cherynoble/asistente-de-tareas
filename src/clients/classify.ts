import { db } from '../db/index.js';
import { aiProvider, extractJson } from '../ai/index.js';
import { nameMap, invalidateNameCache } from '../names.js';

interface Cand {
  handle: string;
  name: string;
  productNeed: string;
  samples: string[];
}

/**
 * Initial auto-tagging of clients as "Oficina" (business — client, supplier,
 * factory, work) vs "Personal" (family, friends, personal). Only touches
 * contacts that are still unclassified (no category yet), so it never overwrites
 * a manual choice and re-running it just fills in newcomers. Uses Haiku in small
 * batches; on any parse/API failure a batch is skipped (leaves them unclassified).
 */
export async function autoClassifyClients(limit = 200): Promise<{ classified: number; scanned: number }> {
  const d = db();
  const names = nameMap();

  const rows = d
    .prepare(
      `SELECT m.sender AS handle, COUNT(*) AS cnt
       FROM messages m
       LEFT JOIN clients c ON c.handle = m.sender
       WHERE m.sender IS NOT NULL AND m.sender != 'me'
         AND (c.category IS NULL OR c.category = '')
         AND (c.deleted_at IS NULL)
       GROUP BY m.sender ORDER BY cnt DESC LIMIT ?`,
    )
    .all(limit) as { handle: string; cnt: number }[];
  if (!rows.length) return { classified: 0, scanned: 0 };

  const sampleStmt = d.prepare(`SELECT body FROM messages WHERE sender = ? ORDER BY ts DESC LIMIT 6`);
  const clientStmt = d.prepare(
    `SELECT name, product_need AS pn FROM clients WHERE handle = ? AND deleted_at IS NULL`,
  );
  const cands: Cand[] = rows.map((r) => {
    const samples = (sampleStmt.all(r.handle) as { body: string }[]).map((x) => x.body).filter(Boolean);
    const c = clientStmt.get(r.handle) as { name: string; pn: string } | undefined;
    return { handle: r.handle, name: names[r.handle] || c?.name || '', productNeed: c?.pn || '', samples };
  });

  const provider = aiProvider('bulk'); // thousands of contacts — use the cheap tier
  const upsert = d.prepare(
    `INSERT INTO clients (handle, name, category, created_at, updated_at)
     VALUES (@handle, @name, @cat, @now, @now)
     ON CONFLICT(handle) DO UPDATE SET category = excluded.category, updated_at = excluded.updated_at, deleted_at = NULL`,
  );

  let classified = 0;
  const CHUNK = 20;
  for (let i = 0; i < cands.length; i += CHUNK) {
    const batch = cands.slice(i, i + CHUNK);
    const list = batch
      .map((c, j) => {
        const s = c.samples
          .slice(0, 5)
          .map((x) => x.replace(/\s+/g, ' ').slice(0, 120))
          .join(' | ');
        return `${j + 1}. nombre="${c.name}" compra="${c.productNeed}" mensajes=[${s}]`;
      })
      .join('\n');
    // English instruction, machine-readable output. The two category VALUES are
    // fixed identifiers stored in the database — they are deliberately not
    // translated, and the UI localises them at render time.
    const prompt =
      `You are the assistant of a trading company. Classify each contact as ` +
      `"Oficina" (a client, supplier, factory, or anything work/business related) or ` +
      `"Personal" (family, friends, personal matters). If there is no clear signal, use "Oficina".\n` +
      `Reply with a single json array and nothing else — no prose, no markdown fence — ` +
      `exactly in this form: [{"i":1,"cat":"Oficina"},{"i":2,"cat":"Personal"}]\n\n` +
      `Contacts:\n${list}`;
    try {
      const resp = await provider.chat({
        maxTokens: 600,
        messages: [{ role: 'user', content: prompt }],
      });
      const parsed = extractJson<{ i: number; cat: string }[]>(resp.text);
      if (!Array.isArray(parsed)) continue;
      const now = Date.now();
      for (const item of parsed) {
        const cand = batch[Number(item.i) - 1];
        if (!cand) continue;
        const cat = /personal/i.test(item.cat) ? 'Personal' : 'Oficina';
        // Leave name empty when unknown (don't bake a phone number into it).
        upsert.run({ handle: cand.handle, name: cand.name || '', cat, now });
        classified++;
      }
    } catch {
      /* skip this batch — leaves them unclassified for a retry */
    }
  }
  if (classified) invalidateNameCache(); // upserts may have created client rows
  return { classified, scanned: cands.length };
}
