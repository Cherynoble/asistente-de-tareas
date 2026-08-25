/**
 * Background machinery of the always-on server: the daily cron, the hourly
 * nudge loop, the scheduled-reminder sweep, and the sleep/wake detector.
 * Route modules import applySchedule() (settings changes re-arm the cron);
 * index.ts calls startBackgroundLoops() once after listen.
 */
import cron from 'node-cron';
import { hasAiKey } from '../ai/index.js';
import { processNewMessages } from '../extract/pipeline.js';
import { listAccountStates, resetAccount } from '../ingest/whatsapp/client.js';
import { macNotify } from '../notify/mac.js';
import { sendDailyDigest, runNudgeSweep } from '../notify/reminders.js';
import { sweepReminderNotifications } from '../notify/scheduled.js';
import { getSchedulerConfig } from '../settings.js';
import { t } from '../i18n.js';
import { ingestSafely } from './helpers.js';

// Daily auto ingest + process, configurable in-app (Settings tab) and live-
// reschedulable. Reads scheduler config from settings (falls back to DAILY_CRON
// env / 7am default).
let scheduledTask: ReturnType<typeof cron.schedule> | null = null;
export function applySchedule(): void {
  scheduledTask?.stop();
  scheduledTask = null;
  const { enabled, cron: expr } = getSchedulerConfig();
  if (!enabled || !hasAiKey() || !cron.validate(expr)) {
    console.log('  Daily auto-process: off');
    return;
  }
  scheduledTask = cron.schedule(expr, async () => {
    console.log(`[cron] ${new Date().toISOString()} daily ingest + process`);
    try {
      ingestSafely();
      // The vision budget is shared across ALL batches of the run, and this run
      // can cover up to 50 × 120 = 6,000 messages. At the old cap of 20 a busy
      // night's photos went undescribed — and the rows were then marked
      // processed, so that signal never came back. 200 still bounds the cost.
      const r = await processNewMessages({ vision: true, visionCap: 200, maxBatches: 50 });
      console.log(`[cron] processed ${r.processed}, proposed ${r.proposed}, remaining ${r.remaining}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[cron] ingest/process failed:', msg);
      // The owner never reads server logs — a failed nightly run used to be
      // completely invisible (tasks just quietly stopped appearing). Say so.
      macNotify({
        title: t('notify.appName'),
        subtitle: t('notify.cronFailedSubtitle'),
        message: t('notify.cronFailedMessage', { error: msg.slice(0, 120) }),
        sound: false,
      });
    }
    // The morning digest only needs the local DB — send it even when the AI
    // pass above failed (API/network down), so a bad morning still gets its
    // summary instead of silent nothing.
    try {
      const d = sendDailyDigest();
      console.log(`[cron] digest: ${d.counts.total} open (${d.counts.overdue} overdue)`);
    } catch (err) {
      console.error('[cron] digest failed:', err instanceof Error ? err.message : err);
    }
  });
  console.log(`  Daily auto-process scheduled: "${expr}"`);
}

// Escalating nudges: re-surface unfinished tasks every ~2 days (per-task
// throttle lives in runNudgeSweep). We check hourly but only notify during
// waking hours so nobody gets a 3am ping.
let nudgeTimer: ReturnType<typeof setInterval> | null = null;
function startNudgeLoop(): void {
  if (nudgeTimer) return;
  const tick = () => {
    const hour = new Date().getHours();
    if (hour < 8 || hour >= 21) return;
    try {
      const r = runNudgeSweep();
      if (r.nudged) console.log(`[nudge] ${r.nudged} task(s) nudged (${r.overdue} overdue)`);
    } catch (err) {
      console.error('[nudge] failed:', err instanceof Error ? err.message : err);
    }
  };
  nudgeTimer = setInterval(tick, 60 * 60 * 1000); // hourly
}

/** All recurring background work. Call once, after the server is listening. */
export function startBackgroundLoops(): void {
  startNudgeLoop();

  // Fire native notifications for scheduled reminders that come due (every 5 min;
  // the launch digest is the reliable backstop).
  setInterval(() => {
    try {
      sweepReminderNotifications();
    } catch (err) {
      console.error('[reminders] sweep failed:', err instanceof Error ? err.message : err);
    }
  }, 5 * 60 * 1000);

  // Sleep/wake detector (works without the Electron shell): if the wall clock
  // jumps far past our tick interval, the Mac most likely slept — and macOS may
  // have killed the puppeteer Chrome, leaving a wedged/disconnected session that
  // never silently recovers. On a detected wake, reconnect any paired account
  // that isn't currently 'ready' (reset scrubs orphans + relaunches cleanly).
  // This directly addresses "laptop closed → WhatsApp signed out, auto sign-in
  // doesn't kick in". A still-healthy 'ready' account is left alone.
  const WAKE_TICK_MS = 30_000;
  let lastWakeTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    const gap = now - lastWakeTick;
    lastWakeTick = now;
    if (gap > WAKE_TICK_MS * 4) {
      console.log(`[whatsapp] wake detected (gap ${Math.round(gap / 1000)}s) — health-checking accounts`);
      for (const s of listAccountStates()) {
        // Only revive accounts that are genuinely stuck (paired but idle/dropped).
        // Leave alone ones already pairing/syncing/connected — and ones the
        // Electron shell's powerMonitor may have just restarted on resume.
        if (s.hasSession && (s.status === 'disconnected' || s.status === 'idle')) {
          console.log(`[whatsapp:${s.id}] reconnecting after wake`);
          void resetAccount(s.id);
        }
      }
    }
  }, WAKE_TICK_MS);
}
