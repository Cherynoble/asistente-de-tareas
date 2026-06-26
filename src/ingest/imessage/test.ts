import { config } from '../../config.js';
import { readMessagesSince } from './reader.js';

// Phase 1 checkpoint: read recent iMessages and print a picture of the data —
// volume, how much text comes from attributedBody, the busiest chats (to find
// the office group chat), and a few decoded samples.
const sinceMs = Date.now() - config.historyDays * 24 * 60 * 60 * 1000;

let rows;
try {
  rows = readMessagesSince(sinceMs);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/authorization denied|unable to open/i.test(msg)) {
    console.error(
      '\n✗ Cannot read chat.db — Full Disk Access is not granted.\n' +
        '  System Settings → Privacy & Security → Full Disk Access →\n' +
        '  enable "Claude", then fully quit and reopen the Claude app.\n',
    );
    process.exit(1);
  }
  throw err;
}

const fromAttr = rows.filter((r) => r.fromAttributedBody).length;
const byChat = new Map<string, number>();
for (const r of rows) {
  const key = r.chatName ?? r.chatId ?? '(unknown)';
  byChat.set(key, (byChat.get(key) ?? 0) + 1);
}
const topChats = [...byChat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

console.log(`\nWindow: last ${config.historyDays} days`);
console.log(`Messages with text: ${rows.length}`);
console.log(`  …from plain text column: ${rows.length - fromAttr}`);
console.log(`  …decoded from attributedBody: ${fromAttr}`);

console.log('\nBusiest chats:');
for (const [name, count] of topChats) console.log(`  ${count.toString().padStart(5)}  ${name}`);

console.log('\nMost recent 10 messages:');
for (const r of rows.slice(-10)) {
  const when = new Date(r.ts).toLocaleString();
  const who = r.direction === 'outgoing' ? 'me' : (r.sender ?? '?');
  const body = r.body.replace(/\s+/g, ' ').slice(0, 80);
  console.log(`  [${when}] ${who}: ${body}`);
}
console.log();
