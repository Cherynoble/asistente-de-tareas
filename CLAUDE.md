# Dad's App — Trading-Company Task Tracker

## What this is
A local app for the owner's father, who runs a trading company. He hand-messages
20+ clients/day on WhatsApp and coordinates an office team in an iMessage group
chat. He forgets product requests clients make (e.g. "consult factories about
toilet paper"), which delays work for days. This app ingests his messages, uses
AI to propose tasks, tracks their progress, and sends reminders until they're done.

Single user: the father. He reviews/uses it on his Mac.

## 🔖 NEW PHASE (2026-06-26) — version control + new features — read this first
We moved past "feature-complete" into adding features, with proper infra:
- **Git + GitHub:** repo at https://github.com/Cherynoble/asistente-de-tareas (public,
  owner `Cherynoble`). `.gitignore` excludes `.env`, `data/`, `dist/`, `.wwebjs_*`,
  `.claude/settings.local.json`. **Iterate with `npm run dashboard`; only run `npm run
  dist` to deliver a new native shell.**
- **Option B online updates (DONE & validated):** the packaged app runs `dist/`+`public/`
  from a writable external dir `~/Library/Application Support/DadsApp/app/` (seeded from
  the bundle, `node_modules` symlinked to the bundle). `package.json build.asar:false`.
  A code update is a **GitHub Release** (`npm run release -- "notas"` → zip + manifest);
  the in-app updater (`electron/updater.cjs` + `preload.cjs`, "Buscar actualizaciones" in
  Ajustes / app menu) downloads + atomically swaps + relaunches — **no repackage, no
  re-sign, DB untouched**. `manifest.minShellVersion` gates the rare case needing a fresh
  `.app`. So **Dad downloads updates; you only re-AirDrop the `.app` for native/dep
  changes** (then bump `MIN_SHELL_VERSION`). Shell + release are both 0.1.1.
- **Names (DONE):** real contact names now resolve via `src/names.ts` `nameMap()`
  (manual > macOS Contacts `src/ingest/contacts.ts` > captured WhatsApp pushname), served
  through `/api/namemap` (flows everywhere). Contacts read needs FDA (degrades gracefully).
  `Clientes`/`/api/senders` is limited to chats selected in Ajustes (per-source, empty=all).
- **All requested features DONE (shipped through 0.3.0):** real contact names; search +
  multi-select + bulk actions across tabs; pipeline wrap fix; Papelera (Trash) for tasks +
  clients; chat threads + long-term memory (save_memory tool); AI creates tasks from chat
  (create_task, auto-links client); AI schedules reminders (schedule_reminder) with a
  ⏰ Recordatorios subtab + native sweep + ☀️ "Buenos días" launch digest; image/PDF upload
  in chat (vision); chat-inclusion picker has search + resolved names. Bandeja's "Descartar"
  was removed (Trash supersedes it).
- **Tool-using chat agent** (`src/chat/index.ts` runTurn): Haiku loop with save_memory /
  create_task / schedule_reminder tools; context includes current datetime + capped memory.
- **Current version 0.3.0** (shell still 0.1.x; all updates ship online via GitHub Releases,
  minShellVersion 0.1.0 since no new deps). Bump version + `MIN_SHELL_VERSION=0.1.0 npm run
  release -- "notas"` to publish; Dad clicks "Buscar actualizaciones".

## 🔖 HANDOFF STATE (2026-06-25) — earlier baseline
The app is **feature-complete and bundled**; we're in the final "iron out kinks" phase.
- **Deliverable:** signed, unsigned-but-ad-hoc `.app` at
  `/Users/cherynoble/dadsapp-release/mac-arm64/Asistente de Tareas.app`. Rebuild with
  `npm run dist` (self-contained: build → electron-rebuild → package → ad-hoc sign →
  restore Node ABI). All fixes below are IN this build.
