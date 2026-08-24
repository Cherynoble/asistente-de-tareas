import { aiName, hasAiKey } from '../ai/index.js';
import { runExtraction } from './pipeline.js';

// CLI: run extraction over recent messages and print what it does.
//   EXTRACT_LIMIT   how many recent messages (default 80)
//   EXTRACT_VISION  set to 1 to also analyze image/PDF attachments
const limit = Number(process.env.EXTRACT_LIMIT ?? 80);
const vision = process.env.EXTRACT_VISION === '1';

if (!hasAiKey()) {
  console.error('\n✗ No AI provider configured. Set ANTHROPIC_API_KEY in .env or configure one in Ajustes.\n');
  process.exit(1);
}

console.log(`Extracting (${aiName()}) from the ${limit} most recent messages${vision ? ' (with vision)' : ''}…\n`);

await runExtraction({
  limit,
  vision,
  onEvent: (e) => {
    if (e.type === 'vision') console.log(`  📎 #${e.messageId} ${e.name || e.mime}: ${e.description.split('\n')[0]}`);
    if (e.type === 'task') console.log(`  • ${e.title} — ${e.detail}  [${e.client ?? '?'}]`);
    if (e.type === 'done') console.log(`\nProposed ${e.proposed} task(s).`);
  },
});
