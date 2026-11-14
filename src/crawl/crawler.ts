import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sample, sleep } from 'scookie/engine';
import type { LoadedConfig } from '../config/load.js';
import type { CrawlConfig } from '../config/schema.js';
import { TOOL_VERSION } from '../version.js';
import { fetchChain, type FetchResult } from './fetch.js';
import { extractLinks } from './links.js';
import { crawlDelayFor, parseRobots, robotsCheck, type Robots } from './robots.js';
import { SCOPE_LABEL, Scope } from './scope.js';
import { readSitemaps, type SitemapEntry } from './sitemap.js';
import { RunStore, SCHEMA_VERSION, type FrontierEntry, type LinkRow, type PageRow, type RunState, type Source } from './store.js';

export interface Progress {
  status: RunState['status'];
  phase: string;
  /** Indirizzi visitati (righe scritte). */
  done: number;
  /** Indirizzi in coda, ancora da visitare. */
  queued: number;
  inFlight: number;
  discovered: number;
  limit: number;
  byStatus: { ok: number; redirect: number; client: number; server: number; errore: number; bloccate: number };
  perMinute: number;
  etaSeconds: number | null;
  elapsedSeconds: number;
  recent: { url: string; status: number | null; note: string }[];
}

export interface CrawlerOptions {
  onProgress?: (p: Progress) => void;
  log?: (msg: string) => void;
  /** Intervallo minimo tra due aggiornamenti dell'avanzamento (predefinito 400 ms). */
  progressIntervalMs?: number;
}

const DEFAULT_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const LOGIN_RE = /\/(?:login|log-in|signin|sign-in|accedi|accesso|wp-login|account\/login|users\/sign_in|auth)\b/i;
const MAX_LINKS_PER_PAGE = 5000;

/** User agent dichiarato: quello di un browser, più il nome dello strumento e il contatto. */
export function userAgentOf(cfg: CrawlConfig): string {
  if (cfg.cortesia.userAgent) return cfg.cortesia.userAgent;
  const contact = cfg.cortesia.contatto ? ` (+${cfg.cortesia.contatto})` : '';
  return `${DEFAULT_CHROME} ${cfg.cortesia.nomeCrawler}/${TOOL_VERSION}${contact}`;
}

const statusClass = (row: PageRow): keyof Progress['byStatus'] => {
  if (!row.fetched) return 'bloccate';
  const s = row.status;
  if (s === null) return 'errore';
  if (s >= 500) return 'server';
  if (s >= 400) return 'client';
  if (s >= 300) return 'redirect';
  return 'ok';
};

/**
 * Motore di scansione: coda degli indirizzi in ordine di profondità, perimetro, pause per host, salvataggio riga
 * per riga e ripresa. Passo 2: legge l'HTML del server; rendering e analisi della pagina arrivano dal passo 3.
 */
export class Crawler {
  private readonly cfg: CrawlConfig;
  private readonly store: RunStore;
  private readonly ua: string;
  private scope!: Scope;
  private state!: RunState;

  private readonly entries = new Map<string, FrontierEntry>();
  private readonly doneUrls = new Set<string>();
  private readonly inFlight = new Set<string>();
  /** Code per profondità (null = non raggiungibile dai link, in fondo). */
  private readonly buckets = new Map<number, string[]>();
  private readonly robots = new Map<string, { robots: Robots | null; status: number | null }>();
  private readonly robotsLoading = new Map<string, Promise<void>>();
  private readonly hostNext = new Map<string, number>();
  private readonly hostPause = new Map<string, number>();
  private sitemapUrls = new Set<string>();

  private fetched = 0;
  private readonly counts: Progress['byStatus'] = { ok: 0, redirect: 0, client: 0, server: 0, errore: 0, bloccate: 0 };
  private recent: Progress['recent'] = [];
  private phase = 'avvio';
  private stopping = false;
  private readonly abort = new AbortController();
  private sessionStart = 0;
  private sessionDone = 0;
  private priorElapsed = 0;
  private sinceSave = 0;
  private lastEmit = 0;

