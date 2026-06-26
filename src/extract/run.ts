import { config } from '../config.js';
import { runExtraction } from './pipeline.js';

// CLI: run extraction over recent messages and print what it does.
//   EXTRACT_LIMIT   how many recent messages (default 80)
//   EXTRACT_VISION  set to 1 to also analyze image/PDF attachments
const limit = Number(process.env.EXTRACT_LIMIT ?? 80);
const vision = process.env.EXTRACT_VISION === '1';

if (!config.anthropicApiKey) {
  console.error('\n✗ No ANTHROPIC_API_KEY set. Add it to .env (see .env.example), then re-run.\n');
  process.exit(1);
}

console.log(`Extracting from the ${limit} most recent messages${vision ? ' (with vision)' : ''}…\n`);

await runExtraction({
  limit,
  vision,
  onEvent: (e) => {
    if (e.type === 'vision') console.log(`  📎 #${e.messageId} ${e.name || e.mime}: ${e.description.split('\n')[0]}`);
    if (e.type === 'task') console.log(`  • ${e.title} — ${e.detail}  [${e.client ?? '?'}]`);
    if (e.type === 'done') console.log(`\nProposed ${e.proposed} task(s).`);
  },
});
