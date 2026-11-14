import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, truncateSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { RedirectType } from './fetch.js';

/** Versione del formato dei file di dati. 0 = in costruzione (passi 2-6); diventa 1 con il formato completo. */
export const SCHEMA_VERSION = 0;

export type Source = 'partenza' | 'link' | 'sitemap' | 'elenco' | 'redirect';

export interface FrontierEntry {
  url: string;
  /** Livelli dal punto di partenza seguendo i link; null se finora non è raggiungibile dai link. */
  depth: number | null;
  source: Source;
  /** Pagina in cui è stato trovato per la prima volta. */
  from: string | null;
}

/** Una riga per indirizzo richiesto (campi del passo 2: risposta e redirect). */
export interface PageRow {
  url: string;
  status: number | null;
  final_url: string | null;
  final_status: number | null;
  redirect_type: RedirectType;
  redirect_chain: { url: string; status: number }[];
  redirect_to: string | null;
  content_type: string | null;
  depth: number | null;
  source: Source;
  found_on: string | null;
  in_sitemap: boolean;
  robots_txt_blocked: boolean;
  robots_txt_rule: string | null;
  /** False se l'indirizzo non è stato richiesto (vietato da robots.txt). */
  fetched: boolean;
  fetch_ms: number | null;
  bytes: number | null;
  error: string | null;
  fetched_at: string;
  /** Intestazioni della risposta a questo indirizzo (solo nei JSON). */
  headers: Record<string, string>;
}

export interface LinkRow {
  source_url: string;
  target_url: string;
  anchor: string;
  rel: string;
  nofollow: boolean;
  is_internal: boolean;
  /** Presente nell'HTML del server / nel DOM renderizzato (quest'ultimo dal passo 3). */
  in_raw: boolean;
  in_rendered: boolean | null;
}

export type RunStatus = 'in-corso' | 'in-pausa' | 'completata' | 'interrotta';

export interface RunState {
  schema_version: number;
  tool_version: string;
  cliente: string;
  status: RunStatus;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
  /** Secondi di scansione effettiva, sommati tra una ripresa e l'altra. */
  elapsed_s: number;
  user_agent: string;
  seeds: string[];
  /** Conteggi per motivo degli indirizzi lasciati fuori, con qualche esempio. */
  excluded: Record<string, { count: number; examples: string[] }>;
  /** Indirizzi accodati ma non visitati per i limiti impostati. */
  not_reached: { count: number; reason: string | null; examples: string[] };
  sitemaps: { url: string; status: number | null; kind: string; entries: number; error: string | null }[];
  robots: { host: string; status: number | null; found: boolean; crawl_delay: number | null; sitemaps: string[] }[];
  /** Modalità a campione: indirizzi candidati e scelti. */
  sample: { candidates: number; picked: number } | null;
  notes: string[];
  /** Cosa non è stato verificato, in chiaro, per il report. */
  limits: string[];
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // ultima riga scritta a metà per un'interruzione improvvisa: si scarta, l'indirizzo verrà ripetuto
    }
  }
  return out;
}

/**
 * Toglie l'ultima riga se è rimasta a metà (processo chiuso mentre scriveva): altrimenti la riga successiva
 * si attaccherebbe a quella rotta e andrebbe persa anche lei.
 */
function dropPartialLine(path: string) {
  if (!existsSync(path)) return;
  const size = statSync(path).size;
  if (!size) return;
  const buf = readFileSync(path);
  if (buf[size - 1] === 0x0a) return;
  truncateSync(path, buf.lastIndexOf(0x0a) + 1);
}

/**
 * Dati di una scansione su disco. I file .jsonl si scrivono in coda, una riga alla volta e subito: se il processo
 * si ferma in qualsiasi punto, ciò che è stato scansionato resta e la ripresa riparte da lì.
 *   frontiera.jsonl  indirizzi scoperti (accodati)
 *   pagine.jsonl     una riga per indirizzo visitato
 *   link.jsonl       link trovati nelle pagine
 *   stato.json       stato della scansione (riscritto per intero, con sostituzione atomica)
 */
export class RunStore {
  private fdFrontier: number;
  private fdPages: number;
  private fdLinks: number;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    for (const f of ['frontiera.jsonl', 'pagine.jsonl', 'link.jsonl']) dropPartialLine(join(dir, f));
    this.fdFrontier = openSync(join(dir, 'frontiera.jsonl'), 'a');
    this.fdPages = openSync(join(dir, 'pagine.jsonl'), 'a');
    this.fdLinks = openSync(join(dir, 'link.jsonl'), 'a');
  }

  static exists(dir: string): boolean {
    return existsSync(join(dir, 'stato.json'));
  }

  static readState(dir: string): RunState | null {
    try {
      return JSON.parse(readFileSync(join(dir, 'stato.json'), 'utf8')) as RunState;
    } catch {
      return null;
    }
  }

  static readPages(dir: string): PageRow[] {
    return readJsonl<PageRow>(join(dir, 'pagine.jsonl'));
  }

  static readLinks(dir: string): LinkRow[] {
    return readJsonl<LinkRow>(join(dir, 'link.jsonl'));
  }

  static readSitemapEntries(dir: string): { loc: string; lastmod: string | null; sitemap: string }[] {
    return readJsonl(join(dir, 'sitemap.jsonl'));
  }

  saveSitemapEntries(entries: { loc: string; lastmod: string | null; sitemap: string }[]) {
    writeFileSync(join(this.dir, 'sitemap.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
  }

  static readFrontier(dir: string): FrontierEntry[] {
    return readJsonl<FrontierEntry>(join(dir, 'frontiera.jsonl'));
  }

  addFrontier(e: FrontierEntry) {
    writeSync(this.fdFrontier, `${JSON.stringify(e)}\n`);
  }

  addPage(row: PageRow) {
    writeSync(this.fdPages, `${JSON.stringify(row)}\n`);
  }

  addLinks(rows: LinkRow[]) {
    if (rows.length) writeSync(this.fdLinks, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }

  saveState(state: RunState) {
    const tmp = join(this.dir, 'stato.json.tmp');
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, join(this.dir, 'stato.json'));
  }

  saveConfig(raw: string) {
    if (!existsSync(join(this.dir, 'config.yaml'))) writeFileSync(join(this.dir, 'config.yaml'), raw);
  }

  log(line: string) {
    appendFileSync(join(this.dir, 'registro.log'), `${new Date().toISOString()} ${line}\n`);
  }

  close() {
    for (const fd of [this.fdFrontier, this.fdPages, this.fdLinks]) {
      try {
        closeSync(fd);
      } catch {
        // già chiuso
      }
    }
  }
}
