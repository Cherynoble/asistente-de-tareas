/**
 * One-time migration: translate existing task titles/details to Spanish (the AI
 * now generates Spanish, but tasks created before that change are English).
 * source_quote is left untouched — it's a verbatim search string. Re-runnable:
 * already-Spanish tasks come back unchanged. Run: `npm run translate:tasks`.
 */
import { db } from '../db/index.js';
import { aiJson, hasAiKey } from '../ai/index.js';

interface Row {
  id: number;
  title: string;
  detail: string;
}

const SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          title: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['id', 'title', 'detail'],
        additionalProperties: false,
      },
    },
  },
  required: ['tasks'],
  additionalProperties: false,
} as const;

const SYSTEM = `Translate each task's title and detail to neutral Latin-American Spanish. Keep product names, brand names, and proper names as-is. Return EVERY task by its exact id. If a task is already in Spanish, return it unchanged.`;

async function main(): Promise<void> {
  if (!hasAiKey()) {
    console.error('No AI provider configured (Ajustes, or ANTHROPIC_API_KEY in .env).');
    process.exit(1);
  }
  const rows = db()
    .prepare(`SELECT id, title, detail FROM tasks WHERE archived_at IS NULL`)
    .all() as Row[];
  if (!rows.length) {
    console.log('No tasks to translate.');
    process.exit(0);
  }

  // Translate in batches to keep each request small and reliable.
  const BATCH = 40;
  const upd = db().prepare('UPDATE tasks SET title = ?, detail = ?, updated_at = ? WHERE id = ?');
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const input = batch.map((r) => `#${r.id} | ${r.title} | ${r.detail}`).join('\n');
    const parsed = await aiJson<{ tasks?: Row[] }>(
      {
        system: SYSTEM,
        maxTokens: 4000,
        messages: [
          { role: 'user', content: `Translate these tasks. Each line is "#id | title | detail":\n\n${input}` },
        ],
      },
      SCHEMA,
    );
    if (!parsed) continue;
    const tx = db().transaction((items: Row[]) => {
      for (const t of items) if (t.title) upd.run(t.title, t.detail ?? '', Date.now(), t.id);
    });
    tx(parsed.tasks ?? []);
    done += (parsed.tasks ?? []).length;
    console.log(`  translated ${done}/${rows.length}…`);
  }
  console.log(`Done — translated ${done} tasks to Spanish.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
