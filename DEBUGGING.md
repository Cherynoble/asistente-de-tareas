# Dad's App — Debugging Runbook

A field guide for diagnosing this app fast. Read `CLAUDE.md` for *what the app is*;
this file is for *when something breaks, where to look*. Optimized for symptom → cause → fix.

**App:** local Electron task-tracker. Ingests iMessage (`chat.db`, read-only) + WhatsApp
(read-only Web mirror), runs an Express server in-process, proposes tasks via Claude Haiku,
shows a local web UI at `localhost:4319`. **SILO MODE:** deployed to several Macs in the
office, each a fully independent install with its own database and nothing shared — see
`PROJECT_STATE.md` §1a. Current version at time of writing: **1.7.2** (see `package.json`).

---

## 0. Golden rules (do not violate — these cause data loss / corruption)

1. **NEVER `kill -9` the server or app.** A hard kill can't run `stopWhatsApp()`, so it
   orphans the puppeteer Chrome, which keeps the WhatsApp `SingletonLock` + a half-written
   session → next launch hangs at **"loading 99% / authenticated — syncing"**. Always stop
   with **Ctrl-C / SIGTERM** (or Cmd-Q for the app). Recovery if it happens: the app
   self-heals on next start (`cleanupSession()`), or use the UI **Reconectar / Volver a vincular**.
   Applies to throwaway scratch instances too.
2. **NEVER delete or risk `~/Library/Application Support/DadsApp/`.** It holds the DB
   (`app.db`), the WhatsApp session (`*/wwebjs_auth`), and downloaded media (`wa_media/`).
   The `.app` bundle never contains data — this dir is the only copy. **In silo mode there
   is no other copy anywhere**: no server, no sync, no backup. Losing one person's dir loses
   that person's entire history.
3. **Both message sources are READ-ONLY.** iMessage is opened `readonly:true`; the WhatsApp
   mirror never sends. Don't add send/delete paths.
4. **Iterate with `npm run dashboard`.** Only `npm run dist` when you need a new native `.app`.
5. Starting the dev server **reconnects the live WhatsApp session** — avoid it if the owner's
   app is running (two clients on one number → "authenticated — syncing" wedge). To test
   safely, run against a **fresh `DATA_DIR` on a spare port** (§7) — a fresh dir has no
   paired session, so no Chrome is ever launched.
6. **One WhatsApp number, one install.** Two installs linking the same number fight for a
   linked-device slot (WhatsApp allows 4) and evict each other, producing the exact
   "authenticated — syncing" wedge in §5. When someone reports that symptom, **ask who else
   linked that number before touching anything else.**
7. **A migrated DB proves nothing about a fresh one.** Every new employee is a fresh
   install. Run **`npm run smoke`** before every release — see §7 and `PROJECT_STATE.md`
   invariant 17.

---

## 0a. Silo-mode install checklist (per Mac, in this order)

Nothing here is automatable — there is no MDM. Getting the order wrong is the most common
source of "it doesn't work on the new machine".

1. Copy the `.app`, then **`xattr -cr "/Applications/Asistente de Tareas.app"`** — without
   it an AirDropped copy is rejected as "damaged" (§5).
2. Grant **Full Disk Access**, then **fully quit and relaunch**. TCC only applies the grant
   on the *next* launch; skipping the relaunch is why FDA "doesn't work" (§5).
3. Enter **that person's own** Anthropic API key in Ajustes. One key across machines means
   no budget, no attribution, and one leak revokes everyone.
4. **Select the work chats explicitly, before the first import.** Empty selection = *all
   chats* = their entire personal message history goes to the API. This step is a privacy
   requirement, not a preference — `PROJECT_STATE.md` §1a.
5. Connect **their own** WhatsApp number. Confirm no other install has it linked (rule 6).
6. Import history, then Procesar. Verify in **Ajustes → Diagnóstico** that the data dir is
   `~/Library/Application Support/DadsApp` and message counts are non-zero.

**Health check on any machine:** Ajustes → Diagnóstico shows which DB the process bound to,
per-source message counts + last timestamps, and the unprocessed backlog. That is the whole
of the observability story right now (`PROJECT_STATE.md` §12).

