/**
 * Serves the UI message catalog to the browser as a plain script.
 *
 * Why a generated script rather than letting the page fetch the JSON:
 * public/app-*.js are CLASSIC scripts sharing one global scope, and several of
 * them build label maps at parse time. They need t() to work synchronously, and
 * a fetch() cannot provide that without restructuring all eleven files. Serving
 * the catalog as a <script> before them does, while keeping
 * public/i18n/<locale>.json as the single source of truth for both sides.
 *
 * Rendering it server-side also guarantees the browser and the server agree on
 * the active language on every request — they read the same setting.
 */
import express from 'express';
import { DEFAULT_LOCALE, catalog, getLocale } from '../../i18n.js';

export const i18nRouter = express.Router();

i18nRouter.get('/i18n/catalog.js', (_req, res) => {
  const locale = getLocale();
  const active = catalog(locale);
  // Ship Spanish alongside as the fallback layer, so a key that hasn't been
  // translated yet renders real text instead of a bare key.
  const fallback = locale === DEFAULT_LOCALE ? {} : catalog(DEFAULT_LOCALE);
  res.type('application/javascript');
  // No caching: the catalog changes the moment the owner switches language.
  res.setHeader('Cache-Control', 'no-store');
  res.send(
    `window.I18N_LOCALE=${JSON.stringify(locale)};\n` +
      `window.I18N_CATALOG=${JSON.stringify(active)};\n` +
      `window.I18N_FALLBACK=${JSON.stringify(fallback)};\n`,
  );
});