  constructor(
    private readonly loaded: Pick<LoadedConfig, 'config' | 'raw'>,
    readonly runDir: string,
    private readonly opts: CrawlerOptions = {},
  ) {
    this.cfg = loaded.config;
    this.store = new RunStore(runDir);
    this.ua = userAgentOf(this.cfg);
  }

  /** Configurazione salvata in una cartella di scansione (per la ripresa). */
  static savedConfig(runDir: string): string | null {
    const p = join(runDir, 'config.yaml');
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  }

  /** Chiede di fermarsi: le richieste in corso finiscono, lo stato resta "in pausa" e si può riprendere. */
  pause() {
    this.stopping = true;
  }

  /** Ferma subito, interrompendo anche le richieste in corso (gli indirizzi interrotti verranno ripetuti). */
  stopNow() {
    this.stopping = true;
    this.abort.abort();
  }

  private log(msg: string) {
    this.store.log(msg);
    this.opts.log?.(msg);
  }

  // ---------- coda ----------

  private bucketKey(depth: number | null) {
    return depth === null ? Number.MAX_SAFE_INTEGER : depth;
  }

  private push(url: string, depth: number | null) {
    const k = this.bucketKey(depth);
    let b = this.buckets.get(k);
    if (!b) this.buckets.set(k, (b = []));
    b.push(url);
  }

  private exclude(reason: string, url: string) {
    const e = (this.state.excluded[reason] ??= { count: 0, examples: [] });
    e.count++;
    if (e.examples.length < 10 && !e.examples.includes(url)) e.examples.push(url);
  }

  /** Accoda un indirizzo già normalizzato, se è nel perimetro e non è già noto. */
  private enqueue(url: string, depth: number | null, source: Source, from: string | null): boolean {
    const known = this.entries.get(url);
    if (known) {
      // Trovato prima in sitemap o in elenco, ora raggiunto da un link: prende la profondità
      if (depth !== null && (known.depth === null || depth < known.depth) && !this.doneUrls.has(url) && !this.inFlight.has(url)) {
        if (depth > this.cfg.perimetro.maxProfondita) return false;
        known.depth = depth;
        known.from ??= from;
        // Nota dalla sitemap o dall'elenco, ora raggiunta da un link: l'origine diventa il link (in_sitemap resta)
        if (known.source === 'sitemap' || known.source === 'elenco') known.source = source;
        this.store.addFrontier(known);
        this.push(url, depth);
      }
      return false;
    }
    const why = this.scope.reason(url);
    if (why) {
      this.exclude(SCOPE_LABEL[why], url);
      return false;
    }
    if (depth !== null && depth > this.cfg.perimetro.maxProfondita) {
      this.exclude(`oltre ${this.cfg.perimetro.maxProfondita} livelli di profondità`, url);
      return false;
    }
    const entry: FrontierEntry = { url, depth, source, from };
    this.entries.set(url, entry);
    this.store.addFrontier(entry);
    this.push(url, depth);
    return true;
  }

  /**
   * Prossimo indirizzo, un livello alla volta: non si inizia un livello finché ci sono pagine del livello
   * precedente in corso, perché possono ancora scoprire link. Così la profondità è la più breve possibile e le
   * pagine note solo dalla sitemap si visitano per ultime, quando è certo che nessun link le raggiunge.
   */
  private next(): string | null {
    let minInFlight = Number.MAX_SAFE_INTEGER;
    for (const u of this.inFlight) minInFlight = Math.min(minInFlight, this.bucketKey(this.entries.get(u)?.depth ?? null));
    const keys = [...this.buckets.keys()].sort((a, b) => a - b);
    for (const k of keys) {
      if (k > minInFlight) return null;
      const b = this.buckets.get(k)!;
      while (b.length) {
        const url = b.shift()!;
        const e = this.entries.get(url);
        // voce superata: già visitata, in corso o spostata a un'altra profondità
        if (!e || this.doneUrls.has(url) || this.inFlight.has(url) || this.bucketKey(e.depth) !== k) continue;
        return url;
      }
      this.buckets.delete(k);
    }
    return null;
  }

