import { ClaudeExtractor } from './claude.js';
import type { IngestedMessage } from './types.js';

// Validates the extractor end-to-end on synthetic trading-company messages:
// obvious tasks mixed with noise. Does NOT touch the database.
const now = Date.now();
const msg = (id: number, sender: string, direction: 'incoming' | 'outgoing', body: string): IngestedMessage => ({
  id,
  chatName: sender,
  sender,
  direction,
  body,
  ts: now + id * 1000,
});

const messages: IngestedMessage[] = [
  msg(1, 'Mr. Chen', 'incoming', 'Hey, good morning! How was your weekend?'),
  msg(2, 'Mr. Chen', 'incoming', 'Can you consult the factories about toilet paper pricing? Need it by next week'),
  msg(3, 'Mr. Chen', 'outgoing', 'Sure, will check'),
  msg(4, 'Acme Imports', 'incoming', 'thanks 👍'),
  msg(5, 'Acme Imports', 'incoming', 'Also please send the quote for 500 units of napkins'),
  msg(6, 'Acme Imports', 'incoming', '[attachment: product_sample.jpg]'),
  msg(7, 'Mr. Chen', 'outgoing', 'ok'),
];

const extractor = new ClaudeExtractor();
const tasks = await extractor.proposeTasks(messages);

console.log(`\n${extractor.name} proposed ${tasks.length} task(s) from 7 synthetic messages:\n`);
for (const t of tasks) {
  console.log(`  • ${t.title}`);
  console.log(`    ${t.detail}`);
  console.log(`    🔎 quote: "${t.sourceQuote}"`);
  console.log(`    client: ${t.clientHint}  (msg #${t.sourceMessageId})`);
}
console.log();