---

## 1. Where everything lives (module map)

| Area | File(s) |
|---|---|
| Server + all HTTP routes | `src/server/index.ts` (the big one) |
| Config / paths (`dataDir`, `chatDbPath`, model) | `src/config.ts` |
| DB open + **migrations** (`ensureColumn`) | `src/db/index.ts` |
| Schema (fresh installs) | `src/db/schema.ts` |
| iMessage reader (`chat.db` SQL, `attributedBody` decode) | `src/ingest/imessage/reader.ts`, `.../attributedBody.ts`, `.../ingest.ts` |
| WhatsApp mirror (session, watchdogs, media download) | `src/ingest/whatsapp/client.ts` |
| Task extraction + live pipeline (SSE) | `src/extract/pipeline.ts`, `src/extract/claude.ts`, `src/extract/vision.ts` |
| Message browser queries (Mensajes tab) | `src/messages/browse.ts` |
| Chat agent (tools: search/find/read_attachment, memory, create_task) | `src/chat/index.ts`, `src/chat/store.ts` |
| Client auto-tagging (Personal/Oficina) | `src/clients/classify.ts` |
| Reminders / digest / nudges | `src/notify/reminders.ts`, `.../scheduled.ts`, `.../mac.ts` |
| Name resolution (manual > Contacts > pushname) | `src/names.ts`, `src/ingest/contacts.ts` |
| Settings store (API key, chat selection, WA accounts) | `src/settings.ts` |
| Boot maintenance (sticker purge) | `src/maintenance.ts` |
| Electron shell (window, in-proc server, single-instance) | `electron/main.cjs` |
| Online updater (download + atomic swap + relaunch) | `electron/updater.cjs`, `electron/preload.cjs` |
| Release publisher | `scripts/release.mjs` |
| Fresh-install smoke test (`npm run smoke`) | `scripts/smoke-fresh-install.ts` |
| Frontend (all UI logic) | `public/app.js`, `public/index.html`, `public/style.css` |

**UI tabs:** Bandeja · Tareas · Archivo · Papelera · Clientes · Adjuntos · **Mensajes** · Chat · Proceso · Ayuda · Ajustes.

---

## 2. Runtime data locations (on the user's Mac)

- **App data (writable):** `~/Library/Application Support/DadsApp/`
  - `app.db` — the app's SQLite DB (messages, tasks, clients, settings, chat, memory)
  - `<accountId>/wwebjs_auth/` — WhatsApp session (per account, e.g. `acc1`)
  - `wa_media/<accountId>/` — downloaded WhatsApp attachments
  - `wwebjs_cache/` — WhatsApp Web version cache (must be writable — see §5)
- **Installed app code (Option B online updates):** `~/Library/Application Support/DadsApp/app/`
  seeded from the bundle; `node_modules` symlinked to the bundle. Updates swap `dist/`+`public/` here.
- **iMessage source (read-only, needs FDA):** `~/Library/Messages/chat.db` (+ `-wal`, `-shm`)
- **iMessage attachments (read-only, needs FDA):** `~/Library/Messages/Attachments/…`
- **Dev DB:** `./data/app.db` (used only if it exists — see `resolveDataDir()` in `config.ts`).

**Every path above is per-machine and per-macOS-user.** In silo mode nothing is shared and
nothing is backed up anywhere — `DadsApp/` is the only copy of that person's history.

---

## 3. Quick commands

```bash
npm run dashboard      # run server at localhost:4319 (Ctrl-C to stop, NEVER kill -9)
npx tsc --noEmit       # full typecheck (must be clean before shipping)
node --check public/app.js   # syntax-check the frontend (no bundler/tsc for JS)
npm run smoke          # fresh-install gate: schema parity + first-run paths (§7)
npm run db:init        # create/verify data/app.db
npm run dist           # build a new native .app (only for shell/native-dep changes)
```

Run a **throwaway install** without touching the real one or the live WhatsApp session:

```bash
DATA_DIR=/tmp/fresh PORT=4399 npx tsx src/server/index.ts
```

Inspect the live DB safely (read-only, won't disturb the app):
```bash
DB="$HOME/Library/Application Support/DadsApp/app.db"
sqlite3 -readonly "$DB" "SELECT source, COUNT(*) FROM messages GROUP BY source;"
```

---

## 4. Release & update mechanics (how a fix reaches Dad)

**Two delivery paths:**

- **Online update (default — pure JS/HTML/CSS/dist changes):**
  1. `npx tsc --noEmit && node --check public/app.js && npm run smoke` (§7).
  2. Bump `version` in `package.json`.
  3. `MIN_SHELL_VERSION=0.1.0 npm run release -- "notas en español"`
     → builds `dist/`, zips `dist`+`public`, publishes a GitHub Release tagged `code-vX.Y.Z`.
  4. Verify: `curl -s https://api.github.com/repos/Cherynoble/asistente-de-tareas/releases/latest | grep tag_name`
  5. **Each person** clicks **Ajustes → Buscar actualizaciones** → downloads + atomic swap +
     relaunch. DB untouched. One release serves every silo, but updates are **opt-in per
     machine** — nobody is updated automatically, so tell people, and expect the fleet to sit
     on mixed versions. When diagnosing anything, **ask which version that machine is on**
     (Ajustes shows it).
- **New `.app` (only for `electron/*.cjs` shell changes or native-dep/ABI changes):**
  `npm run dist` → ad-hoc-signed `.app` in `/Users/cherynoble/dadsapp-release/mac-arm64/`,
  AirDrop **to every Mac**, then `xattr -cr` on each. Bump `MIN_SHELL_VERSION` to force it.
  This is O(N) manual work in silo mode — batch shell changes instead of drip-feeding them.

**Key rule:** changes under `electron/` do **not** ship via online update — they sit dormant
until a new `.app` is built. (e.g. the `will-navigate` guard added in 1.2.1.)

---

## 5. Symptom → cause → fix (the important part)

### WhatsApp

| Symptom | Likely cause | Fix / check |
|---|---|---|
| Stuck "authenticated — syncing" on **one machine while another person uses the same number** | **Two installs linked to one WhatsApp number** — they compete for a linked-device slot (max 4) and evict each other. The #1 silo-mode failure | Decide who owns that number, **Volver a vincular** there, and remove the account from every other install (Ajustes → eliminar cuenta). Golden rule 6 |
| Stuck "loading 99%" / "authenticated — syncing", 0 messages | Orphaned Chrome from a prior `kill -9` holding the session lock | `cleanupSession()` self-heals on next start; else UI **Reconectar**; last resort **Volver a vincular**. Check for stray Chrome: `ps -axo pid,command \| grep wwebjs_auth`. **Stop gracefully next time.** |
| Same, only in the packaged `.app` (dev works) | `LocalWebCache.persist()` writing to CWD `/` (read-only) — **historical, fixed** | `webVersionCache` is pinned to `dataDir/wwebjs_cache` in `client.ts`. If it regresses, that's the place. |
| "Couldn't link device" during pairing | WhatsApp Web build too old to link | Pin a newer build only to LINK: `WA_WEB_VERSION=...` (remote cache), reconnect on default. |
| Sync wedged with no progress for minutes | genuinely stuck sync | Progress-aware watchdog (`armSyncWatchdog`, `SYNC_STALL_MS`, `MAX_SYNC_RECYCLES`) auto-recovers, keeps session (no QR). Bounded; then asks to re-pair. |
| Signed out after laptop sleep | macOS killed Chrome on sleep | Wake detector in `main.cjs`/`server` resets non-ready paired accounts. |

### iMessage / Full Disk Access

| Symptom | Cause | Fix / check |
|---|---|---|
| "No se puede acceder a iMessage" in Ajustes, chat list empty | FDA not *effective* for the running process | **Fully quit + relaunch** (TCC applies FDA only on next launch). Then remove & re-add the app in System Settings → Privacy → **Acceso total al disco**. Ensure a single copy of the app. |
| SQLite error `unable to open database file` | **Ambiguous** — means *either* missing file *or* permission denied | Can't distinguish from the message. Verify externally: `sqlite3 -readonly ~/Library/Messages/chat.db "SELECT count(*) FROM chat;"` (works from an FDA'd process like Claude.app). |
| **All** attachment tiles unavailable on a machine | No effective FDA → every `~/Library/Messages/Attachments` read fails | Same FDA fix above. The `state:'fda'` tile ("🔒 Activa Acceso total al disco") is the tell. |