  private queuedCount(): number {
    let n = 0;
    for (const [url] of this.entries) if (!this.doneUrls.has(url) && !this.inFlight.has(url)) n++;
    return n;
  }

  // ---------- rete ----------

  /** Attende il proprio turno per l'host: tra due richieste allo stesso host passa almeno la pausa impostata. */
  private async slot(url: string) {
    const host = new URL(url).host;
    const pause = this.hostPause.get(host) ?? this.cfg.cortesia.pausaMs;
    const now = Date.now();
    const at = Math.max(now, this.hostNext.get(host) ?? 0);
    this.hostNext.set(host, at + pause);
    if (at > now) await sleep(at - now);
  }

  private get(url: string): Promise<FetchResult> {
    return fetchChain(url, { userAgent: this.ua, timeoutMs: this.cfg.cortesia.timeoutMs, signal: this.abort.signal, beforeRequest: (u) => this.slot(u) });
  }

  /** Come get, ma se il server chiede di rallentare (429, 503) aspetta e riprova, allungando la pausa per quell'host. */
  private async getPolitely(url: string): Promise<FetchResult> {
    let res = await this.get(url);
    for (let attempt = 1; attempt <= 2 && !this.stopping; attempt++) {
      const last = res.hops.at(-1);
      if (!last || (last.status !== 429 && last.status !== 503)) break;
      const host = new URL(last.url).host;
      const retryAfter = Number(last.headers['retry-after']);
      const wait = Math.min(60000, Math.max(Number.isFinite(retryAfter) ? retryAfter * 1000 : 0, 5000 * attempt));
      const pause = Math.min(10000, Math.max(1000, (this.hostPause.get(host) ?? this.cfg.cortesia.pausaMs) * 2));
      this.hostPause.set(host, pause);
      this.log(`${host} chiede di rallentare (risposta ${last.status}): attesa di ${Math.round(wait / 1000)} s, pausa portata a ${pause} ms`);
      await sleep(wait);
      res = await this.get(url);
    }
    return res;
  }

  private async loadRobots(origin: string) {
    if (this.robots.has(origin)) return;
    let p = this.robotsLoading.get(origin);
    if (!p) {
      p = (async () => {
        const res = await this.get(`${origin}/robots.txt`);
        const last = res.hops.at(-1);
        const status = last?.status ?? null;
        // 4xx: nessuna restrizione; 5xx o errore di rete: non si sa, lo si dichiara tra le note
        const found = status !== null && status < 300 && res.body !== null && !/^\s*<(?:!doctype|html)/i.test(res.body);
        const robots = found ? parseRobots(res.body!) : null;
        this.robots.set(origin, { robots, status });
        const host = new URL(origin).host;
        const delay = robots ? crawlDelayFor(robots, this.cfg.cortesia.nomeCrawler) : null;
        if (delay && this.cfg.cortesia.rispettaRobots) {
          const ms = Math.min(delay * 1000, this.cfg.cortesia.maxCrawlDelayMs);
          if (ms > this.cfg.cortesia.pausaMs) {
            this.hostPause.set(host, ms);
            this.log(`${host}: Crawl-delay di ${delay} s in robots.txt, pausa portata a ${ms} ms`);
          }
        }
        if (!this.state.robots.some((r) => r.host === host)) {
          this.state.robots.push({ host, status, found, crawl_delay: delay, sitemaps: robots?.sitemaps ?? [] });
        }
        if (status === null || status >= 500) {
          this.note(`robots.txt di ${host} non leggibile (${status ?? res.error ?? 'errore'}): le regole non sono state applicate`);
        }
      })();
      this.robotsLoading.set(origin, p);
    }
    await p;
  }

