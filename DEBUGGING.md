# Dad's App — Debugging Runbook

A field guide for diagnosing this app fast. Read `CLAUDE.md` for *what the app is*;
this file is for *when something breaks, where to look*. Optimized for symptom → cause → fix.

**App:** local Electron task-tracker. Ingests iMessage (`chat.db`, read-only) + WhatsApp
(read-only Web mirror), runs an Express server in-process, proposes tasks via Claude Haiku,
shows a local web UI at `localhost:4319`. Single user (the owner's father, on his Mac).
Current version at time of writing: **1.5.1** (see `package.json`).

---

## 0. Golden rules (do not violate — these cause data loss / corruption)

1. **NEVER `kill -9` the server or app.** A hard kill can't run `stopWhatsApp()`, so it
   orphans the puppeteer Chrome, which keeps the WhatsApp `SingletonLock` + a half-written
   session → next launch hangs at **"loading 99% / authenticated — syncing"**. Always stop
   with **Ctrl-C / SIGTERM** (or Cmd-Q for the app). Recovery if it happens: the app
   self-heals on next start (`cleanupSession()`), or use the UI **Reconectar / Volver a vincular**.
2. **NEVER delete or risk `~/Library/Application Support/DadsApp/`.** It holds the DB
   (`app.db`), the WhatsApp session (`*/wwebjs_auth`), and downloaded media (`wa_media/`).
   The `.app` bundle never contains data — this dir is the only copy.
3. **Both message sources are READ-ONLY.** iMessage is opened `readonly:true`; the WhatsApp
   mirror never sends. Don't add send/delete paths.
4. **Iterate with `npm run dashboard`.** Only `npm run dist` when you need a new native `.app`.
5. Starting the dev server **reconnects the live WhatsApp session** — avoid it if the owner's
   app is running (two clients on one number → "authenticated — syncing" wedge).

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

---

## 3. Quick commands

```bash
npm run dashboard      # run server at localhost:4319 (Ctrl-C to stop, NEVER kill -9)
npx tsc --noEmit       # full typecheck (must be clean before shipping)
node --check public/app.js   # syntax-check the frontend (no bundler/tsc for JS)
npm run db:init        # create/verify data/app.db
npm run dist           # build a new native .app (only for shell/native-dep changes)
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
  1. Bump `version` in `package.json`.
  2. `MIN_SHELL_VERSION=0.1.0 npm run release -- "notas en español"`
     → builds `dist/`, zips `dist`+`public`, publishes a GitHub Release tagged `code-vX.Y.Z`.
  3. Verify: `curl -s https://api.github.com/repos/Cherynoble/asistente-de-tareas/releases/latest | grep tag_name`
  4. Dad clicks **Ajustes → Buscar actualizaciones** → downloads + atomic swap + relaunch. DB untouched.
- **New `.app` (only for `electron/*.cjs` shell changes or native-dep/ABI changes):**
  `npm run dist` → ad-hoc-signed `.app` in `/Users/cherynoble/dadsapp-release/mac-arm64/`,
  AirDrop it, then `xattr -cr` on the receiving Mac. Bump `MIN_SHELL_VERSION` to force it.

**Key rule:** changes under `electron/` do **not** ship via online update — they sit dormant
until a new `.app` is built. (e.g. the `will-navigate` guard added in 1.2.1.)

---

## 5. Symptom → cause → fix (the important part)

### WhatsApp

| Symptom | Likely cause | Fix / check |
|---|---|---|
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

### Database / migrations

- **Migration order matters:** `migrate()` (ensureColumn) runs **before** `exec(SCHEMA)` in
  `db/index.ts`, because `SCHEMA` has `CREATE INDEX` on columns an old DB may lack (crashed a
  0.1 DB historically). Add every column current code reads to `migrate()`.
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
  `processed`, so re-checking can't drain the pipeline queue and is repeatable. If it proposes
  nothing, that is usually the dedup working — the extractor is given the open tasks.
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
```

To test a query that references a column only added by a pending migration, copy the DB to a
temp file and `ALTER TABLE … ADD COLUMN …` there first (never mutate the live `app.db`).

---

## 7. Verification note

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