### Attachments / Adjuntos gallery (availability model — 1.3.0+)

Each tile has a server-computed `state` (`/api/attachments`, `attachmentState()` in `server/index.ts`):

| state | meaning | UI |
|---|---|---|
| `ok` | file on disk | renders |
| `fda` | iMessage file, but process lacks FDA | 🔒 "Activa Acceso total al disco" |
| `missing` | file not on this Mac (deleted / iCloud-offloaded / **iMessage temp-path loss**) | 🚫 "no está en este Mac" |
| `fetch` | WhatsApp media not downloaded yet | ⬇ "ver archivo" button (on-demand) |

- **iMessage temp-path loss (unrecoverable):** some attachments were captured with a transient
  `/var/folders/.../TemporaryItems/…` path that macOS purged and **never persisted** to `Attachments/`.
  `chat.db` still points at the dead temp path, so re-resolving by guid returns the same dead path.
  Count them: `... WHERE source='imessage' AND attachment_paths LIKE '/var/folders/%'`.
- **WhatsApp on-demand is unreliable for OLD messages:** `getMessageById()` often fails for
  history far back, so `fetch`-state tiles may not load. **Recovery: connect WhatsApp, then
  re-run Importar historial** — `persist()` backfills images/PDFs onto pathless rows.
- **Download white-screen (fixed 1.2.1):** a plain `<a href>` to `/api/attachment` navigated the
  Electron window → blank. Downloads now go through `downloadFile()` (blob + object-URL). If it
  regresses, that's the pattern to keep.

### Electron shell gotchas (these bite repeatedly)

- **`window.prompt()` does nothing** — Electron silently returns null. Use the in-app
  `askText()` modal in `app.js` (added 1.5.1). Same for blocking `alert/confirm`.
- **Top-level navigation white-screens the SPA.** `main.cjs` has a `will-navigate` guard
  blocking `/api/` navigations (ships only with a new `.app`). Keep links from navigating the
  top frame; use blob downloads / `target=_blank` (which `setWindowOpenHandler` sends to the
  real browser).
- **Native module ABI mismatch** (`NODE_MODULE_VERSION 147 vs 146`): system Node is ABI 147,
  Electron needs 146. `npm run dist` handles it: `electron-rebuild` (from source) + `npmRebuild:false`
  + restore Node ABI after. Verify a **DB-backed** route (`/api/stats`), not just `/`.
- **AirDrop "damaged and can't be opened":** broken ad-hoc sig. `npm run sign:adhoc` fixes it;
  on the receiving Mac clear quarantine with `xattr -cr "…/Asistente de Tareas.app"`.
- **CSS specificity trap:** `button:not(.tab)` (0,1,1) beats a bare `.chip`/`.ql-btn` (0,1,0).
  Scope custom button styles under a parent (`.clientcats .chip`, `.ql-overlay .ql-btn`).
- **Buttons collapsing inside a scrolling flex column:** the same base rule sets
  `overflow: hidden`, which disables the automatic `min-height: auto` that stops a flex item
  shrinking below its content. Symptom: list rows squash to ~18px and their secondary lines
  render at zero height. Fix is `flex: none` on the row (see `.msg-chats .msg-chat`).
- **`input.search` has `flex: 1` for horizontal toolbars** — inside a COLUMN flex container
  that grow applies vertically, so the input balloons to fill whatever the content below
  leaves free (bit the Mensajes sidebar in 1.7.0: a search with few hits stretched the box to
  hundreds of px). Any `.search` placed in a column needs `flex: none` (see `.msg-side .search`).