  private note(text: string) {
    if (!this.state.notes.includes(text)) this.state.notes.push(text);
  }

  // ---------- una pagina ----------

  private row(entry: FrontierEntry, res: FetchResult, from: number): PageRow {
    const hops = res.hops.slice(from);
    const first = hops[0];
    const last = hops.at(-1);
    const u = new URL(entry.url);
    const rb = this.robots.get(u.origin)?.robots;
    const verdict = rb ? robotsCheck(rb, this.cfg.cortesia.nomeCrawler, u.pathname + u.search) : { allowed: true, rule: null };
    const redirects = hops.filter((h) => h.location).length;
    return {
      url: entry.url,
      status: first?.status ?? null,
      // Ultimo passaggio rimasto senza risposta (errore, loop): la destinazione è nota, il suo codice no
      final_url: last ? (last.location ?? last.url) : null,
      final_status: last && !last.location ? last.status : null,
      redirect_type: res.redirectType === 'loop' || res.redirectType === 'troppi' ? res.redirectType : redirects === 0 ? 'nessuno' : redirects === 1 ? 'singolo' : 'catena',
      redirect_chain: hops.map((h) => ({ url: h.url, status: h.status })),
      redirect_to: first?.location ?? null,
      content_type: hops.length === 1 ? (first?.headers['content-type'] ?? null) : null,
      depth: entry.depth,
      source: entry.source,
      found_on: entry.from,
      in_sitemap: this.sitemapUrls.has(entry.url),
      robots_txt_blocked: !verdict.allowed,
      robots_txt_rule: verdict.rule && !verdict.allowed ? `Disallow: ${verdict.rule.pattern}` : null,
      fetched: true,
      fetch_ms: first?.ms ?? null,
      bytes: hops.length === 1 ? res.bytes : null,
      error: res.error,
      fetched_at: new Date().toISOString(),
      headers: first?.headers ?? {},
    };
  }

  private write(row: PageRow, note = '') {
    this.store.addPage(row);
    this.doneUrls.add(row.url);
    if (row.fetched) this.fetched++;
    this.counts[statusClass(row)]++;
    this.sessionDone++;
    this.recent.unshift({ url: row.url, status: row.status, note: note || row.error || (row.redirect_to ? `→ ${row.redirect_to}` : '') });
    if (this.recent.length > 12) this.recent.length = 12;
    if (++this.sinceSave >= 25) this.save();
  }