- **All major bugs fixed & documented in the progress log**, including the big one:
  the bundled-app WhatsApp "authenticated — syncing" hang was `LocalWebCache.persist()`
  throwing under the `.app`'s read-only CWD `/` — fixed by pinning `webVersionCache` to
  the writable `dataDir`. Also: native-module ABI (electron-rebuild + npmRebuild:false),
  ad-hoc signing (AirDrop "damaged" fix), self-healing WhatsApp startup, single-instance
  lock, Spanish localization, reminders, concurrency guard.
- **WhatsApp end-to-end VERIFIED working** ✅ — a clean pairing reaches `ready` and
  captures messages; the bundled-app cache-crash fix (below) resolved the stuck
  "authenticated — syncing" hang. No longer an open item.
- **No known open kinks.** Previously-suspected items are all confirmed non-issues:
  the dock icon is fine (not bouncing), and the accidental 11k-message import is fine
  (analyzing all of it via Haiku is cheap, ≈$1–2; backfill imports newest-N and
  "Procesar" works through unprocessed oldest-first). The app is ready for handoff.
- **Blank-state reset** (per machine): quit the app, delete
  `~/Library/Application Support/DadsApp/`, reopen → fresh DB, no session, no key. The
  `.app` itself never bundles data/session, so it's blank on any machine that hasn't run it.
- **Operational rule:** never `kill -9` the server/app — shut down gracefully (it closes
  WhatsApp's Chrome cleanly). A hard kill orphans Chrome / can log out the session.

## Current status (as of 2026-06-21)
Building a TEST version on the owner's own Mac first (host app for Claude Code is
the Claude desktop app at `/Applications/Claude.app` — it needs Full Disk Access
to read `chat.db`). The test reads the owner's own iMessages and pairs the
owner's own WhatsApp to prove the pipeline; later we point it at the father's
office group chat and move it to the always-on **Mac Studio**. Code does not
change between test and prod — only which account/chat it reads.

### Progress log
- ✅ Phase 0: Node/TS project, deps, SQLite schema (`messages`, `clients`,
  `tasks` + attachment columns). `npm run db:init` → `data/app.db`.
- ✅ Phase 1 (iMessage) **done & validated** with Full Disk Access granted to
  Claude.app. `attributedBody` decoder: 887/888 (99.9%). Attachments captured
  (type + filename); `￼` placeholder handled. ~2900 msgs persisted, deduped,
  incremental. `npm run imessage:ingest`.
- ✅ Phase 2 (extraction) **validated**: provider-agnostic `src/extract/`
  (interface + `ClaudeExtractor` on `claude-haiku-4-5`, JSON structured output,
  lenient prompt). `selftest.ts` → correctly pulls tasks (incl. photo-as-signal,
  deadlines) from synthetic business msgs; 0 from personal chatter (no
  hallucination). `npm run extract` saves tasks as `proposed`. Key in `.env`.
- ✅ Vision on attachments: `src/extract/vision.ts` describes images (HEIC→JPEG
  via `sips`) and PDFs with Claude; validated on real photos + PDFs (correct
  business-relevance filtering, no false tasks). Wired into `npm run extract`
  via `EXTRACT_VISION=1` (capped by `EXTRACT_VISION_CAP`, default 10), so a
  product photo / PDF quote can become a task. `npm run vision:test` is a probe.
- ✅ Phase 3 (dashboard) **built & validated**: local web app (`src/server/` +
  `public/`, Express, port 4319). Three tabs — **Inbox** (approve→todo /
  dismiss proposed tasks), **Tasks** (todo→waiting→done by status), **Pipeline**
  (live SSE: every message sifted + every image/PDF analyzed with thumbnail +
  Claude's read + tasks proposed). Window size and vision cap (max images, 1–50,
  clamped server-side) are adjustable in the Pipeline UI. Reusable
  `src/extract/pipeline.ts` powers both the CLI and dashboard SSE. `npm run dashboard`.
  - ⚠️ **The dashboard process needs Full Disk Access** to read/convert
    attachment files (same as ingest). Launching via the Claude app / a FDA
    terminal works; a process without FDA serves tasks but can't load images.
  - HEIC→JPEG uses `/usr/bin/sips` (absolute path — not always on $PATH).
    StickerCache (stickers/memoji) attachments are skipped for vision.
