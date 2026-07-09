import { db } from '../db/index.js';
import { config } from '../config.js';
import { anthropicClient } from '../settings.js';
import { nameMap } from '../names.js';

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

  const client = anthropicClient();
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
    const prompt =
      `Eres el asistente de una empresa comercial (trading). Clasifica cada contacto como ` +
      `"Oficina" (cliente, proveedor, fábrica o cualquier asunto de trabajo/negocio) o ` +
      `"Personal" (familia, amigos, asuntos personales). Si no hay señal clara, usa "Oficina". ` +
      `Devuelve SOLO un arreglo JSON, sin texto extra: [{"i":1,"cat":"Oficina"},{"i":2,"cat":"Personal"}].\n\n` +
      `Contactos:\n${list}`;
    try {
      const resp = await client.messages.create({
        model: config.model,
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      });
      const text = resp.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      const a = text.indexOf('[');
      const z = text.lastIndexOf(']');
      if (a < 0 || z < 0) continue;
      const parsed = JSON.parse(text.slice(a, z + 1)) as { i: number; cat: string }[];
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
  return { classified, scanned: cands.length };
}