  private async process(url: string, follow: boolean, collect?: (target: string, depth: number | null) => void) {
    const entry = this.entries.get(url)!;
    const u = new URL(url);
    await this.loadRobots(u.origin);
    const rb = this.robots.get(u.origin)?.robots;
    if (rb && this.cfg.cortesia.rispettaRobots) {
      const v = robotsCheck(rb, this.cfg.cortesia.nomeCrawler, u.pathname + u.search);
      if (!v.allowed) {
        this.write(
          {
            url,
            status: null,
            final_url: null,
            final_status: null,
            redirect_type: 'nessuno',
            redirect_chain: [],
            redirect_to: null,
            content_type: null,
            depth: entry.depth,
            source: entry.source,
            found_on: entry.from,
            in_sitemap: this.sitemapUrls.has(url),
            robots_txt_blocked: true,
            robots_txt_rule: `Disallow: ${v.rule!.pattern}`,
            fetched: false,
            fetch_ms: null,
            bytes: null,
            error: null,
            fetched_at: new Date().toISOString(),
            headers: {},
          },
          'vietata da robots.txt, non richiesta',
        );
        return;
      }
    }
    const res = await this.getPolitely(url);
    // Richiesta interrotta dallo stop: nessuna riga, l'indirizzo resta in coda per la ripresa
    if (this.abort.signal.aborted) return;
    this.write(this.row(entry, res, 0));

    // Passaggi successivi del redirect: se sono nel perimetro e non ancora visitati, la risposta già ricevuta
    // vale come loro visita (nessuna seconda richiesta).
    let pageUrl: string | null = res.hops.length === 1 ? url : null;
    let pageDepth = entry.depth;
    for (let i = 1; i < res.hops.length; i++) {
      const target = this.scope.normalize(res.hops[i].url);
      const isLast = i === res.hops.length - 1;
      if (!target) continue;
      let te = this.entries.get(target);
      if (!te) {
        if (this.scope.reason(target)) {
          this.exclude(`destinazione di un redirect: ${SCOPE_LABEL[this.scope.reason(target)!]}`, target);
          continue;
        }
        te = { url: target, depth: entry.depth, source: 'redirect', from: url };
        this.entries.set(target, te);
        this.store.addFrontier(te);
      }
      if (this.doneUrls.has(target) || this.inFlight.has(target)) continue;
      this.inFlight.add(target);
      try {
        await this.loadRobots(new URL(target).origin);
        this.write(this.row(te, res, i));
      } finally {
        this.inFlight.delete(target);
      }
      if (isLast) {
        pageUrl = target;
        pageDepth = te.depth;
      }
    }

    const last = res.hops.at(-1);
    // Catena rimasta a metà (errore di rete sulla destinazione): la destinazione va visitata per conto suo
    if (last?.location && res.redirectType !== 'loop') {
      const target = this.scope.normalize(last.location);
      if (target) this.enqueue(target, entry.depth, 'redirect', url);
    }
    const isHtml = /html/i.test(last?.headers['content-type'] ?? '') || (!last?.headers['content-type'] && /<html[\s>]/i.test(res.body ?? ''));
    if (!pageUrl || !res.body || !isHtml || (last?.status ?? 0) >= 400) return;
    if (res.truncated) this.note(`Pagina molto pesante letta solo in parte (oltre 8 MB): ${pageUrl}`);
    const links = extractLinks(res.body, last!.url).slice(0, MAX_LINKS_PER_PAGE);
    const rows: LinkRow[] = [];
    const childDepth = pageDepth === null ? null : pageDepth + 1;
    for (const l of links) {
      const target = this.scope.normalize(l.href);
      if (!target) continue;
      const internal = this.scope.isInternalHost(new URL(target).hostname);
      rows.push({ source_url: pageUrl, target_url: target, anchor: l.anchor, rel: l.rel, nofollow: l.nofollow, is_internal: internal, in_raw: true, in_rendered: null });
      if (collect) collect(target, childDepth);
      else if (follow) this.enqueue(target, childDepth, 'link', pageUrl);
    }
    this.store.addLinks(rows);
  }

  // ---------- avvio e ripresa ----------

  private seeds(): { url: string; source: Source; depth: number | null }[] {
    const p = this.cfg.partenza;
    const norm = (u: string) => this.scope.normalize(u);
    const out: { url: string; source: Source; depth: number | null }[] = [];
    if (p.dominio) out.push({ url: norm(p.dominio)!, source: 'partenza', depth: 0 });
    // Senza dominio di partenza, l'elenco è il punto di partenza (profondità 0)
    for (const u of p.url) out.push({ url: norm(u)!, source: 'elenco', depth: p.dominio ? null : 0 });
    return out;
  }

  private newState(): RunState {
    const now = new Date().toISOString();
    return {
      schema_version: SCHEMA_VERSION,
      tool_version: TOOL_VERSION,
      cliente: this.cfg.cliente,
      status: 'in-corso',
      started_at: now,
      updated_at: now,
      ended_at: null,
      elapsed_s: 0,
      user_agent: this.ua,
      seeds: [],
      excluded: {},
      not_reached: { count: 0, reason: null, examples: [] },
      sitemaps: [],
      robots: [],
      sample: null,
      notes: [],
      limits: [],
    };
  }

