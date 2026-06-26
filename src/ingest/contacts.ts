import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Reads the macOS Contacts (AddressBook) databases to resolve a phone/email
 * handle to a real name. Contact names are NOT in chat.db or WhatsApp — they
 * live here — so this is what turns "+57…"/"…@c.us" into "San San". Read-only;
 * needs Full Disk Access (same grant as iMessage ingest). Best-effort: if the
 * DBs can't be read, callers just fall back to the raw handle.
 */

interface ContactMaps {
  byEmail: Map<string, string>;
  phoneExact: Map<string, string>;
  phone10: Map<string, string>; // keyed by last 10 digits (country-code tolerant)
  phone9: Map<string, string>; // keyed by last 9 digits
}

const CACHE_MS = 10 * 60 * 1000;
let cache: { maps: ContactMaps; at: number } | null = null;

/** All AddressBook sqlite files (top-level + per-account Sources). */
function dbPaths(): string[] {
  const base = path.join(os.homedir(), 'Library', 'Application Support', 'AddressBook');
  const found: string[] = [];
  const top = path.join(base, 'AddressBook-v22.abcddb');
  if (fs.existsSync(top)) found.push(top);
  const sources = path.join(base, 'Sources');
  try {
    for (const d of fs.readdirSync(sources)) {
      const p = path.join(sources, d, 'AddressBook-v22.abcddb');
      if (fs.existsSync(p)) found.push(p);
    }
  } catch {
    /* no Sources dir */
  }
  return found;
}

const digits = (s: string): string => (s || '').replace(/\D/g, '');

function fullName(r: { f: string | null; l: string | null; org: string | null; nick: string | null }): string {
  const person = [r.f, r.l].filter((x) => x && x.trim()).join(' ').trim();
  return person || (r.nick || '').trim() || (r.org || '').trim();
}

function setIfAbsent(m: Map<string, string>, key: string, val: string): void {
  if (key && val && !m.has(key)) m.set(key, val);
}

function loadMaps(): ContactMaps {
  const maps: ContactMaps = {
    byEmail: new Map(),
    phoneExact: new Map(),
    phone10: new Map(),
    phone9: new Map(),
  };
  for (const p of dbPaths()) {
    let cdb: Database.Database | null = null;
    try {
      cdb = new Database(p, { readonly: true, fileMustExist: true });
      const recs = cdb
        .prepare(
          `SELECT Z_PK AS pk, ZFIRSTNAME AS f, ZLASTNAME AS l, ZORGANIZATION AS org, ZNICKNAME AS nick
           FROM ZABCDRECORD`,
        )
        .all() as { pk: number; f: string | null; l: string | null; org: string | null; nick: string | null }[];
      const nameByPk = new Map<number, string>();
      for (const r of recs) {
        const n = fullName(r);
        if (n) nameByPk.set(r.pk, n);
      }
      const phones = cdb
        .prepare(`SELECT ZOWNER AS owner, ZFULLNUMBER AS num FROM ZABCDPHONENUMBER WHERE ZFULLNUMBER IS NOT NULL`)
        .all() as { owner: number; num: string }[];
      for (const ph of phones) {
        const name = nameByPk.get(ph.owner);
        const d = digits(ph.num);
        if (!name || d.length < 5) continue;
        setIfAbsent(maps.phoneExact, d, name);
        if (d.length >= 10) setIfAbsent(maps.phone10, d.slice(-10), name);
        if (d.length >= 9) setIfAbsent(maps.phone9, d.slice(-9), name);
      }
      const emails = cdb
        .prepare(`SELECT ZOWNER AS owner, ZADDRESS AS addr FROM ZABCDEMAILADDRESS WHERE ZADDRESS IS NOT NULL`)
        .all() as { owner: number; addr: string }[];
      for (const em of emails) {
        const name = nameByPk.get(em.owner);
        if (name) setIfAbsent(maps.byEmail, em.addr.trim().toLowerCase(), name);
      }
    } catch {
      /* unreadable source — skip it */
    } finally {
      cdb?.close();
    }
  }
  return maps;
}

function maps(): ContactMaps {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.maps;
  const m = loadMaps();
  cache = { maps: m, at: Date.now() };
  return m;
}

/** Strip WhatsApp/iMessage routing suffixes to get the bare phone/email/id. */
function bareHandle(handle: string): string {
  return handle.replace(/@(c\.us|s\.whatsapp\.net|lid|g\.us)$/i, '');
}

/** Resolve a sender handle (phone or email) to a Contacts name, or null. */
export function resolveContactName(handle: string | null | undefined): string | null {
  if (!handle) return null;
  const h = bareHandle(handle);
  const m = maps();
  if (h.includes('@')) return m.byEmail.get(h.trim().toLowerCase()) ?? null;
  const d = digits(h);
  if (d.length < 5) return null; // shortcodes, business ids
  return (
    m.phoneExact.get(d) ??
    (d.length >= 10 ? m.phone10.get(d.slice(-10)) : undefined) ??
    (d.length >= 9 ? m.phone9.get(d.slice(-9)) : undefined) ??
    null
  );
}

/** Force a reload on next lookup (e.g. after the user edits Contacts). */
export function invalidateContactsCache(): void {
  cache = null;
}