### Fresh installs (the silo-mode failure class)

These break on a **new** machine while working perfectly on an old one. Suspect this
category first whenever "it works on Dad's Mac but not on hers".

| Symptom | Cause | Fix / check |
|---|---|---|
| Chat tab errors on the very first message; `{"error":"table chat_messages has no column named attachments"}` | **Historical, fixed in 1.7.2.** `attachments` was added to `migrate()` in 0.3.0 and never to `schema.ts`; `ensureColumn` skips tables that don't exist yet, so no fresh DB from 0.3.0–1.7.1 ever had it | Fixed in `db/schema.ts`. If anything like it recurs, `npm run smoke` names the missing column and the table |
| Any route answers with an **HTML stack trace** instead of JSON; the UI shows `Unexpected token '<'` | **Historical, fixed in 1.7.2** — 40 routes had no try/catch and fell through to Express's default handler | A 4-arg `/api` error handler now returns `{ error }`. If you see raw HTML again, someone registered a route *after* it |
| A route 500s with `datatype mismatch` on a hand-typed URL | **Historical, fixed in 1.7.2** — the old clamp idiom propagated `NaN` into SQL | Use `clampNum(raw, dflt, lo, hi)` for every numeric param |
| Sidebar filling with empty untitled conversations | **Historical, fixed in 1.7.2** — a failed chat turn created the thread and never rolled it back; each retry stacked another | `POST /api/chat` + `/upload` now `deleteThread()` in the catch. A burst of these means turns are *failing* — check the API key first |
| A brand-new install shows nothing anywhere | Expected until step 4–6 of the §0a checklist are done | Ajustes → Diagnóstico: confirm the data dir and that message counts are non-zero |

**The general rule:** reproduce on a fresh DB before believing a fix.
`DATA_DIR=/tmp/fresh PORT=4399 npx tsx src/server/index.ts`, or `npm run smoke` for the
non-interactive version.

### Database / migrations

- **Migration order matters:** `migrate()` (ensureColumn) runs **before** `exec(SCHEMA)` in
  `db/index.ts`, because `SCHEMA` has `CREATE INDEX` on columns an old DB may lack (crashed a
  0.1 DB historically). Add every column current code reads to `migrate()`.
- **AND to `schema.ts`. Both, always** — this is the one that actually bit (invariant 17).
  A column added only to `migrate()` never reaches a new install, and the failure is
  invisible on any machine that has been upgraded rather than installed fresh. After adding
  one, extend `EXPECTED` in `scripts/smoke-fresh-install.ts` and run `npm run smoke`.
- **`tasks.client_id` is reserved and has never been written.** `client_hint` is the real
  task→contact link. Don't write a JOIN against `client_id` expecting rows.
- **`noUncheckedIndexedAccess` is on.** Repeated index access (`arr[i] && arr[i].trim()`)
  doesn't narrow — bind to a local first: `const p = arr[i]; p && p.trim()`.
- Adding a column: add to `schema.ts` (fresh installs) **and** an `ensureColumn(...)` in
  `db/index.ts` (existing DBs). Both, always.

### Task pipeline / extraction

- **Processing is newest-first**, batched (`processNewMessages`, `ORDER BY ts DESC`, ~1200/click;
  each batch fed to the extractor in chronological order). Today's messages are always analyzed
  on the next run; an imported-history backlog is chewed through on later runs / the nightly cron.
  The Proceso status line shows "quedan N mensajes antiguos en cola" while a backlog remains.
  (Was oldest-first before 1.5.3 — a history import buried recent messages behind the backlog,
  so tasks from them never appeared even though the chat could recall them.)
- **Concurrency guard:** module-level `processingNow` flag prevents the manual run + daily cron
  from double-proposing the same rows.
- **Vision budget** = number of `describeAttachment` calls, shared across ALL batches of a run.
  Since 1.7.0 `enrichVision` describes **every** qualifying attachment on a message, not just
  the first (a 5-photo message used to yield one description at any cap), and the nightly cron's
  cap went 20 → 200. Both mattered because the row is marked `processed = 1` regardless, so an
  undescribed file is lost permanently. Caps: manual "Procesar" 1000, cron 200, Mensajes
  selection ≤40.
