# Dad's App — Project State & Contributor Guide

**Snapshot: version 1.6.1 (released 2026-07-25).** This is the "how it actually works
and how to change it safely" document. The other two docs cover different questions:

| Doc | Answers |
|---|---|
| `CLAUDE.md` | *What is this and why* — product intent, locked decisions, historical progress log |
| `DEBUGGING.md` | *It's broken, where do I look* — symptom → cause → fix runbook |
| **`PROJECT_STATE.md`** (this) | *What's the current shape and how do I extend it* — architecture, data model, invariants, API surface, recipes |

---

## 1. One-paragraph summary

A single-user macOS Electron app for a trading-company owner (the owner's father).
It mirrors his **iMessage** (read-only from `chat.db`) and **WhatsApp** (read-only
Web mirror) into one local SQLite DB, runs them through **Claude Haiku** to propose
follow-up tasks he'd otherwise forget, and nags him until they're done. Everything is
local: no server, no accounts, no telemetry. The UI is a Spanish-language local web app
served by an in-process Express server at `localhost:4319` — vanilla HTML/CSS/JS, no
bundler and no framework, styled as a translucent "liquid glass" surface with light and
dark themes (§6a).

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
| `chat_threads` / `chat_messages` | assistant conversations | `attachments` is a JSON string |
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

**Not in the DB:** the appearance preference (Ajustes → Apariencia) lives in
`localStorage` under `theme` (`auto` | `light` | `dark`). It is a display preference for
this machine, so it deliberately never touches the settings table or the server — which
is also why adding it needed no schema change and shipped as a normal code update.

---

## 4. Load-bearing invariants (break these and something silently rots)

1. **Never `kill -9` the server/app.** Orphaned puppeteer Chrome holds the WhatsApp
   session lock → next launch wedges at "loading 99%". Use Ctrl-C / ⌘Q.
2. **Both message sources stay read-only.** iMessage opens `readonly:true`; the WhatsApp
   mirror never sends. Do not add send/delete paths.
3. **`migrate()` runs BEFORE `exec(SCHEMA)`** in `db/index.ts` — `SCHEMA` has
   `CREATE INDEX` on columns an old DB may lack. Adding a column means editing
   **both** `schema.ts` (fresh installs) **and** `ensureColumn(...)` (existing DBs).
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
12. **The theme is always stamped explicitly.** An inline resolver in `index.html`'s
    `<head>` writes `<html data-theme="light|dark">` before first paint (no flash) and
    re-resolves on OS change when the preference is `auto`. `style.css` therefore has
    **no `prefers-color-scheme` query for tokens**: light lives in `:root`, dark in
    `:root[data-theme='dark']`. Adding a token means adding it to both.

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
| Chat agent (6 tools) | `src/chat/index.ts`, `src/chat/store.ts` |
| Client auto-tagging | `src/clients/classify.ts` |
| Reminders / digest / nudges | `src/notify/{reminders,scheduled,mac}.ts` |
| Name resolution | `src/names.ts`, `src/ingest/contacts.ts` |
| Settings + WA account registry | `src/settings.ts` |
| Diagnostics (DB binding, startup log) | `src/diagnostics.ts` |
| Electron shell / updater | `electron/{main,updater,preload}.cjs` |
| Frontend (no bundler, no framework) — see §6a | `public/{app.js,index.html,style.css}` |

**UI tabs:** Bandeja · Tareas · Archivo · Papelera · Clientes · Adjuntos · Chat · Proceso · Ayuda · Ajustes.

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

**Type.** System stack (SF Pro on his Mac), fixed rem-ish scale, `tabular-nums`
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

**Attachments** `GET /attachment?id=&i=[&download=1]` *(binary)* · `GET /attachments` ·
`GET /attachments/locate?messageId=`

**Meta** `GET|POST /settings` · `GET /stats` · `GET /diagnostics`

---

## 8. Recipes for common changes

**Add a DB column** → add to `schema.ts` AND an `ensureColumn(...)` in `db/index.ts`.
Both, always. Test a query against a *copy* of the live DB, never the live one.

**Add an HTTP route** → put it in `src/server/index.ts` near its siblings. It inherits
the loopback + origin guard automatically. Validate/clamp every numeric query param
(`Math.min(Math.max(Number(x), lo), hi)`) — the existing routes all do.

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
`style.css` (invariant 12). Then check it: sample the *composited* pixel rather than
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
npx tsc --noEmit && node --check public/app.js
```

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
generates the media.

**Checking contrast.** Sample the composited pixel; don't reason about tokens. Walk up
from the element compositing every translucent ancestor background, then run WCAG on the
result. Feed colours through a 1×1 canvas (`fillStyle` + `getImageData`) to resolve them —
`getComputedStyle().color` returns raw `oklch(...)` that a naive regex will misread. Check
**both** themes; they fail independently.

Delete the harness when done — it must not end up in the repo or in a release bundle.

**Ship a code update** (JS/HTML/CSS — the normal path):

1. Bump `version` in `package.json`.
2. `MIN_SHELL_VERSION=0.1.0 npm run release -- "notas en español"`
3. Verify: `curl -s https://api.github.com/repos/Cherynoble/asistente-de-tareas/releases/latest | grep tag_name`
   (the API's `latest` can lag ~1 min behind the publish)
4. Dad: **Ajustes → Buscar actualizaciones** → installs, relaunches, DB untouched.

**Ship a new `.app`** (only for `electron/*.cjs` or native/dep changes): `npm run dist`,
AirDrop, then `xattr -cr "…/Asistente de Tareas.app"` on his Mac. Bump `MIN_SHELL_VERSION`
to force it.

⚠️ **Pushing to GitHub does not update Dad's app.** Only `npm run release` does.

---

## 11. Recently fixed — do not regress

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
- **Processing ignores chat selection** for already-imported messages (§5).
- **No automated tests.** `tsc` + `node --check` + manual is the whole safety net;
  the pipeline and reminder logic are the obvious first candidates for unit tests.
- **iMessage temp-path attachment loss** is unrecoverable by design — `chat.db` points at
  purged `/var/folders/…` paths. Count them with the SQL in `DEBUGGING.md` §6.
- **WhatsApp on-demand media is unreliable for old messages** (`getMessageById` fails far
  back); recovery is reconnect + re-run Importar historial.
- **Optional polish never done:** app icon (`.icns`), app-attributed native notifications,
  Apple notarization (needs a paid Developer account).
- **WhatsApp Web mirroring is against WhatsApp ToS** — read-only lowers risk but a ban
  would hit the whole number. Keep the library current, one stable session, home IP.