  private restore() {
    for (const e of RunStore.readFrontier(this.runDir)) this.entries.set(e.url, e);
    for (const row of RunStore.readPages(this.runDir)) {
      if (this.doneUrls.has(row.url)) continue;
      this.doneUrls.add(row.url);
      if (row.fetched) this.fetched++;
      this.counts[statusClass(row)]++;
    }
    for (const [url, e] of this.entries) if (!this.doneUrls.has(url)) this.push(url, e.depth);
    this.sitemapUrls = new Set(RunStore.readSitemapEntries(this.runDir).map((s) => this.scope.normalize(s.loc)).filter((u): u is string => !!u));
  }

  private async discoverSitemaps(): Promise<SitemapEntry[]> {
    const p = this.cfg.partenza;
    const start = [...p.sitemap];
    if (p.dominio && p.sitemapAutomatica) {
      const origin = new URL(p.dominio).origin;
      await this.loadRobots(origin);
      const declared = this.robots.get(origin)?.robots?.sitemaps ?? [];
      if (declared.length) start.push(...declared);
      else if (!start.length) start.push(`${origin}/sitemap.xml`);
    }
    if (!start.length) return [];
    this.phase = 'lettura delle sitemap';
    this.emit(true);
    const { files, entries, notes } = await readSitemaps(
      [...new Set(start)],
      async (url) => {
        const r = await this.get(url);
        return { status: r.hops.at(-1)?.status ?? null, body: r.body, error: r.error };
      },
      50000,
    );
    this.state.sitemaps = files;
    for (const n of notes) this.note(n);
    this.store.saveSitemapEntries(entries);
    return entries;
  }

  private progress(): Progress {
    const elapsed = this.priorElapsed + (this.sessionStart ? (Date.now() - this.sessionStart) / 1000 : 0);
    const sessionMin = this.sessionStart ? (Date.now() - this.sessionStart) / 60000 : 0;
    const perMinute = sessionMin > 0.05 ? this.sessionDone / sessionMin : 0;
    const queued = this.queuedCount();
    const remaining = Math.min(queued + this.inFlight.size, Math.max(0, this.cfg.perimetro.maxPagine - this.fetched));
    return {
      status: this.state.status,
      phase: this.phase,
      done: this.doneUrls.size,
      queued,
      inFlight: this.inFlight.size,
      discovered: this.entries.size,
      limit: this.cfg.perimetro.maxPagine,
      byStatus: { ...this.counts },
      perMinute: Math.round(perMinute * 10) / 10,
      etaSeconds: perMinute > 0 && this.sessionDone >= 5 ? Math.round((remaining / perMinute) * 60) : null,
      elapsedSeconds: Math.round(elapsed),
      recent: this.recent.slice(),
    };
  }

  private emit(force = false) {
    const now = Date.now();
    if (!force && now - this.lastEmit < (this.opts.progressIntervalMs ?? 400)) return;
    this.lastEmit = now;
    this.opts.onProgress?.(this.progress());
  }

  private save() {
    this.sinceSave = 0;
    this.state.updated_at = new Date().toISOString();
    this.state.elapsed_s = Math.round(this.priorElapsed + (this.sessionStart ? (Date.now() - this.sessionStart) / 1000 : 0));
    this.store.saveState(this.state);
  }