- **"Analizar" in Mensajes is a preview run** (`analyzeSelection`): it ignores and never sets
  `processed`, so re-checking can't drain the pipeline queue and is repeatable. If it creates
  nothing, the modal says exactly why — either the model proposed nothing, or its proposals
  were refused as duplicates (listed with their state).
- **Task dedup is TWO layers (1.7.1).** Layer 1 is the prompt ("do not re-propose open tasks")
  — probabilistic, and it *does* slip on repeated runs (observed: the third "Analizar" of the
  same selection re-created a task the first two runs declined). Layer 2 is deterministic, in
  `saveTasks()` (`pipeline.ts`), covering every save path (Analizar / Proceso / cron): an
  insert is refused when (a) an OPEN task (proposed/todo/waiting, not archived/trashed) has
  the same `normTitle` (accent/case/punctuation-insensitive), or (b) a task in ANY state cites
  the same `source_message_id` with the same `normTitle` (re-analysis must not resurrect what
  the owner already did or trashed). `done` alone does NOT block — a re-request of finished
  work is a new task. Refusals return as `duplicates` and surface in the UI. The chat agent's
  `create_task` has guard (a) too. **If duplicates ever reappear, suspect a title the model
  worded differently** — normTitle can't equate semantically different titles; that boundary
  is deliberate.
- **`loadOpenTasks` must exclude the Papelera** (`deleted_at IS NULL`) — before 1.7.1 trashed
  tasks were fed to the extractor as "already open", silently suppressing valid proposals.
  **`openTasks()` in `notify/reminders.ts` had the same hole until 1.7.2**: a trashed task
  stayed "open" to the digest and nudge sweep, so it re-notified forever with no way to stop
  it short of emptying the trash. **Any new "what's open?" query needs all three clauses:**
  `status IN (...) AND archived_at IS NULL AND deleted_at IS NULL`. That predicate is
  currently duplicated across **7 sites** (`reminders.ts` ×1, `chat/index.ts` ×2,
  `pipeline.ts` ×3, `server/index.ts` ×1) — which is exactly why it has now been got wrong
  twice. Before adding an eighth, run
  `grep -rn "archived_at IS NULL AND deleted_at IS NULL" src/` and check you match them;
  better still, factor it into one shared constant.
- **`client_hint` is normalized on write** (1.7.2) through `resolveClientHint()` in
  `names.ts` — the single definition shared by the extractor and the chat agent. It resolves
  a display name, a partial name, or a differently-formatted phone number down to a handle,
  and passes anything unresolvable (a group title) through as a label. Symptom when this
  breaks: the Clientes tab grows phantom contacts with 0 messages, one per spelling.
- **Import ≠ process:** "Importar historial" only fills the DB; "Procesar mensajes nuevos"
  analyzes unprocessed rows. WhatsApp import count is **per chat**; iMessage is **total**.
- Extractor keeps `source_quote` verbatim (used for WhatsApp/iMessage text search); `title`/`detail` are Spanish.

### Chat agent

- Context = 150 recent messages + open tasks + clients + memories. Tools: `search_messages`
  (full history), `find_attachments`, `read_attachment` (vision via `describeAttachment`),
  `save_memory`, `create_task`, `schedule_reminder`. `execTool` is async; loop caps at 5 turns.
- If the bot "can't find" old context, it should be calling `search_messages` — check the
  tool wiring in `src/chat/index.ts`.

---

## 6. Diagnostic SQL cookbook

