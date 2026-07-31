# Dad's App — Project State & Contributor Guide

**Snapshot: version 1.7.2 (2026-07-30).** This is the "how it actually works and how to
change it safely" document. The other two docs cover different questions:

| Doc | Answers |
|---|---|
| `CLAUDE.md` | *What is this and why* — product intent, locked decisions, historical progress log |
| `DEBUGGING.md` | *It's broken, where do I look* — symptom → cause → fix runbook |
| **`PROJECT_STATE.md`** (this) | *What's the current shape and how do I extend it* — architecture, data model, invariants, API surface, recipes |

---

## 1. One-paragraph summary

A macOS Electron app, originally for one trading-company owner (the owner's father) and
now deployed to several people in his office. Each install mirrors **its own user's**
iMessage (read-only from `chat.db`) and WhatsApp (read-only Web mirror) into a local
SQLite DB, runs them through **Claude Haiku** to propose follow-up tasks they'd otherwise
forget, and nags until they're done. Everything is local: no server, no accounts, no
telemetry. The UI is a Spanish-language local web app served by an in-process Express
server at `localhost:4319` — vanilla HTML/CSS/JS, no bundler and no framework, styled as a
translucent "liquid glass" surface with light and dark themes (§6a).

---

## 1a. Deployment model: SILO MODE (decided 2026-07-30)

**Each install is a completely independent app with its own database. Nothing is shared
between people, and nothing is meant to be.** This is a deliberate decision, not a
limitation waiting to be fixed — read it before designing any feature that sounds
collaborative.

| | |
|---|---|
| **Unit of deployment** | one Mac, one macOS user, one `~/Library/Application Support/DadsApp/` |
| **Shared between employees** | **nothing** — no tasks, no clients, no chat, no memory, no settings |
| **Each person mirrors** | their *own* iMessage account and their *own* WhatsApp number |
| **Coordination between people** | happens outside the app, as it does today (the office group chat) |

**Why silo and not a shared server.** Three constraints make a hub genuinely hard, and
none of them are about effort:

1. **iMessage is per-Mac and per-Apple-ID.** `chat.db` only ever contains the messages of
   the Apple ID signed into *that* Mac. There is no way to read a colleague's iMessage,
   and no amount of server work changes it.
2. **WhatsApp Web links a device to a number, and the cap is 4 linked devices.** If several
   installs link the *same* company number they compete for slots and evict each other —
   which produces exactly the "authenticated — syncing" wedge documented in
   `DEBUGGING.md` §5. **One number must be linked by at most one install.**
3. **The server has no authentication.** Loopback binding + the `/api` origin guard *is*
   the security model (invariant 6). Sharing a DB would mean building auth first, and
   pointing two installs at one `app.db` over a network share corrupts it — SQLite WAL
   does not work over SMB/NFS.

**What this means when you write code.** There is no `users` table, no `assignee`, no
concept of "who". Don't add one halfway. A feature that only makes sense across people
(assignment, a shared board, "who is handling this client") does not belong in silo mode —
it belongs in the hub-and-spokes design, which is a different product and is not built.

**Per-machine setup, every time** (there is no MDM and no fleet management):

1. Copy the `.app`, then clear quarantine: `xattr -cr "/Applications/Asistente de Tareas.app"`.
2. Grant **Full Disk Access** to the app, then **fully quit and relaunch** (TCC only applies
   the grant on next launch).
3. Enter that person's own Anthropic API key in Ajustes. **Give each install its own key**
   — one key across N machines means no per-person budget, no attribution, and one leak
   revokes everybody.
4. **Choose the chat scope explicitly.** See the privacy note below — this step is not
   optional.
5. Connect that person's own WhatsApp number, and confirm no other install has it linked.

⚠️ **Privacy — do this before anyone else's Mac runs this app.** An empty chat selection
means **all chats**, so a default install ingests the user's entire personal iMessage and
WhatsApp history, sends message text and photos to the Claude API, and runs a classifier
that sorts their contacts into "Personal" vs "Oficina". That was fine when the only user
owned the business and the data. For anyone else it is an HR and, in several
jurisdictions, a legal problem. **On every install, select the work chats explicitly in
Ajustes before the first import**, and tell the person what is being read. The
`empty = all` semantics were left as-is deliberately — flipping them would silently change
behaviour on the existing installs that rely on it — so the safety here is procedural, and
the obvious next code change is a first-run scope gate that refuses to import until a
selection exists (§12).

---

## 2. Runtime architecture

```
┌─ Electron shell (electron/main.cjs) ────────────────────────────────┐
│  • single-instance lock                                             │
│  • resolves code root → ~/…/DadsApp/app  (Option B hot updates)     │
│  • import()s dist/server/index.js  IN-PROCESS  ← FDA inheritance    │
│  • BrowserWindow → http://localhost:4319                            │
│  • powerMonitor suspend/resume → stop/start WhatsApp                │
│  • will-navigate guard, window-open → external browser              │
└─────────────────────────────────────────────────────────────────────┘
              │ (same process)
┌─────────────▼───────────────────────────────────────────────────────┐
│  Express server (src/server/index.ts) — ~55 routes, loopback only   │
│   ├── ingest: iMessage reader (sync SQL) · WhatsApp mirror (async)  │
│   ├── pipeline: processNewMessages() → ClaudeExtractor → tasks      │
│   ├── chat agent: runTurn() — 6 tools, 5-turn loop                  │
│   ├── notify: cron digest · hourly nudge sweep · 5-min reminders    │
│   └── SQLite (better-sqlite3, synchronous, one shared connection)   │
└─────────────────────────────────────────────────────────────────────┘
```

**Why the server runs in-process:** Full Disk Access is granted to the `.app`; a child
process would not inherit it, so `chat.db` reads would fail.

**Timers running continuously** (all started in the `app.listen` callback):

| Timer | Interval | Does |
|---|---|---|
| `applySchedule()` cron | daily, configurable (default 07:00) | ingest → process → **digest** (digest fires even if processing throws) |
| `startNudgeLoop()` | hourly, only 08:00–21:00 | `runNudgeSweep()` — grouped escalating banner |
| reminder sweep | 5 min | native banner for `ai_reminders` that came due |
| wake detector | 30 s | wall-clock gap > 2 min ⇒ reconnect non-ready paired WA accounts |

---

## 3. Data model (`~/Library/Application Support/DadsApp/app.db`)

| Table | Purpose | Notes |
|---|---|---|
| `messages` | every ingested message, both sources | `UNIQUE(source, source_msg_id)` is the dedup key; `processed` flag drives the pipeline |
| `tasks` | proposed → todo → waiting → done / dismissed | soft-delete `deleted_at`, archive `archived_at`, `last_nudge_at` throttle |
| `clients` | handle → name, product need, category | `handle` UNIQUE; `category` = Personal/Oficina/custom/'' |
| `settings` | key/value store | API key, scheduler, chat selections, WA registry |
| `chat_threads` / `chat_messages` | assistant conversations | `attachments` is a JSON string. **Was missing from `schema.ts` until 1.7.2** — see invariant 17 |
| `chat_memory` | long-term facts the assistant saved | deduped on exact content |
| `ai_reminders` | one-off "recuérdame…" reminders | `notified_at` / `dismissed_at` lifecycle |

**Attachment columns are three parallel `'||'`-joined lists** on `messages`:
`attachment_mimes`, `attachment_names`, `attachment_paths`. **Index *i* must refer to
the same attachment in all three.** This is why the iMessage reader uses
`GROUP_CONCAT(COALESCE(col,''), '||')` and a position-preserving split — a NULL in any
one list would otherwise shift it and mis-pair files (fixed in 1.5.3).

**Settings keys in use:** `anthropic_api_key`, `daily_cron`, `scheduler_enabled`,
`reminders_enabled`, `nudge_interval_days`, `selected_chats`, `last_digest_seen`,
`wa_accounts`, and per-account `wa_selected_chats:<id>`, `wa_identity:<id>`, `wa_label:<id>`.

**`tasks.client_id` is reserved and has never been written** by any code path (verified: 0
rows in the live DB). The real task→contact link is **`client_hint`**, which holds a
*handle* when one resolved and free text otherwise. Every write path normalizes it through
`resolveClientHint()` in `names.ts` — added in 1.7.2, because until then the chat agent
wrote handles and the extractor wrote whatever display name the model produced, so one
client accumulated several spellings and the Clientes tab listed the unresolvable ones as
phantom contacts with 0 messages.

**Not in the DB:** the appearance preference (Ajustes → Apariencia) lives in
`localStorage` under `theme` (`auto` | `light` | `dark`). It is a display preference for
this machine, so it deliberately never touches the settings table or the server — which
is also why adding it needed no schema change and shipped as a normal code update. In silo
mode every per-machine preference is like this by definition: nothing follows a person to
another Mac.

---

## 4. Load-bearing invariants (break these and something silently rots)

1. **Never `kill -9` the server/app.** Orphaned puppeteer Chrome holds the WhatsApp
   session lock → next launch wedges at "loading 99%". Use Ctrl-C / ⌘Q.
2. **Both message sources stay read-only.** iMessage opens `readonly:true`; the WhatsApp
   mirror never sends. Do not add send/delete paths.
3. **`migrate()` runs BEFORE `exec(SCHEMA)`** in `db/index.ts` — `SCHEMA` has
   `CREATE INDEX` on columns an old DB may lack. Adding a column means editing
   **both** `schema.ts` (fresh installs) **and** `ensureColumn(...)` (existing DBs).
   See invariant 17 for what happens when you only do the second one.
4. **Rows are marked `processed = 1` only AFTER the extractor returns.** That's what
   makes an API failure safely retryable. The module-level `processingNow` flag is what
   stops a manual run and the cron from double-proposing the same rows.
5. **`source_quote` stays verbatim in the original language** — it is pasted into
   WhatsApp/iMessage search. Only `title`/`detail` are Spanish.
6. **The server binds to `127.0.0.1` and `/api` rejects cross-site requests.** There is
   no authentication; loopback + the origin guard *is* the security model. If remote
   access is ever wanted, add auth first.
7. **`electron/*.cjs` changes do NOT ship via online update.** They sit dormant until a
   new `.app` is built and AirDropped.
8. **All message-derived strings are HTML-escaped at render** (`esc()` in `app.js`).
   A contact's message text reaching `innerHTML` unescaped is a stored-XSS bug.
9. **`noUncheckedIndexedAccess` is on.** `arr[i] && arr[i].trim()` doesn't narrow —
   bind to a local first.
10. **`button:not(.tab)` is specificity (0,1,1) and sets `position: relative`** (it
    anchors the hover sweep). A bare `.my-button { position: absolute }` at (0,1,0)
    **loses** to it and silently stays in flow. Any absolutely-positioned button needs a
    selector that beats (0,1,1) — e.g. `.att-media .att-expand`. This exact trap shipped
    in 1.6.0 and broke the Adjuntos grid.
11. **A fixed-size thumbnail must not be a flex child.** Replaced elements (`<img>`,
    `<video>`) inside a flex container get re-sized from their own intrinsic aspect ratio
    against the container's definite height, so `width: 100%` does *not* mean "fill" —
    portrait media ends up in a narrow strip. Position them `absolute; inset: 0` and let
    `object-fit` crop. (Where aspect ratio *should* be preserved — the lightbox, the
    Proceso thumbnails — flex children are correct and intentional.)
12. **A button inside a scrolling flex column needs `flex: none`.** `button:not(.tab)`
    sets `overflow: hidden` (it clips the hover sweep), and that switches off the
    automatic `min-height: auto` which normally stops a flex item shrinking below its
    content. Without `flex: none` the rows silently compress — 101 sidebar rows in
    `.msg-chats` collapsed from 80px to 18px each, with every secondary line at zero
    height. Plain `div` rows (`.msg-row`) are unaffected because their overflow is visible.
13. **`--faint` does not clear AA on the translucent stacks.** It is calibrated for the
    surfaces it already sits on; over a glass bubble inside a glass thread over the
    ambient wash it composites to ~4.1:1, and under the `--accent-wash` of a selected
    row even `--muted` drops to 4.43:1. Sample the composited pixel (§10) rather than
    assuming a token is safe in a new context.
14. **The theme is always stamped explicitly.** An inline resolver in `index.html`'s
    `<head>` writes `<html data-theme="light|dark">` before first paint (no flash) and
    re-resolves on OS change when the preference is `auto`. `style.css` therefore has
    **no `prefers-color-scheme` query for tokens**: light lives in `:root`, dark in
    `:root[data-theme='dark']`. Adding a token means adding it to both.
15. **Every AI-proposed task insert goes through `saveTasks()`** (`extract/pipeline.ts`) —
    it holds the deterministic duplicate guard (§5). A new feature that INSERTs into
    `tasks` directly reopens the "repeat analysis re-creates existing tasks" bug that
    1.7.1 closed. (Manual creation by the owner is exempt by design; the chat agent's
    `create_task` applies the open-title rule itself.)
16. **`input.search` grows (`flex: 1`) for horizontal toolbars.** Inside a *column* flex
    container that growth is vertical — the input balloons to absorb whatever space the
    content below doesn't fill. Any `.search` in a column needs `flex: none`
    (see `.msg-side .search`).
17. **A migrated DB is not evidence that a fresh one works.** `ensureColumn()` returns
    early when the table doesn't exist, so a column added *only* to `migrate()` never
    reaches a new install. `chat_messages.attachments` went in that way in **0.3.0** and
    was never added to `schema.ts`: every DB created fresh from 0.3.0 to 1.7.1 lacked it
    and the **entire Chat tab 500'd on its first message**. It survived four minor versions
    because the only database anyone tested against predates 0.3.0 and got the migration.
    In silo mode every new employee *is* a fresh install, so this class of bug now ships to
    everyone at once. **`npm run smoke` asserts fresh-schema parity — run it before every
    release** (§10).
18. **Every silo is independent (§1a).** No `users` table, no assignee, no cross-install
    anything. Don't half-build a shared concept.
19. **`purge` is Trash-only.** Both bulk purge paths carry `AND deleted_at IS NOT NULL`.
    It is the one irreversible action in the API; the UI only offers it from the Papelera,
    and the SQL must enforce that too rather than trusting the caller.
20. **Clamp numeric params with `clampNum()`, never bare `Math.min(Math.max(Number(x)…))`.**
    That idiom propagates `NaN` — every comparison with `NaN` is false, so a hand-typed
    `?limit=abc` reached SQLite and 500'd the route with "datatype mismatch". `clampNum`
    falls back to the default instead (`server/index.ts`).
21. **A route that creates a thread must roll it back if the turn fails.** `POST /api/chat`
    and `/api/chat/upload` hoist `threadId`/`createdThread` above the `try` and
    `deleteThread()` in the `catch`. Without it every failed first message (bad key, no
    network) left an empty conversation in the sidebar, and each retry stacked another.

---

## 5. The two flows most likely to be misunderstood

### Import ≠ Process

- **Importar historial** only *stores* messages (`processed = 0`). WhatsApp count is
  **per chat**; iMessage count is **total**. Re-importing dedups to "0 nuevos".
- **Procesar mensajes nuevos** is what calls the AI and creates proposed tasks.
- Live WhatsApp capture (while connected) inserts rows automatically — no import needed.

### Processing order (changed in 1.5.3 — the fix for "recent messages never produce tasks")

Batches are selected **newest-first** (`ORDER BY ts DESC`, 120/batch, ≤10 batches ≈ 1,200
per click; the cron allows 50 batches), then **reversed within the batch** so the
extractor sees a chronological transcript. Before 1.5.3 this was oldest-first, so a large
history import buried the current week behind the backlog and those messages never
reached the extractor — while the chat agent still recalled them (its context query has
no `processed` filter), and re-imports reported "0 new". The `done` SSE event now carries
`remaining`, and the UI surfaces "quedan N mensajes antiguos en cola".

**Known gap (by design, revisit if it bites):** the chat selection in Ajustes filters
**ingestion**, not processing. Messages already imported from a chat that is later
deselected will still be analyzed while they remain unprocessed.

### Vision budgets (rebalanced in 1.7.0)

The budget is a count of `describeAttachment` calls, **shared across every batch of one
run**, and `enrichVision` now describes **every** qualifying attachment on a row rather
than only the first. Both of those used to lose data permanently, because a row is marked
`processed = 1` whether or not its files were ever looked at.

| Caller | Cap | Note |
|---|---|---|
| "Procesar mensajes nuevos" | 1000 (clamped ≤2000) | effectively "analyze every new file" |
| Nightly cron | **200** (was 20) | one run covers up to 50 × 120 = 6,000 messages |
| Mensajes → "Analizar" | ≤40 per run, 200 messages max | hand-picked; the UI states the file count up front |

### Re-analysis is a preview run

`analyzeSelection()` (Mensajes tab) deliberately **ignores and never sets `processed`**.
Re-checking a message therefore can't quietly drain it from the normal pipeline queue, and
the same selection can be run again. Proposed tasks land in Bandeja like any other. When it
creates nothing the modal says which of three things happened: the model proposed nothing
("already covered", with a **relatedness heuristic** listing open tasks from the same
source messages or client — not the extractor's actual dedup decision, which it doesn't
report); or its proposals were **refused as deterministic duplicates** (listed by name and
state); or a mix.

### Task dedup is two layers (1.7.1 — the "third Analizar re-created the task" fix)

Layer 1 is the prompt: the extractor is handed the open tasks and told not to duplicate
them. That guard is **probabilistic** and over repeated runs it slips — observed on the
third re-analysis of the same selection. Layer 2, `saveTasks()` in `extract/pipeline.ts`,
is **deterministic** and covers every save path (Analizar, Proceso, cron, plus the same
rule in the chat agent's `create_task`):

- refuse when an **open** task (proposed/todo/waiting, not archived/trashed) has the same
  `normTitle` (accent/case/punctuation-insensitive);
- refuse when a task in **any** state cites the same `source_message_id` with the same
  `normTitle` (re-analysis must not resurrect what the owner already finished or trashed);
- `done` alone does not block — a client re-requesting finished work is a new task;
- refusals come back as `duplicates` and are shown in the UI, never swallowed.

Known boundary: normTitle can't equate *semantically* different wordings of the same task —
that case still relies on layer 1.

---

## 6. Module map

| Area | File |
|---|---|
| Server + every HTTP route | `src/server/index.ts` |
| Paths/config (`dataDir`, `chatDbPath`, model) | `src/config.ts` |
| DB open + migrations | `src/db/index.ts`, `src/db/schema.ts` |
| iMessage reader (+ `attributedBody` decode) | `src/ingest/imessage/{reader,ingest,attributedBody}.ts` |
| WhatsApp mirror (multi-account, watchdogs, media) | `src/ingest/whatsapp/client.ts` |
| Extraction + live pipeline | `src/extract/{pipeline,claude,vision,types}.ts` |
| Message-browser queries (Mensajes tab) | `src/messages/browse.ts` |
| Chat agent (6 tools) | `src/chat/index.ts`, `src/chat/store.ts` |
| Client auto-tagging | `src/clients/classify.ts` |
| Reminders / digest / nudges | `src/notify/{reminders,scheduled,mac}.ts` |
| Name resolution | `src/names.ts`, `src/ingest/contacts.ts` |
| Settings + WA account registry | `src/settings.ts` |
| Diagnostics (DB binding, startup log) | `src/diagnostics.ts` |
| Electron shell / updater | `electron/{main,updater,preload}.cjs` |
| Fresh-install smoke test (`npm run smoke`) | `scripts/smoke-fresh-install.ts` |
| Release publisher | `scripts/release.mjs` |
| Frontend (no bundler, no framework) — see §6a | `public/{app.js,index.html,style.css}` |

**UI tabs:** Bandeja · Tareas · Archivo · Papelera · Clientes · Adjuntos · **Mensajes** · Chat · Proceso · Ayuda · Ajustes.

---

## 6a. The frontend, in more detail

No bundler, no framework, no npm packages in the browser. Three files:

| File | Holds |
|---|---|
| `public/style.css` | The whole design system. Tokens first (colour, type, space, radius, motion, z-scale), then components in the order the UI uses them, then keyframes, responsive, reduced-motion. |
| `public/index.html` | The theme resolver (inline, in `<head>`), the SVG icon sprite, the static shell of all ten panels. |
| `public/app.js` | All behaviour, plus the HTML template strings that render every list, card and overlay. |

**Colour.** OKLCH throughout. The accent is a deep marine teal, picked because blue,
green, amber and red already carry meaning here (iMessage badge, WhatsApp badge, "en
espera", destructive/overdue) — an accent in any of those hues would collide. Both
gradient stops of `.primary` have to clear 4.5:1 against `--accent-ink`, which is why
`--accent-hi` is a lift in chroma more than in lightness.

**Type.** System stack (SF Pro on macOS), fixed rem-ish scale, `tabular-nums`
everywhere numbers line up. Deliberately **no web fonts** — the app is fully offline and
local, and a Google Fonts request would add a network dependency that doesn't exist today.

**Icons.** One inline SVG sprite in `index.html` (`<symbol id="i-…">`), used as
`ico('name')` from `app.js` or `<svg class="ico"><use href="#i-…"/></svg>` in markup.
One stroke weight, coloured by `currentColor`. **Don't reintroduce emoji as structural
icons** — they were the single cheapest-looking thing in the pre-1.6 UI. Emoji is fine in
prose and notification text.

**Two components are ours because the native ones can't be themed:**
- **Date picker** (`.dp`, `openDatePicker` in `app.js`). Chromium's calendar panel is
  browser chrome and takes no CSS, so it is suppressed
  (`::-webkit-calendar-picker-indicator { display: none }` plus swallowing F4 / Space /
  Alt-Down) and replaced. It stays presentational: it writes the same `YYYY-MM-DD` into
  the same `<input type="date">` and fires the same `change` event, so every handler is
  untouched, and typing into the field still works. It renders into `<body>` with
  `position: fixed` so it escapes scrolling panels, and flips above the field when there
  is no room below.
- **Audio tiles.** Chromium drops the `<audio>` timeline below ~200px, so a 160px gallery
  tile can never show a scrubber or duration. The tile is an affordance; the Quick-Look
  overlay does playback (it already autoplayed).

The `<input type="time">` in Ajustes still uses the native picker — it's a small dropdown
rather than a full panel, so it was left alone.

---

## 7. HTTP API surface

All under `/api`, all loopback-only, all JSON unless noted.

**Tasks** `GET /inbox` · `GET /tasks` · `GET /archive` · `POST /tasks` ·
`POST /tasks/:id/status` · `POST /tasks/:id/due` · `POST /tasks/:id/archive` ·
`POST /tasks/bulk` *(status|archive|unarchive|delete|restore|purge|client|due)*

**Trash** `GET /trash` · `POST /trash/empty`

**Clients** `GET /senders` · `POST /clients` · `POST /clients/category` ·
`POST /clients/autoclassify` · `POST /clients/bulk` · `GET /namemap`

**Chat** `GET|POST /threads` · `GET|DELETE /threads/:id` · `POST /chat` ·
`POST /chat/upload` · `GET /memory` · `DELETE /memory/:id`

**Reminders** `GET /agenda` · `POST /agenda/:id/dismiss` · `DELETE /agenda/:id` ·
`GET /digest` · `POST /digest/seen` · `GET /reminders` ·
`POST /reminders/{test,digest,nudge}`

**WhatsApp** `GET|POST /whatsapp/accounts` · `DELETE /whatsapp/accounts/:id` ·
`POST /whatsapp/accounts/:id/{label,start,reset,repair,backfill}` ·
`GET /whatsapp/accounts/:id/status` · `GET|POST /whatsapp/accounts/:id/chats`

**Ingest/process** `POST /backfill` · `GET /process/stream` *(SSE)* · `GET /chats`

**Mensajes** `GET /messages/chats` · `GET /messages` *(chatId, dir=older|newer|around,
cursorTs+cursorId, q, unprocessed, withFiles)* · `GET /messages/search` ·
`GET /messages/locate?id=` · `POST /messages/reanalyze` *(ids, vision)* ·
`POST /messages/to-chat` *(ids → new thread)*. `POST /chat` also accepts `contextIds`.

**Attachments** `GET /attachment?id=&i=[&download=1]` *(binary)* · `GET /attachments` ·
`GET /attachments/locate?messageId=`

**Meta** `GET|POST /settings` · `GET /stats` · `GET /diagnostics`

---

## 8. Recipes for common changes

**Add a DB column** → add to `schema.ts` AND an `ensureColumn(...)` in `db/index.ts`.
Both, always (invariant 17 is what happens when you don't). Then add it to the `EXPECTED`
map in `scripts/smoke-fresh-install.ts` and run `npm run smoke`. Test a query against a
*copy* of the live DB, never the live one.

**Add an HTTP route** → put it in `src/server/index.ts` near its siblings. It inherits
the loopback + origin guard and the JSON error handler automatically. Clamp every numeric
param with **`clampNum(raw, dflt, lo, hi)`** (invariant 20). A route may throw freely —
the handler at the bottom of the file turns it into `{ error }` JSON — but a route that
*creates* something should still catch and roll back (invariant 21).

**Add a chat-agent tool** → append to `TOOLS` in `src/chat/index.ts` (Spanish
description), handle it in `execTool` (async, returns a short string), and mention it in
the `SYSTEM` prompt's tool list. The loop caps at 5 turns.

**Add a UI tab** → `<button class="tab" data-tab="x">` + `<section id="x" class="panel">`
in `index.html`, then a loader in the tab-switch handler in `app.js`. Escape everything
user-derived with `esc()`.

**Add an icon** → a `<symbol id="i-name" viewBox="0 0 24 24">` in the sprite at the top of
`index.html`, paths only (stroke/fill/width are inherited from `.ico`). Then `ico('name')`
in a template, or `<svg class="ico"><use href="#i-name"/></svg>` in markup.

**Add or change a colour** → edit **both** `:root` and `:root[data-theme='dark']` in
`style.css` (invariant 14). Then check it: sample the *composited* pixel rather than
trusting the token, because most surfaces are translucent glass over an ambient wash —
`getComputedStyle().backgroundColor` alone will lie to you. Recipe in §10.

**Position a button absolutely** → give the rule a selector that beats (0,1,1)
(invariant 10). A bare class will not work.

**Restyle a native control** → check first whether it's actually stylable. Form *fields*
are; the popups they summon (calendar, clock, `<select>` menu, media controls) are browser
chrome and take no CSS. Suppress and replace, or leave alone — don't ship a half-styled one.

**Add a setting** → read/write via `getSetting`/`setSetting`, expose it in
`GET/POST /api/settings`, wire the control in the Ajustes panel.

**Change UI copy about behavior** → check `public/index.html` in *two* places: the
inline `<details class="help-inline">` on the Proceso tab **and** the full Ayuda tab.

---

## 9. Environment variables

`ANTHROPIC_API_KEY` (in-app setting wins) · `CLAUDE_MODEL` · `DATA_DIR` · `CHAT_DB_PATH` ·
`HOST` (default `127.0.0.1`) · `PORT` (4319) · `HISTORY_DAYS` · `DAILY_CRON` ·
`WA_CHROME_PATH` · `WA_HEADLESS` · `WA_WEB_VERSION` · `WA_READY_TIMEOUT_MS` ·
`WA_MAX_ATTEMPTS` · `WA_SYNC_STALL_MS` · `WA_MAX_SYNC_RECYCLES` · `WA_MAX_MEDIA_BYTES` ·
`WA_MEDIA_TIMEOUT_MS` · `WA_ONDEMAND_MAX_BYTES` · `WA_ONDEMAND_TIMEOUT_MS` ·
`MIN_SHELL_VERSION` (release only) · `BACKFILL`/`EXTRACT_LIMIT`/`EXTRACT_VISION` (CLI only)

---

## 10. Verification & shipping

**Validate** (this project deliberately avoids live browser runs — starting the dev
server reconnects the owner's live WhatsApp session):

```bash
npx tsc --noEmit && node --check public/app.js && npm run smoke
```

**`npm run smoke` (`scripts/smoke-fresh-install.ts`) is the fresh-install gate.** It builds
a throwaway DB in a temp dir, asserts that the *fresh* schema carries every column the code
actually reads, and exercises the first-run write paths (chat thread + attachment
round-trip, memory dedup, `saveTasks` insert-then-refuse, `client_hint` normalization,
reminders ignoring the Papelera). It never touches the real DB and never calls the API.
Written because 1.7.1 and earlier had **no way to notice** that a fresh install was broken
— see invariant 17. When you add a column or a first-run path, extend it; a check that
can't go red is worth nothing, so confirm a new assertion fails before you make it pass.

**Testing a fresh install end-to-end** (the closest thing to a new employee's Mac, and
safe while the owner's app is running — a fresh `DATA_DIR` has no paired WhatsApp session,
so `startAllSessions()` never fires and no Chrome is launched):

```bash
DATA_DIR=/tmp/fresh PORT=4399 npx tsx src/server/index.ts
```

Stop it with **SIGTERM, never `kill -9`** (golden rule 1 applies to scratch instances too).

Static frontend changes can be verified by opening `public/index.html` directly in a
browser (no server, no WhatsApp). Read-only SQL against the real DB is safe with
`sqlite3 -readonly`.

**Verifying UI work properly — the offline harness.** Opening `index.html` raw gets you an
empty shell, because every view renders from `/api`. To exercise the real views without
starting the server, copy `public/` to a scratch directory and load a stub *before*
`app.js` that:

1. replaces `window.fetch` with a lookup table of canned `/api` responses;
2. stubs `EventSource` (the Proceso SSE stream) and `confirm`;
3. rewrites `/api/attachment?id=…` URLs onto real local files. Do this by patching the
   `innerHTML` setter on `HTMLTemplateElement.prototype` — `el()` builds every node
   through a `<template>`, whose content is **inert**, so nothing ever tries to load the
   fake URL first.

Seed it with the awkward cases, not the happy ones: a **portrait** video and photo, a PDF,
an unknown file type, and each unavailable state (`fetch` / `fda` / `missing`). Most of the
1.6.1 bugs were invisible on landscape images. `ffmpeg -f lavfi -i testsrc=size=1080x1920…`
generates the media. Convert any `.heic` fixture with `sips` first — `/api/attachment`
transcodes those before serving, so an un-converted one "fails to load" for a reason that
doesn't exist in the app.

**Two traps that produce convincing but false measurements:**

- **Check `window.innerWidth` before trusting geometry.** A freshly opened or re-navigated
  browser-pane tab can report a 0×0 viewport; everything then measures nonsense (bubbles
  "collapsed to 26px", rows "700px tall"). Resize the viewport, then measure.
- **Disable transitions before sampling colour.** `button:not(.tab)` transitions `color`, so
  flipping `data-theme` animates and `getComputedStyle` hands back an interpolated
  `oklab(...)`. Inject `*{transition:none!important;animation:none!important}` first. Without
  it, a perfectly fine `--muted` label reads as 1.06:1.

**Checking contrast.** Sample the composited pixel; don't reason about tokens. Walk up
from the element compositing every translucent ancestor background, then run WCAG on the
result. Feed colours through a 1×1 canvas (`fillStyle` + `getImageData`) to resolve them —
`getComputedStyle().color` returns raw `oklch(...)` that a naive regex will misread. Check
**both** themes; they fail independently.

Delete the harness when done — it must not end up in the repo or in a release bundle.

**Ship a code update** (JS/HTML/CSS — the normal path):

1. `npx tsc --noEmit && node --check public/app.js && npm run smoke` — all three.
2. Bump `version` in `package.json`.
3. `MIN_SHELL_VERSION=0.1.0 npm run release -- "notas en español"`
4. Verify: `curl -s https://api.github.com/repos/Cherynoble/asistente-de-tareas/releases/latest | grep tag_name`
   (the API's `latest` can lag ~1 min behind the publish)
5. **Every install** clicks **Ajustes → Buscar actualizaciones** → installs, relaunches, DB
   untouched. One release serves all silos, but each one updates on its own — nobody is
   updated automatically, so tell people, and expect version drift until §12's
   check-on-launch exists.

**Ship a new `.app`** (only for `electron/*.cjs` or native/dep changes): `npm run dist`,
AirDrop **to each Mac**, then `xattr -cr "…/Asistente de Tareas.app"` on each. Bump
`MIN_SHELL_VERSION` to force it. This is the expensive path in silo mode — batch shell
changes rather than shipping them one at a time.

⚠️ **Pushing to GitHub does not update anyone's app.** Only `npm run release` does.

---

## 11. Recently fixed — do not regress

**1.7.2** — the pre-silo audit. Everything here was found by reviewing the repo against
"can this ship to several Macs", and every item was reproduced before being fixed.

| Fix | Where |
|---|---|
| **The Chat tab was dead on every fresh install since 0.3.0.** `chat_messages.attachments` existed only as an `ensureColumn` migration, never in `schema.ts`; `migrate()` skips tables that don't exist yet, so a new DB never got it and `POST /api/chat` 500'd with *"table chat_messages has no column named attachments"* on the first message. Invisible until now because the only DB ever tested was the migrated original | `db/schema.ts` · invariant 17 |
| Trashed tasks were still "open" to the reminders engine — `openTasks()` lacked `deleted_at IS NULL`, so a task in the Papelera nudged forever and inflated the morning digest. Same class as the 1.7.1 `loadOpenTasks` fix, which closed the extractor's copy of this query and missed this one | `notify/reminders.ts` |
| 40 of 60 routes had no try/catch, so any throw fell through to Express's **default** handler: an HTML stack trace leaking absolute filesystem paths, and a frontend that calls `.json()` on everything dying with `Unexpected token '<'`. Added a 4-arg `/api` error handler returning `{ error }` | `server/index.ts` |
| `?limit=abc` reached SQLite as `NaN` and 500'd the route — the documented `Math.min(Math.max(Number(x)…))` clamp propagates NaN. Replaced with `clampNum()` at all 8 sites | `server/index.ts` · invariant 20 |
| Bulk `purge` hard-deleted by id with **no Trash check** on either tasks or clients — the one irreversible action in the API, unguarded | `server/index.ts` · invariant 19 |
| A failed chat turn left an orphan empty thread (created before the call, never rolled back); every retry stacked another. Reproduced on a fresh install | `server/index.ts` · invariant 21 |
| `client_hint` was written inconsistently — handles by the chat agent, model-produced display names by the extractor. 9 of 13 distinct values in the live DB were not handles (chat titles, group names, space-formatted phone numbers that can never match). Now normalized through one shared `resolveClientHint()`, which also matches on digits | `names.ts`, `extract/pipeline.ts` |
| No index for the Mensajes pager: it filters `chat_id` but the planner used `idx_messages_ts` and scanned. Added `idx_messages_chat_ts` | `db/schema.ts` |
| `tasks.client_id` documented as reserved-and-never-written, so nobody writes a JOIN against it expecting rows | `db/schema.ts` |
| **New:** `npm run smoke` — the fresh-install gate that would have caught the first two items | `scripts/smoke-fresh-install.ts` |

**1.7.1**

| Fix | Where |
|---|---|
| Repeated "Analizar" of the same selection could re-create an existing task — the only dedup was the model's judgment (probabilistic; slipped on the third run). Deterministic `saveTasks()` guard added, covering Analizar / Proceso / cron; refused proposals are reported to the UI as `duplicates` | `extract/pipeline.ts` · §5, invariant 15 |
| Chat agent's `create_task` had the same hole (a retried tool call or a repeated ask stacked duplicate todos) — now reports the existing open task instead | `chat/index.ts` |
| `loadOpenTasks` fed **trashed** tasks to the extractor as "already open", silently suppressing valid proposals | `extract/pipeline.ts` |
| Mensajes sidebar search input ballooned vertically when results were short (`input.search`'s toolbar `flex: 1` acting on a column axis) | `style.css` · invariant 16 |
| "Enviar al Chat" double-click created orphan empty threads (no in-flight guard, unlike Analizar) | `app.js` `msgToChat` |
| Out-of-order sidebar-search responses: a slow reply for an earlier query overwrote the newer results | `app.js` `runMsgSearch` |
| Failed thread fetch left "Cargando…" on screen forever | `app.js` `openMsgChat` |
| A message body containing the literal `⟦/SELECCIÓN⟧` sentinel broke the collapsed transcript in Chat (untrusted text terminating the block early) | `extract/pipeline.ts` `selectionTranscript` |
| `related` heuristic skipped its same-source-message leg whenever no client hint resolved (e.g. an outgoing-only selection) | `extract/pipeline.ts` |

**1.7.0**

| Fix | Where |
|---|---|
| `enrichVision` described only the **first** attachment on a message — a client sending five product photos contributed one description at any budget, and the row was then marked processed, so the rest was lost for good | `extract/pipeline.ts` |
| Nightly cron's vision cap of 20 spread across up to 6,000 messages; a busy night's photos went undescribed and unrecoverable | `server/index.ts` · §5 |
| Sidebar rows collapsed 80px → 18px: buttons in a scrolling flex column, `overflow:hidden` killing `min-height:auto` | `style.css` · invariant 12 |
| Jump-to-date loaded the right window but scrolled to the bottom of it, landing on a later day than the one requested | `app.js` `renderMsgThread` |
| `#msg-visopt` was queried by id but the element only had the class — `renderMsgSelection` threw, breaking selection entirely | `index.html` |
| Chips sharing a row with a 128px media tile were stretched to its height (`align-items` defaulting to `stretch`) | `style.css` |
| `--faint` metadata missed AA on the bubble/sidebar glass stacks | `style.css` · invariant 13 |

**1.6.1** (all in `public/`, all presentational)

| Fix | Where |
|---|---|
| `button:not(.tab)`'s `position: relative` outranked `.att-expand`'s `absolute` → the button stayed in the flex flow, centred itself in the tile and stole 28px, squeezing every placeholder 160px → 132px (regression from 1.6.0) | `style.css` · invariant 10 |
| Thumbnails as flex children were re-sized from their intrinsic aspect ratio → portrait video/photos rendered in a narrow strip (pre-existing, predates the redesign) | `style.css` · invariant 11 |
| `<audio>` in a 160px tile has no scrubber and no duration (Chromium collapses it) → tile is now an affordance, overlay plays | `app.js` `attMediaHtml` |
| PDF / audio / generic file tiles had no surface of their own and read as failed tiles; generic label said "archivo", repeating the filename below it | `style.css`, `app.js` `attExt` |

**1.6.0** — full visual redesign: OKLCH token system, light + dark, SVG icon sprite
replacing emoji, custom date picker, Apariencia setting. Contrast was raised across the
board to clear AA in both themes; **don't lighten `--muted` / `--faint` or the status
colours** without re-sampling (§10).

**1.5.3**

| Fix | Where |
|---|---|
| Server bound to all interfaces, unauthenticated → loopback + `/api` host/origin guard | `server/index.ts` |
| `applyUpdate` accepted any zip URL over IPC → repo-release allowlist | `electron/updater.cjs` |
| Empty assistant reply persisted → poisoned the thread forever | `chat/index.ts` |
| `GROUP_CONCAT` NULL-skip mis-paired attachment mime/name/path | `ingest/imessage/reader.ts` |
| Digest skipped whenever the cron's AI pass threw | `server/index.ts` |
| Vision budget spent on files not on disk (dead temp paths) | `extract/pipeline.ts` |
| Oldest-first processing buried recent messages | `extract/pipeline.ts` |
| `/api/attachment` 404'd real files with a NULL mime | `server/index.ts` |

---

## 12. Open items / candidate next work

**Silo rollout — ranked, the ones that actually matter**

- **First-run scope gate (privacy).** Highest priority. Today `empty = all chats`, so a
  default install reads the person's entire personal message history (§1a). The semantics
  weren't flipped because that would silently change behaviour on existing installs; the
  fix is a first-run state that refuses to import until a selection exists, leaving
  `empty = all` meaningful only for already-configured installs.
- **Apple Developer ID + notarization ($99/yr).** Removes the `xattr -cr` Terminal step
  from every machine, which is the single worst part of the install and the one most likely
  to generate support calls. Best money available here.
- **Update integrity.** `electron/updater.cjs` validates the zip's **URL** but not its
  contents — no hash, no signature. With one install that's a small risk; across N machines
  a GitHub compromise is code execution on all of them simultaneously. Put a SHA-256 in the
  manifest and verify it before `swapIn`.
- **Version drift.** Updates are opt-in (the user clicks "Buscar actualizaciones"), so N
  machines will sit on N versions with no way to see which. An update check on launch — even
  just a badge — is cheap and worth it now.
- **`electron/*.cjs` changes are O(N) manual AirDrops** (invariant 7). Unchanged by silo
  mode, but it now costs N times as much. Keep shell changes rare and batched.
- **No health visibility.** Nothing reports that someone's WhatsApp has been disconnected
  for a week or that their processing queue is backed up; `startup.log` is local-only.
  Ajustes → Diagnóstico is the place to surface "last successful ingest / WA state / queue
  depth" prominently.
- **Per-install API keys and cost.** No budget, no attribution, no rate limit. One employee
  clicking "Procesar" through a large backlog is real money. Separate keys per install
  (§1a) at minimum.
- **The morning cron only fires if the Mac is awake at that minute.** `node-cron` does not
  catch up a missed run. Fine on the always-on Mac Studio, unreliable on a laptop that
  sleeps — which is what most employees have. The launch digest partly covers it; a
  "missed yesterday's run" catch-up on boot would close it.

**Performance — fine at today's ~17k messages, not at a year of team history**

- **Vision descriptions are computed, used once and discarded.** `enrichVision` folds the
  text into `r.body` in memory; the row is then marked processed and the description is
  gone. Persisting it to a column would make attachments searchable, feed the chat agent
  for free, and stop re-analysis paying twice. Cheapest high-value change in the codebase.
- **`nameMap()` is uncached and called per request** — three full scans of `messages`
  (`DISTINCT sender`, plus `GROUP BY sender, sender_name` over every row) on every Mensajes
  page, attachment list and chat turn. Needs a TTL cache invalidated on client writes (the
  live-rename path in `app.js` depends on it being fresh).
- **No FTS.** `search_messages` and the Mensajes search are `body LIKE '%q%'` full scans.
  SQLite FTS5 over `body` is the standard fix.

**Chat agent cost/UX**

- **`buildContext()` runs inside the 5-turn tool loop**, so 100 tasks + all clients + 150
  messages + 40 memories are re-queried and re-sent on every iteration.
- **Prompt caching is currently impossible**: the system prompt starts with
  `new Date().toString()` (seconds included), so every call has a unique prefix. Move the
  timestamp into the user turn and mark the static block `cache_control`.
- **No streaming and no timeout** — a tool loop with two `read_attachment` calls can run
  ~60s with no feedback, which reads as a frozen app.

**Pre-existing**

- **Not yet shipped to Dad:** the updater URL allowlist (needs a new `.app`).
- **Voice notes now play in the preview overlay, not in the gallery tile** (§6a). If that
  turns out to be annoying in daily use, the alternative is letting audio cards span two
  grid columns so the native player has the ~200px it needs.
- **The appearance preference is per-machine** (`localStorage`, not the DB), so it does
  not follow him to another Mac. Fine for a single-machine app; revisit only if that
  changes.
- **No automated coverage of the UI.** The offline harness in §10 is rebuilt by hand each
  time; the geometry assertions it produces (tile fills its slot, corner controls land at
  the corner, contrast ≥ 4.5:1 in both themes) are the obvious thing to make permanent.
- **Processing ignores chat selection** for already-imported messages (§5). Worth revisiting
  now: under the privacy rules in §1a, a chat someone *deselects* should arguably stop being
  analyzed, not just stop being imported.
- **Backend test coverage is thin.** `npm run smoke` (1.7.2) covers fresh-install schema
  parity and the first-run write paths — the natural next additions are the pipeline's
  batching/vision-budget logic and the reminder throttle, both of which are pure functions
  over a scratch DB and would fit the same file.
- **iMessage temp-path attachment loss** is unrecoverable by design — `chat.db` points at
  purged `/var/folders/…` paths. Count them with the SQL in `DEBUGGING.md` §6.
- **WhatsApp on-demand media is unreliable for old messages** (`getMessageById` fails far
  back); recovery is reconnect + re-run Importar historial.
- **Optional polish never done:** app icon (`.icns`), app-attributed native notifications,
  Apple notarization (needs a paid Developer account).
- **WhatsApp Web mirroring is against WhatsApp ToS** — read-only lowers risk but a ban
  would hit the whole number. Keep the library current, one stable session, home IP.
