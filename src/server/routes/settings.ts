/** Ajustes routes: settings, AI provider, stats, diagnostics, reminders. */
import express from 'express';
import { db } from '../../db/index.js';
import { config } from '../../config.js';
import {
  aiNotConfigured,
  aiName,
  aiProvider,
  aiStatus,
  hasAiKey,
  saveAiSettings,
} from '../../ai/index.js';
import { computeDiagnostics } from '../../diagnostics.js';
import { macNotify } from '../../notify/mac.js';
import {
  buildDigest,
  sendDailyDigest,
  runNudgeSweep,
  remindersEnabled,
  nudgeIntervalDays,
} from '../../notify/reminders.js';
import {
  getSetting,
  setSetting,
  getSchedulerConfig,
  timeToCron,
  cronToTime,
} from '../../settings.js';
import { applySchedule } from '../lifecycle.js';
import { LOCALES, getLocale, isLocale, localeChosen, setLocale } from '../../i18n.js';

export const settingsRouter = express.Router();
const r = settingsRouter;

/** Read current settings (never returns the key itself). */
r.get('/api/settings', (_req, res) => {
  const { enabled, cron: expr } = getSchedulerConfig();
  res.json({
    hasApiKey: hasAiKey(),
    apiKeyFromEnv: Boolean(config.anthropicApiKey) && !getSetting('anthropic_api_key'),
    schedulerEnabled: enabled,
    dailyTime: cronToTime(expr),
    remindersEnabled: remindersEnabled(),
    nudgeIntervalDays: nudgeIntervalDays(),
    uiLanguage: getLocale(),
    /** Which languages the picker offers. */
    languages: LOCALES,
    /** False until the owner picks one — drives the first-run language prompt. */
    languageChosen: localeChosen(),
  });
});

/** Update settings: API key, scheduler on/off + time, selected chats. */
r.post('/api/settings', (req, res) => {
  const b = req.body as {
    apiKey?: string;
    schedulerEnabled?: boolean;
    dailyTime?: string;
    selectedChats?: string[];
    remindersEnabled?: boolean;
    nudgeIntervalDays?: number;
    uiLanguage?: string;
  };
  // Changing the language re-renders the whole UI and re-points every AI
  // prompt, so the client reloads after this returns.
  if (typeof b.uiLanguage === 'string') {
    if (!isLocale(b.uiLanguage)) {
      res.status(400).json({ error: `Unknown language: ${b.uiLanguage}` });
      return;
    }
    setLocale(b.uiLanguage);
  }
  if (typeof b.apiKey === 'string') setSetting('anthropic_api_key', b.apiKey.trim());
  if (typeof b.remindersEnabled === 'boolean')
    setSetting('reminders_enabled', b.remindersEnabled ? '1' : '0');
  if (typeof b.nudgeIntervalDays === 'number' && b.nudgeIntervalDays >= 1)
    setSetting('nudge_interval_days', String(Math.floor(b.nudgeIntervalDays)));
  if (typeof b.schedulerEnabled === 'boolean')
    setSetting('scheduler_enabled', b.schedulerEnabled ? '1' : '0');
  if (typeof b.dailyTime === 'string') {
    const expr = timeToCron(b.dailyTime);
    if (expr) setSetting('daily_cron', expr);
  }
  if (Array.isArray(b.selectedChats))
    setSetting('selected_chats', JSON.stringify(b.selectedChats.filter((x) => typeof x === 'string')));
  applySchedule();
  res.json({ ok: true });
});

// ── AI provider (Ajustes → Proveedor de IA) ──
// The app can run on Anthropic (default) or any OpenAI-compatible provider
// (Kimi/Moonshot, DeepSeek, Qwen, GLM, Ollama, custom). One global choice.

/** Presets + stored per-provider config + which provider is active. No keys. */
r.get('/api/ai', (_req, res) => {
  res.json(aiStatus());
});

/** Save provider settings (provider switch, model, base URL, key, vision). */
r.post('/api/ai', (req, res) => {
  const b = (req.body ?? {}) as {
    provider?: string;
    model?: string;
    baseUrl?: string;
    apiKey?: string;
    vision?: boolean;
  };
  saveAiSettings(b);
  applySchedule(); // the nightly cron gates on hasAiKey(), which may have changed
  res.json({ ok: true, ...aiStatus() });
});

/** Round-trip test against the ACTIVE provider so a typo'd key/model/URL is
 *  caught in Ajustes, not discovered by a silently-failing nightly cron. */
r.post('/api/ai/test', async (_req, res) => {
  if (!hasAiKey()) {
    res.status(400).json({ ok: false, error: aiNotConfigured });
    return;
  }
  try {
    const resp = await aiProvider().chat({
      maxTokens: 30,
      messages: [{ role: 'user', content: 'Responde únicamente: ok' }],
    });
    res.json({ ok: true, name: aiName(), reply: resp.text.slice(0, 120) });
  } catch (err) {
    res.status(502).json({
      ok: false,
      name: aiName(),
      error: err instanceof Error ? err.message.slice(0, 300) : String(err),
    });
  }
});

r.get('/api/stats', (_req, res) => {
  const d = db();
  const count = (s: string) =>
    (
      d
        .prepare('SELECT COUNT(*) AS n FROM tasks WHERE status = ? AND deleted_at IS NULL')
        .get(s) as { n: number }
    ).n;
  const messages = (d.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
  const trash =
    (d.prepare('SELECT COUNT(*) AS n FROM tasks WHERE deleted_at IS NOT NULL').get() as { n: number }).n +
    (d.prepare('SELECT COUNT(*) AS n FROM clients WHERE deleted_at IS NOT NULL').get() as { n: number }).n;
  res.json({
    messages,
    proposed: count('proposed'),
    todo: count('todo'),
    waiting: count('waiting'),
    done: count('done'),
    dismissed: count('dismissed'),
    trash,
    hasApiKey: hasAiKey(),
  });
});

/** Which DB file this process is actually reading/writing, for diagnosing a
 * dataDir mismatch (config.ts prefers ./data/app.db over Application Support
 * if a stray copy exists) — surfaced in Ajustes → Diagnóstico. */
r.get('/api/diagnostics', (_req, res) => {
  res.json(computeDiagnostics());
});

/** Reminder settings + a live preview of today's digest and what's pending. */
r.get('/api/reminders', (_req, res) => {
  res.json({
    enabled: remindersEnabled(),
    nudgeIntervalDays: nudgeIntervalDays(),
    digest: buildDigest(),
  });
});

/** Fire a test notification so the user can confirm banners are allowed. */
r.post('/api/reminders/test', (_req, res) => {
  macNotify({
    title: 'Asistente de Tareas',
    subtitle: 'Notificación de prueba',
    message: 'Las notificaciones funcionan — los recordatorios aparecerán así.',
  });
  res.json({ ok: true });
});

/** Send the morning digest right now (manual trigger / preview). */
r.post('/api/reminders/digest', (_req, res) => {
  res.json({ ok: true, digest: sendDailyDigest() });
});

/** Force a nudge sweep now (ignores the per-task throttle). */
r.post('/api/reminders/nudge', (_req, res) => {
  res.json({ ok: true, result: runNudgeSweep(Date.now(), { force: true }) });
});