```bash
DB="$HOME/Library/Application Support/DadsApp/app.db"

# Message + attachment counts by source
sqlite3 -readonly "$DB" "SELECT source, COUNT(*) FROM messages GROUP BY source;"
sqlite3 -readonly "$DB" "SELECT source, COUNT(*), SUM(attachment_paths<>'') AS has_path
  FROM messages WHERE has_attachment=1 GROUP BY source;"

# iMessage attachments that are genuinely lost (dead temp paths)
sqlite3 -readonly "$DB" "SELECT COUNT(*) FROM messages
  WHERE source='imessage' AND attachment_paths LIKE '/var/folders/%';"

# Unclassified clients (candidates for auto-tag)
sqlite3 -readonly "$DB" "SELECT COUNT(*) FROM (
  SELECT m.sender FROM messages m LEFT JOIN clients c ON c.handle=m.sender
  WHERE m.sender IS NOT NULL AND m.sender!='me' AND (c.category IS NULL OR c.category='')
  GROUP BY m.sender);"

# Task pipeline state
sqlite3 -readonly "$DB" "SELECT status, COUNT(*) FROM tasks
  WHERE deleted_at IS NULL AND archived_at IS NULL GROUP BY status;"
sqlite3 -readonly "$DB" "SELECT COUNT(*) AS unprocessed FROM messages WHERE processed=0;"

# Trashed tasks that a buggy "open" query would still nudge (must be 0 in effect)
sqlite3 -readonly "$DB" "SELECT COUNT(*) FROM tasks
  WHERE status IN ('todo','waiting') AND archived_at IS NULL AND deleted_at IS NOT NULL;"

# client_hint values that are NOT real handles — phantom clients in the Clientes tab
sqlite3 -readonly "$DB" "SELECT h FROM (SELECT DISTINCT client_hint h FROM tasks
  WHERE client_hint != '') WHERE h NOT IN
  (SELECT DISTINCT sender FROM messages WHERE sender IS NOT NULL);"

# Does THIS machine's fresh-schema match what the code reads? (non-destructive)
npm run smoke
```

To test a query that references a column only added by a pending migration, copy the DB to a
temp file and `ALTER TABLE … ADD COLUMN …` there first (never mutate the live `app.db`).

---

## 7. Verification note

**Before every release, all three:**

```bash
npx tsc --noEmit && node --check public/app.js && npm run smoke
```

**`npm run smoke` is the fresh-install gate** (`scripts/smoke-fresh-install.ts`). It builds a
throwaway DB in a temp dir and asserts that the *fresh* schema carries every column the code
reads, then exercises the first-run write paths. It never touches the real DB and never calls
the API. It exists because nothing in this project could previously notice that a new install
was broken — the Chat tab was dead on fresh installs for four minor versions.

When you extend it, **confirm the new assertion goes red first.** A check that can't fail is
worse than no check: it reports confidence it hasn't earned.

**Testing a full fresh install end-to-end** — safe to run while someone's real app is live,
because a fresh `DATA_DIR` has no paired WhatsApp session and therefore never launches Chrome:

```bash
DATA_DIR=/tmp/fresh PORT=4399 npx tsx src/server/index.ts   # SIGTERM to stop, never kill -9
```

**The offline harness is how frontend work gets verified** while the owner's WhatsApp session
is live (recipe in `PROJECT_STATE.md` §10). Two things that will waste your time otherwise:

- **Check `window.innerWidth` before trusting any geometry.** A newly opened or re-navigated
  browser-pane tab can report a 0×0 viewport, in which case every width/height you measure is
  garbage (bubbles "collapse to 26px", rows look 700px tall). Resize, then measure.
- **Disable transitions before sampling colour.** `button:not(.tab)` transitions `color`, so a
  theme flip animates and `getComputedStyle` returns a mid-flight `oklab(...)` value. Inject
  `*{transition:none!important;animation:none!important}` first, or you will chase contrast
  "failures" that do not exist.

Live browser verification against the real dev server is **skipped** in this project because
starting it reconnects the owner's live WhatsApp session. Changes are validated by `tsc --noEmit`
+ `node --check` + read-only SQL against the real DB. When a change is genuinely frontend-only
and the app isn't running, a throwaway dev instance can be used — but confirm the WhatsApp
session isn't live first.

---

## 8. History

Per-version change log lives in the auto-memory: `MEMORY.md` → `update-architecture.md`
(entries for every release 1.0.x–1.5.x, each with the *why* and the gotcha it addressed).
Feature/decision rationale is in `CLAUDE.md`.