  /** Cosa non è stato verificato, in chiaro: finisce nel manifest e nel report. */
  private buildLimits(pages: PageRow[]) {
    const limits: string[] = [];
    const c = this.cfg;
    const n = (x: number, one: string, many: string) => (x === 1 ? `1 ${one}` : `${x} ${many}`);
    limits.push('Passo 2 dello strumento: per ogni indirizzo sono rilevati solo risposta e redirect, sull\'HTML ricevuto dal server. I link aggiunti da JavaScript non sono ancora seguiti.');
    if (this.state.sample) limits.push(`Scansione a campione: visitate ${this.state.sample.picked} pagine scelte per tipologia su ${this.state.sample.candidates} indirizzi candidati. Le altre non sono state verificate.`);
    if (this.state.not_reached.count) limits.push(`${n(this.state.not_reached.count, 'indirizzo scoperto non è stato visitato', 'indirizzi scoperti non sono stati visitati')}: ${this.state.not_reached.reason}.`);
    for (const [reason, e] of Object.entries(this.state.excluded)) limits.push(`Fuori perimetro (${reason}): ${n(e.count, 'link', 'link')}, non visitati.`);
    const blocked = pages.filter((p) => !p.fetched).length;
    if (blocked) limits.push(`${n(blocked, 'indirizzo vietato', 'indirizzi vietati')} da robots.txt per ${c.cortesia.nomeCrawler}: non richiesti.`);
    if (!c.cortesia.rispettaRobots) limits.push('robots.txt ignorato per scelta esplicita della configurazione: sono state visitate anche le pagine vietate ai crawler.');
    const login = pages.filter((p) => p.status === 401 || p.status === 403 || (p.redirect_to && LOGIN_RE.test(p.redirect_to))).length;
    if (login) limits.push(`${n(login, 'indirizzo richiede', 'indirizzi richiedono')} un accesso (risposta 401/403 o redirect a una pagina di login): il contenuto dietro login non è stato verificato.`);
    const errors = pages.filter((p) => p.fetched && p.status === null).length;
    if (errors) limits.push(`${n(errors, 'indirizzo non ha risposto', 'indirizzi non hanno risposto')} (errore di rete o tempo scaduto).`);
    if (!c.perimetro.seguiLink) limits.push('I link nelle pagine non sono stati seguiti (scelta della configurazione): visitati solo sitemap ed elenco.');
    this.state.limits = limits;
  }

  async run(): Promise<RunState> {
    const p = this.cfg.partenza;
    const scopeSeeds = [...(p.dominio ? [p.dominio] : []), ...p.url, ...(!p.dominio && !p.url.length ? p.sitemap : [])];
    this.scope = new Scope(this.cfg, scopeSeeds);
    const resumed = RunStore.exists(this.runDir);
    this.state = (resumed ? RunStore.readState(this.runDir) : null) ?? this.newState();
    this.priorElapsed = this.state.elapsed_s;
    this.state.status = 'in-corso';
    this.state.ended_at = null;
    this.store.saveConfig(this.loaded.raw);
    this.sessionStart = Date.now();
    this.log(resumed ? `Ripresa della scansione (${this.state.cliente})` : `Avvio della scansione (${this.cfg.cliente}), user agent: ${this.ua}`);

    try {
      if (resumed) {
        this.restore();
        this.log(`Già visitati: ${this.doneUrls.size}; in coda: ${this.queuedCount()}`);
      } else {
        const seeds = this.seeds();
        this.state.seeds = seeds.map((s) => s.url);
        this.save();
        const sm = await this.discoverSitemaps();
        this.sitemapUrls = new Set(sm.map((s) => this.scope.normalize(s.loc)).filter((u): u is string => !!u));
        if (this.cfg.modalita === 'campione') await this.prepareSample(seeds);
        else {
          for (const s of seeds) this.enqueue(s.url, s.depth, s.source, null);
          for (const u of this.sitemapUrls) this.enqueue(u, null, 'sitemap', null);
        }
        this.save();
      }

      this.phase = 'scansione delle pagine';
      const follow = this.cfg.perimetro.seguiLink && this.cfg.modalita === 'completa';
      const worker = async () => {
        for (;;) {
          if (this.stopping) return;
          if (this.fetched >= this.cfg.perimetro.maxPagine) return;
          const url = this.next();
          if (!url) {
            if (this.inFlight.size === 0) return;
            await sleep(100);
            continue;
          }
          this.inFlight.add(url);
          try {
            await this.process(url, follow);
          } catch (e) {
            this.log(`Errore imprevisto su ${url}: ${(e as Error).message}`);
            this.note(`Errore imprevisto dello strumento su ${url}: ${(e as Error).message.split('\n')[0]}`);
            this.doneUrls.add(url);
          } finally {
            this.inFlight.delete(url);
            this.emit();
          }
        }
      };
      await Promise.all(Array.from({ length: this.cfg.cortesia.paralleli }, worker));

      const left = [...this.entries.keys()].filter((u) => !this.doneUrls.has(u));
      const paused = this.stopping && left.length > 0;
      this.state.status = paused ? 'in-pausa' : 'completata';
      this.state.not_reached = paused || !left.length
        ? { count: 0, reason: null, examples: [] }
        : { count: left.length, reason: `raggiunto il limite di ${this.cfg.perimetro.maxPagine} pagine`, examples: left.slice(0, 20) };
      if (!paused) this.state.ended_at = new Date().toISOString();
      this.buildLimits(RunStore.readPages(this.runDir));
      this.phase = paused ? 'in pausa' : 'completata';
      this.log(paused ? `Scansione messa in pausa: ${this.doneUrls.size} visitati, ${left.length} in coda` : `Scansione completata: ${this.doneUrls.size} indirizzi`);
    } catch (e) {
      this.state.status = 'interrotta';
      this.note(`Scansione interrotta da un errore: ${(e as Error).message.split('\n')[0]}`);
      this.log(`ERRORE: ${(e as Error).stack ?? e}`);
      throw e;
    } finally {
      this.save();
      this.emit(true);
      this.store.close();
    }
    return this.state;
  }