- ✅ **Continuous DB + task management** (Pass 1 of the "real product" build):
  - **Backfill** most recent N messages (`backfillByCount`, `/api/backfill`,
    UI button) — count-based, in addition to the day-window incremental ingest.
  - **Incremental processing**: `processNewMessages()` chews UNPROCESSED messages
    (`processed=0`) in batches, marks them processed; `/api/process/stream` (SSE)
    first pulls new iMessages then processes. Dedups against open tasks (passed to
    the extractor). Bounded by `maxBatches`/`visionCap` per call.
  - **Searchable task references**: tasks carry `source_quote` — a verbatim
    snippet the owner pastes into WhatsApp/iMessage search (no opaque msg #).
  - **Task management UI**: manual create (`POST /api/tasks`, →todo), free status
    transitions in any direction (status `<select>`), Archive tab + `archived_at`
    (`/api/archive`, `/api/tasks/:id/archive {undo}`). Tasks: proposed→todo→
    waiting→done, dismissed, archived.
  - Schema: `tasks` gained `source_quote`, `archived_at` (migrated via ALTER on
    the live db; schema.ts has them for fresh installs).
- ✅ **Pass 2** (sender naming · chat · scheduler):
  - **Sender naming** (#6): `Clients` tab lists distinct senders w/ msg counts;
    name a handle + add a "what they buy" note (`/api/senders`, `/api/clients`
    upsert by handle, `/api/namemap`). UI resolves handle→name everywhere
    (inbox, tasks, pipeline) via `displayName()`. Product-need is fed to the
    extractor as context.
  - **Chat tab** (#7): `src/chat/` — talk to Haiku with DB context (open tasks +
    named clients + most-recent 250 messages). `POST /api/chat {messages}`.
  - **Daily scheduler** (#8): `node-cron` in the server runs ingest +
    `processNewMessages` daily (default `0 7 * * *`, set `DAILY_CRON`; needs the
    server process to stay up — fine on the always-on Mac Studio).
  - Dashboard tabs now: Inbox · Tasks · Archive · Clients · Chat · Pipeline.
- ✅ **Settings tab + portability** (Pass 3):
  - `settings` table + `src/settings.ts` (key/value store). **In-app API key**
    (runtime via `anthropicClient()`, falls back to `.env`) — no file editing on
    a fresh install. **Scheduler config** (on/off + time, live-reschedulable via
    `applySchedule()`). **iMessage chat selection**: `Settings` tab lists chats
    (`listChats()` from chat.db) w/ counts; `selected_chats` filters ingestion
    (`readMessagesSince`/`readRecentMessagesByCount` take a chats arg). Empty = all.
  - **Portability fix**: `config.dataDir` now resolves to `./data` in dev (if
    `data/app.db` exists) else `~/Library/Application Support/DadsApp` — so a
    bundled .app (cwd can be `/`) writes its DB to a stable user-writable path.
  - Tabs now: Inbox · Tasks · Archive · Clients · Chat · Pipeline · Settings.
- ✅ **Bundling — Electron .app** DONE & validated (double-click, no terminal):
  - `electron/main.cjs` boots the Express server **in-process** (so FDA granted to
    the .app applies to its `chat.db` reads), waits for it, then opens a window at
    `localhost:4319`; closes WhatsApp's Chrome cleanly on quit (the corruption fix).
  - Build: `npm run build` (tsc → `dist/` via `tsconfig.build.json`, NodeNext ESM)
    then `electron-builder`. Scripts: **`npm run dist`** (unsigned `.app` in
    `/Users/cherynoble/dadsapp-release/mac-arm64/`), `npm run dist:dmg`, `npm run app`
    (dev: build + `electron .`). `build` config in package.json: `identity:null`
    (unsigned), `asarUnpack` better-sqlite3 (native).
  - **Validated**: built "Asistente de Tareas.app" (345 MB), launched, served HTTP
    200, native better-sqlite3 loaded under Electron, created a FRESH DB at
    `~/Library/Application Support/DadsApp` (portability dataDir working), Spanish UI
    served, graceful quit left 0 orphan Chrome.
  - **Gotchas (solved)**: (1) electron-builder rejects an output dir with shell-
    special chars — the project lives in `…/Dad's app` (apostrophe+space), so
    `directories.output` is an absolute clean path (`/Users/cherynoble/dadsapp-release`).
    (2) **Native-module ABI (critical — caused a "NODE_MODULE_VERSION 147 vs 146"
    crash)**: system Node is ABI 147, Electron 42 needs ABI 146. electron-builder's
    own rebuild step pulled a **prebuilt** better-sqlite3 (still 147) instead of
    compiling for Electron, so the packaged app crashed the moment any route touched
    the DB (static routes still 200 — so verify with a **DB-backed route like
    `/api/stats`**, not just `/`). Fix, baked into the scripts: `dist` runs
    **`electron-rebuild -f -w better-sqlite3 -m .`** (force from-source → ABI 146)
    with **`npmRebuild:false`** so electron-builder packages that exact binary, then
    **`npm rebuild better-sqlite3`** to restore Node ABI 147 for the tsx dev workflow.
    So `npm run dist` is self-contained: build → electron-rebuild → package → restore.
    Verified: packaged `/api/stats` → 200 JSON, and `npm run dashboard` still works.
  - **Code signing (AirDrop "damaged" fix)**: electron-builder with `identity:null`
    left only a broken linker ad-hoc sig (`Identifier=Electron`, resources unsealed)
    → `codesign --verify` FAILS → an AirDropped (quarantined) copy is rejected as
    **"damaged and can't be opened"** (no open path). Fix baked into `dist` via
    **`npm run sign:adhoc`** (`codesign --force --deep --sign -` → valid ad-hoc sig:
    `Identifier=com.dadsapp.asistente`, sealed resources, "satisfies its Designated
    Requirement"). After this it's the NORMAL unsigned-app flow ("could not verify"),
    which IS openable. (True notarization still needs an Apple Dev account.)
  - **Install on the father's Mac**: copy the `.app` to /Applications (or anywhere)
    → **clear the AirDrop quarantine**: Terminal `xattr -cr "/path/Asistente de
    Tareas.app"` (one command; then it just double-click opens). *Without* clearing,
    the fallback is double-click → "could not verify" → System Settings → Privacy &
    Security → **Open Anyway**. Then: grant **Full Disk Access** to "Asistente de
    Tareas" (System Settings → Privacy) → enter the Anthropic key in *Ajustes* →
    connect WhatsApp (scan QR) + pick chats → select iMessage chats + backfill.
    (macOS 26 removed the old right-click→Open Gatekeeper bypass, so it's
    `xattr -cr` or "Open Anyway".)
  - ⬜ Optional polish: app icon (`.icns` in `build/`; currently default Electron
    icon), and native notifications attributed to the app (osascript banners
    currently attribute to the script host). Notarization needs an Apple Dev account.
- ✅ **Phase 1 (WhatsApp half)** DONE & validated — paired, reconnects to `ready`,
  backfilled 415 msgs from 117 chats; text + media markers persist (source='whatsapp').
  - `src/ingest/whatsapp/client.ts`: `whatsapp-web.js` + `LocalAuth` (session in
    `dataDir/wwebjs_auth`), **read-only** (never sends). Emits QR (rendered as a
    PNG data URL via `qrcode`), reaches `ready`. `message_create` → `persist()`
    into `messages` (source='whatsapp', deduped); media stored as an attachment
    marker (`msg.type`; file download/vision = TODO). `backfillWhatsApp(perChat)`
    fetches recent history per chat. Auto-reconnects on boot if session exists.
  - **Chromium**: puppeteer's bundled Chromium was corrupt → drives **system
    Chrome** (`/Applications/Google Chrome.app`, override `WA_CHROME_PATH`).
  - **Pairing gotcha (solved)**: link failed ("Couldn't link device") until we
    (a) cleared a stale session, (b) paired with a **visible** window
    (`WA_HEADLESS=0`), and (c) pinned a newer WhatsApp Web build to LINK
    (`WA_WEB_VERSION` + remote cache from wppconnect/wa-version). The library only
    fully hooks (fires `ready`, captures msgs) on its native build, so it RUNS on
    the default version — pin newer only to link, reconnect on default.
  - **Orphaned-Chrome trap (solved)**: killing the node server left puppeteer's
    Chrome alive, holding the session lock → next start hangs at `authenticated`.
    Fix: `stopWhatsApp()` (client.destroy) on SIGINT/SIGTERM. If ever stuck after
    a hard kill: `pkill -9 -f wwebjs_auth` and ensure exactly ONE
    `src/server/index.ts` node process.
  - **⚠️ ROOT CAUSE of the recurring "stuck on connecting / loading 99%" (deeply
    diagnosed & fixed)**: the hangs were NOT caused by feature code — they were
    caused by **ungraceful `kill -9` of the server** (our restart habit between
    patches). A `kill -9` can't run `stopWhatsApp()`, so it **orphans the puppeteer
    Chrome**, which keeps holding the profile's `SingletonLock` AND leaves the
    WhatsApp session's IndexedDB half-written → the next launch authenticates but
    **hangs at "loading 99%"** and never reaches `ready`. Proven by experiment:
    first start of a session → `ready` in ~6s; after a `kill -9` cycle every start
    hangs at 99%; a **graceful** SIGTERM stop leaves **0 orphans** and the next
    start reaches `ready` in ~5s with the session intact. The dominant fix is
    therefore **always shut down gracefully — NEVER `kill -9` the server**
    (use SIGTERM/SIGINT; the handler calls `stopWhatsApp()` → `client.destroy()`,
    which flushes the session and closes Chrome cleanly).
  - **Self-healing startup (the code-side safety net)** in `client.ts`:
    1. `cleanupSession()` runs on every `startWhatsApp()` (guarded by no live
       client): `killOrphanChrome()` SIGKILLs only Chrome whose cmdline references
       OUR `wwebjs_auth` path (never the user's normal Chrome), then
       `removeStaleLocks()` deletes `Singleton{Lock,Cookie,Socket}`. Validated:
       after a `kill -9` left 7 orphans, the next start logged "cleaned up 7
       orphaned Chrome process(es)" and relaunched clean.
    2. **Readiness watchdog** `armReadyWatchdog()` (now sync-aware): if `ready`
       doesn't fire within `READY_TIMEOUT_MS` (default 90s; `WA_READY_TIMEOUT_MS`)
       it ONLY recycles when stuck at `starting` (browser never loaded WhatsApp Web)
       — bounded by `WA_MAX_ATTEMPTS` (default 2). It does **NOT** recycle while
       `authenticated` (the initial history sync — the phone shows a spinning
       linked-device indicator; first sync of a busy account can take minutes, and
       recycling would re-link and restart the sync so it could never finish) or
       while `qr` (awaiting scan). During a slow/wedged sync the UI offers both
       **Reconectar** and **Volver a vincular** so the user can wait or escape.
       (Earlier the aggressive 90s recycle made first-time pairing stall forever.)
    3. **Status diagnostics**: `getWaState()` now returns `detail` (e.g. "loading
       99%", "authenticated — syncing…") + `lastError` + `attempts`, shown in the
       UI — so a stall is legible, not an opaque "connecting…".
    4. **User-facing recovery (no terminal needed)**: `resetWhatsApp()` /
       `POST /api/whatsapp/reset` (stop + scrub + reconnect) → UI "Reconnect"
       button; `repairWhatsApp()` / `POST /api/whatsapp/repair` (also **deletes the
       session** for a fresh QR) → UI "Re-pair" button, the escape hatch for a
       genuinely corrupted session.
  - **WhatsApp chat selection**: Settings → "WhatsApp chats to include" lists the
    account's chats (`/api/whatsapp/chats`, `listWaChats`); `wa_selected_chats`
    filters live capture + `backfillWhatsApp` (empty = all). Validated on 117 chats.
  - UI: Settings → WhatsApp block (Connect → QR → Connected → Backfill) + chat
    picker + Reconnect / Re-pair recovery buttons. Endpoints:
    `/api/whatsapp/{start,status,reset,repair,backfill,chats}`.
- ✅ **Source labels**: messages carry `source`; Pipeline feed shows an
  `iMsg`/`WA` badge, and raw WhatsApp JIDs render readable (`@c.us`→phone,
  `@lid`→"WhatsApp contact"/hidden) via `prettySender` (+ `displayName`).
- ✅ **Phase 4 — reminders/notifications** DONE & validated:
  - **Native macOS notifications** via `src/notify/mac.ts` (`macNotify` →
    `/usr/bin/osascript` `display notification`, best-effort/non-fatal off-mac,
    no extra deps). Requires the host app to be allowed in System Settings →
    Notifications.
  - **Reminders engine** `src/notify/reminders.ts`: `buildDigest()` summarizes
    open tasks (todo/waiting, overdue counts) into title/subtitle/message;
    `sendDailyDigest()` fires it; `runNudgeSweep()` re-surfaces unfinished tasks,
    throttled per-task via `tasks.last_nudge_at` (default 2 days, `nudge_interval_days`
    setting) and **grouped into one banner** (no 20-banner spam), with escalating
    wording (overdue → "⚠️ N overdue"). `force` ignores throttle/enable for manual fire.
  - **Scheduling**: daily **digest** runs in the existing morning cron right after
    ingest+process; **nudge sweep** runs hourly via `startNudgeLoop()` setInterval,
    only notifying 08:00–21:00 local (the 2-day per-task throttle bounds real pings).
  - **Settings → "Reminders & notifications"**: on/off, nudge interval, **Send test
    notification**, **Send digest now**, **Nudge open tasks now**, + a live "Right
    now: N open / X overdue" preview. Master `reminders_enabled` setting.
  - **Due dates**: task cards have a date picker (`/api/tasks/:id/due`); overdue
    tasks show **red/bold**; `due_at` drives overdue escalation. (Extractor doesn't
    set due dates yet — nudges work off staleness even without one.)
  - Endpoints: `GET /api/reminders`, `POST /api/reminders/{test,digest,nudge}`,
    `POST /api/tasks/:id/due`; settings GET/POST gained `remindersEnabled` +
    `nudgeIntervalDays`. Validated: digest (26 open), overdue detection, forced
    nudge (26 nudged), test banner, due-date round-trip + red styling, no console errors.
- ✅ **Spanish localization** DONE & validated — the whole app is in Spanish for the
  father (a native speaker):
  - **UI** (`public/index.html` + `public/app.js`): every label/hint/button/status
    translated; title "Asistente de Tareas". Tabs: Bandeja · Tareas · Archivo ·
    Clientes · Chat · Proceso · Ajustes. Status/WhatsApp-state labels via
    `STATUS_LABELS`/`WA_LABELS` maps (canonical English values kept for the API;
    only the displayed text is Spanish). `<html lang="es">`.
  - **AI presents in Spanish, works in English**: chat system prompt → always reply
    in Spanish (validated: replied in Spanish to an English question over English
    tasks). Extractor → `title`/`detail` in Spanish, but `source_quote` stays
    VERBATIM in the original language (it's used for WhatsApp/iMessage text search).
    Vision descriptions → Spanish. Notification digests/nudges → Spanish.
  - **Existing tasks migrated**: `src/extract/translate-tasks.ts` (`npm run
    translate:tasks`) batch-translates pre-existing English task titles/details to
    Spanish via Haiku (leaves `source_quote` verbatim; re-runnable). Ran it on the
    dev DB → 31 tasks now Spanish.
  - **Live rename fix**: saving a client name now re-renders Inbox + Tasks
    immediately (`loadInbox()`+`loadTasks()` after `loadNames()`), instead of only
    showing the new name after an app relaunch.
  - **Button restyle**: all non-tab buttons are now filled pills like the primary
    (neutral grey vs. blue) instead of default HTML buttons (`button:not(.tab)` in
    style.css).
- ✅ Electron bundle — see the Bundling entry above. ⬜ Optional: app icon, native
  (app-attributed) notifications, notarization.
- ✅ **Final stability review** (whole repo) — fixes:
  - **Concurrency guard** in `processNewMessages` (`pipeline.ts`): rows are marked
    `processed=1` only AFTER the async extract, so a manual "Process" overlapping
    the daily cron could select the same rows twice and **double-propose tasks**.
    A module-level `processingNow` flag now makes a second concurrent run bail out.
  - **Non-fatal iMessage ingest** (`server.ts` `ingestSafely()`): a `chat.db`
    failure (FDA not granted yet, or a WhatsApp-only setup) no longer aborts the
    whole process/cron — it logs and still processes already-stored (incl.
    WhatsApp) messages.
  - **`unhandledRejection` handler**: a stray rejection from a library internal
    (puppeteer/whatsapp-web.js) logs instead of killing the always-on app.
  - Audited: iMessage opened strictly read-only; no send/delete paths; all
    message/vision/task content is HTML-escaped at render (no stored-XSS from a
    contact's message); SSE framing + `failed`/`onerror` handling correct;
    better-sqlite3 is synchronous so the shared app.db connection isn't raced.
  - **⚠️ BUNDLED-APP "authenticated — syncing" never reaching `ready` — REAL ROOT
    CAUSE (the big one)**: NOT a web-version mismatch and NOT account throttle (early
    wrong guesses). whatsapp-web.js's `LocalWebCache.persist()` does
    `fs.mkdirSync`/`writeFileSync` on its cache dir with **no error handling**, and
    the cache defaults to **`./.wwebjs_cache/` relative to CWD**. A bundled `.app`
    runs with **CWD `/` (read-only)**, so persist throws (`EROFS`/`ENOENT`) — and it
    runs **right after the `authenticated` event and BEFORE `ready`** (Client.js
    inject flow), so the app got stuck on "authenticated — syncing" forever and
    captured 0 messages. The dev server worked only because its CWD was the writable
    project dir (you can see `./.wwebjs_cache/*.html` there). Proven by isolation:
    the SAME known-good session reaches `ready` in 6 s under `tsx` (writable CWD) but
    stalls under the `.app` (CWD `/`); and a unit test of `persist()` throws under
    CWD `/` but writes fine to the dataDir path. **Fix** (`client.ts`): always set
    `webVersionCache` to `{ type: 'local', path: <config.dataDir>/wwebjs_cache }`
    (writable in both dev and the bundle) instead of leaving the CWD-relative
    default. Do NOT pin `webVersion` (the library hooks the current build fine).
  - **Single-instance lock** (`electron/main.cjs` `requestSingleInstanceLock()`):
    a double-launch now just focuses the existing window instead of starting a rival
    server + WhatsApp session on the same number. Validated: 2nd `open` → still 1
    process.

### How to run
- `npm run db:init` — create/verify the app database
- `npm run imessage:ingest` — persist recent iMessages into app.db (needs FDA)
- `npm run dashboard` — start the dashboard at http://localhost:4319 (needs FDA)
- **Stopping the dashboard: ALWAYS use Ctrl-C / SIGTERM, NEVER `kill -9`.** A hard
  kill orphans WhatsApp's Chrome and corrupts its session → next start hangs at
  "loading 99%". Graceful stop closes Chrome cleanly; the next start reconnects in
  ~5s. (If a hard kill ever happens anyway, `cleanupSession()` self-heals on the
  next start, and the UI has Reconnect / Re-pair buttons.)
- `npm run extract` / `EXTRACT_VISION=1 npm run extract` — CLI task extraction
- `npm run vision:test` — probe vision on recent image/PDF attachments
- `npx tsc --noEmit` — full project typecheck (currently clean)

## Locked decisions
- **Host:** Local app on the always-on Mac Studio. (He also has an office iMac,
  not the host.) iMessage *requires* a Mac signed into his Apple ID — that's the
  one piece that can't move off a Mac. WhatsApp + dashboard could run elsewhere,
  but keeping everything on the Mac Studio is simplest. Dashboard can be made
  reachable from his iMac/phone later if wanted.
- **Sources:**
  - iMessage office group chat via local `~/Library/Messages/chat.db`. Already
    syncs to the Mac Studio via Messages in iCloud. Needs **Full Disk Access**
    granted to the app once.
  - WhatsApp via a **read-only Web mirror** (`whatsapp-web.js`, real Chromium
    session, **never sends**). Works whether his number is on the regular app or
    Business. One-time QR scan + occasional re-scans.
- **WhatsApp risk:** Web mirror is technically against WhatsApp ToS; read-only
  lowers risk but a ban hits the whole number. Mitigations: real-browser client,
  one stable session, run on home IP, keep library current.
- **AI:** Claude API (Anthropic SDK), model **`claude-haiku-4-5`** ($1/$5 per
  MTok — a few $/month at ~200 msgs/day; Batches API halves it). Tuned
  **lenient** — over-propose rather than miss tasks. Father approves/dismisses
  proposed tasks one-tap. Extraction module is **provider-agnostic** (clean
  interface) so we can A/B Haiku vs a local Ollama model vs Gemini on real data.
- **Tasks:** linked to a client. Statuses: **Proposed → To-do → Waiting
  (on factory/client) → Done**. Escalating reminders ~every 2 days until done.
- **Clients:** WhatsApp name + free-text "what they buy / product need" (also fed
  to the AI as context). Auto-created from chat names; father can rename/merge.
- **Reminders:** BOTH native macOS notifications AND a daily morning digest.
- **First run:** import last 30 days of messages.
- **Languages:** ~90% English/Spanish, ~10% Chinese (all native to Claude).

## Proposed stack
Single runtime — **Node / TypeScript**:
- WhatsApp: `whatsapp-web.js`
- iMessage: SQLite reader over `chat.db`
- Storage: local SQLite (`messages`, `clients`, `tasks`)
- Extraction: Anthropic SDK
- Dashboard: small local web app
- Scheduler: `node-cron`

## Build plan
- **Phase 0 — Foundation:** Node/TS project, SQLite schema, config for Anthropic key.
- **Phase 1 — Ingestion (make-or-break):** iMessage reader (decode both `text` and
  the binary `attributedBody`); WhatsApp mirror (QR scan + 30-day backfill).
  Exit criterion: both sources landing normalized rows in SQLite. **Checkpoint:
  look at the real data together before building on top.**
- **Phase 2 — AI extraction:** batch new messages → Claude with client context →
  lenient proposals, deduped, saved as *Proposed*.
- **Phase 3 — Dashboard:** Inbox (approve/dismiss), Tasks by client, Overdue view,
  client editing.
- **Phase 4 — Reminders:** native Mac notifications + daily morning digest;
  escalating nudges every 2 days.
- **Phase 5 — Polish:** auto-start on boot, restart-on-crash, re-scan prompts, logs.

## Gotchas to handle
- macOS stores some iMessage text in a binary `attributedBody` field, not the
  `text` column — decode both.
- WhatsApp session needs a one-time QR scan and occasional re-scans.

## Prerequisites before building
- Work on the Mac Studio (for iMessage access).
- Grant Full Disk Access to the terminal/app running this.
- An Anthropic API key (only needed at Phase 2).
