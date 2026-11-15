import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ga4Pages, gscPages, type Ga4Row, type GscRow } from '../google/api.js';
import { accessToken } from '../google/auth.js';
import { detectSeparator, parseCsv } from '../scookie/index.js';

/** Dati di traffico di una scansione: da Search Console e GA4, via API o da file esportati. */
export interface Traffic {
  fetched_at: string;
  /** Periodo dei dati, se noto (per i file importati non lo è). */
  period: { start: string; end: string } | null;
  gsc: { source: 'api' | 'csv'; property: string | null; rows: GscRow[] } | null;
  ga4: { source: 'api' | 'csv'; property: string | null; rows: Ga4Row[] } | null;
}

const file = (runDir: string) => join(runDir, 'traffico.json');

export function readTraffic(runDir: string): Traffic | null {
  try {
    return JSON.parse(readFileSync(file(runDir), 'utf8')) as Traffic;
  } catch {
    return null;
  }
}

export function saveTraffic(runDir: string, t: Traffic) {
  writeFileSync(file(runDir), JSON.stringify(t));
}

export const hasTraffic = (runDir: string) => existsSync(file(runDir));

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Periodo di N giorni che finisce tre giorni fa: i dati più recenti di Search Console non sono ancora completi. */
export function periodOf(days: number, today = new Date()): { start: string; end: string } {
  const end = new Date(today.getTime() - 3 * 86400000);
  return { start: iso(new Date(end.getTime() - (days - 1) * 86400000)), end: iso(end) };
}

/** Scarica i dati dalle API con il collegamento a Google salvato sul computer. */
export async function fetchTraffic(googleDir: string, opts: { gsc?: string; ga4?: string; giorni: number }): Promise<Traffic> {
  const token = await accessToken(googleDir);
  const period = periodOf(opts.giorni);
  const [gsc, ga4] = await Promise.all([opts.gsc ? gscPages(token, opts.gsc, period.start, period.end) : null, opts.ga4 ? ga4Pages(token, opts.ga4, period.start, period.end) : null]);
  return { fetched_at: new Date().toISOString(), period, gsc: gsc ? { source: 'api', property: opts.gsc!, rows: gsc } : null, ga4: ga4 ? { source: 'api', property: opts.ga4!, rows: ga4 } : null };
}

// ---------- file esportati ----------

export class CsvError extends Error {}

/** Numero scritto all'italiana o all'inglese: "1.234", "1,234", "3,5%", "12.4". */
export function parseNumber(raw: string, integer = false): number {
  let s = (raw ?? '').trim().replace(/%$/, '').replace(/\s/g, '');
  if (!s || s === '-') return 0;
  const dot = s.includes('.');
  const comma = s.includes(',');
  if (dot && comma) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (comma) s = integer || /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  else if (dot && (integer || /^\d{1,3}(\.\d{3})+$/.test(s))) s = /^\d{1,3}(\.\d{3})+$/.test(s) ? s.replace(/\./g, '') : s;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/** Righe del file senza i commenti iniziali (GA4 li scrive con #), dall'intestazione in giù. */
function table(text: string, isHeader: (cells: string[]) => boolean): { header: string[]; rows: string[][] } {
  const clean = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => !l.startsWith('#')).join('\n');
  const rows = parseCsv(clean, detectSeparator(clean.split('\n').find((l) => l.trim()) ?? ''));
  const i = rows.findIndex((r) => isHeader(r.map((c) => c.toLowerCase())));
  if (i < 0) throw new CsvError('Intestazione non riconosciuta.');
  return { header: rows[i].map((c) => c.trim().toLowerCase()), rows: rows.slice(i + 1) };
}

const col = (header: string[], re: RegExp) => header.findIndex((h) => re.test(h));

/**
 * Export di Search Console, scheda "Pagine" (Pagine.csv dello zip, in italiano o in inglese), o un foglio con le
 * stesse colonne: indirizzo, clic, impression, CTR, posizione.
 */
export function parseGscCsv(text: string): GscRow[] {
  let t;
  try {
    t = table(text, (c) => c.some((x) => /^(pagine|pagina|top pages|page|url|indirizzo)/.test(x)) && c.some((x) => /^(clic|clicks)/.test(x)));
  } catch {
    throw new CsvError('Il file non sembra l\'export delle pagine di Search Console: servono le colonne dell\'indirizzo, dei clic e delle impression (file "Pagine.csv" dell\'esportazione).');
  }
  const u = col(t.header, /^(pagine|pagina|top pages|page|url|indirizzo)/);
  const c = col(t.header, /^(clic|clicks)/);
  const i = col(t.header, /^impression/);
  const r = col(t.header, /^ctr/);
  const p = col(t.header, /^(posizione|position)/);
  const out: GscRow[] = [];
  for (const row of t.rows) {
    const url = (row[u] ?? '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const ctr = r >= 0 ? parseNumber(row[r]) : 0;
    out.push({ url, clicks: parseNumber(row[c], true), impressions: i >= 0 ? parseNumber(row[i], true) : 0, ctr: Math.round((/%/.test(row[r] ?? '') || ctr > 1 ? ctr / 100 : ctr) * 10000) / 10000, position: p >= 0 ? Math.round(parseNumber(row[p]) * 10) / 10 : 0 });
  }
  if (!out.length) throw new CsvError('Nel file non ci sono righe con un indirizzo completo (https://…).');
  return out;
}

/**
 * Export di GA4 per pagina: una colonna con il percorso (pagina di destinazione o percorso pagina) e le metriche
 * disponibili tra sessioni, sessioni organiche, eventi chiave, visualizzazioni. Le righe di commento (#) sono saltate.
 */
export function parseGa4Csv(text: string): Ga4Row[] {
  const pathRe = /(pagina di destinazione|landing page|percorso pagina|page path|percorso della pagina|^path$|^pagina$|^page$)/;
  let t;
  try {
    t = table(text, (c) => c.some((x) => pathRe.test(x)) && c.some((x) => /(sessioni|sessions|visualizzazioni|views)/.test(x)));
  } catch {
    throw new CsvError('Il file non sembra un export di GA4 per pagina: servono una colonna con il percorso della pagina (o la pagina di destinazione) e almeno una tra sessioni e visualizzazioni.');
  }
  const p = col(t.header, pathRe);
  const host = col(t.header, /(nome host|hostname|host name)/);
  const organic = col(t.header, /(organic|organic[ah])/);
  const sessions = t.header.findIndex((h, i) => /^(sessioni|sessions)/.test(h) && i !== organic);
  const key = col(t.header, /(eventi chiave|key events|conversioni|conversions)/);
  const views = col(t.header, /(visualizzazioni|views)/);
  const isLanding = /(destinazione|landing)/.test(t.header[p]);
  const out: Ga4Row[] = [];
  for (const row of t.rows) {
    let path = (row[p] ?? '').trim();
    let h: string | null = host >= 0 ? (row[host] ?? '').trim() || null : null;
    if (/^https?:\/\//i.test(path)) {
      const u = new URL(path);
      h = u.host;
      path = u.pathname + u.search;
    }
    if (!path.startsWith('/')) continue;
    const s = sessions >= 0 ? parseNumber(row[sessions], true) : 0;
    out.push({ host: h, path, sessions: isLanding ? s : 0, organic_sessions: organic >= 0 ? parseNumber(row[organic], true) : 0, key_events: key >= 0 ? parseNumber(row[key], true) : 0, views: views >= 0 ? parseNumber(row[views], true) : isLanding ? 0 : s });
  }
  if (!out.length) throw new CsvError('Nel file non ci sono righe con un percorso di pagina (che inizia con "/").');
  return out;
}