  /**
   * Modalità a campione: i candidati sono le pagine in sitemap, quelle dell'elenco e i link della pagina di
   * partenza; se ne sceglie un numero per tipologia (stessa regola deterministica di Scookie).
   */
  private async prepareSample(seeds: { url: string; source: Source; depth: number | null }[]) {
    this.phase = 'scelta del campione';
    const candidates = new Map<string, { source: 'sitemap' | 'link'; depth: number | null }>();
    for (const u of this.sitemapUrls) if (!this.scope.reason(u)) candidates.set(u, { source: 'sitemap', depth: null });
    const home = seeds.find((s) => s.source === 'partenza')?.url ?? `${new URL(seeds[0]?.url ?? [...this.sitemapUrls][0] ?? this.cfg.partenza.sitemap[0]).origin}/`;
    const start = seeds.find((s) => s.source === 'partenza');
    if (start) {
      this.enqueue(start.url, 0, 'partenza', null);
      const url = this.next();
      if (url) {
        this.inFlight.add(url);
        try {
          await this.process(url, false, (target, depth) => {
            if (!this.scope.reason(target)) candidates.set(target, { source: 'link', depth });
          });
        } finally {
          this.inFlight.delete(url);
        }
      }
    }
    const extras = seeds.filter((s) => s.source === 'elenco').map((s) => s.url);
    const picked = sample(
      [...candidates].map(([url, c]) => ({ url, source: c.source })),
      home,
      extras,
      { perTipo: this.cfg.campionamento.perTipo, maxPagine: this.cfg.campionamento.maxPagine, tipi: this.cfg.campionamento.tipi },
    );
    for (const s of picked) {
      if (s.source === 'home') {
        if (!start) this.enqueue(s.url, 0, 'partenza', null);
      } else if (s.source === 'extra') this.enqueue(s.url, start ? null : 0, 'elenco', null);
      else this.enqueue(s.url, candidates.get(s.url)?.depth ?? null, s.source === 'sitemap' ? 'sitemap' : 'link', s.source === 'link' ? home : null);
    }
    this.state.sample = { candidates: candidates.size, picked: this.entries.size };
    this.log(`Campione: ${this.entries.size} pagine scelte su ${candidates.size} candidate`);
  }
}
