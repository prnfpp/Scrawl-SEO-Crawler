import { parseRobots, robotsCheck } from '../crawl/robots.js';
import type { LinkCheck, RunState } from '../crawl/store.js';
import type { SiteChecks } from '../site/checks.js';

/** Un link nei file di dati: sorgente e renderizzato uniti per pagina e destinazione. */
export interface MergedLink {
  source_url: string;
  target_url: string;
  anchor: string;
  rel: string;
  nofollow: boolean;
  is_internal: boolean;
  in_raw: boolean;
  in_rendered: boolean | null;
  placement: string;
}

/** Campi di una pagina che servono all'analisi tra pagine (gli altri passano senza essere toccati). */
export interface AnalyzablePage {
  url: string;
  status: number | null;
  final_url: string | null;
  redirect_to: unknown;
  fetched: boolean;
  template: string;
  depth: number | null;
  in_sitemap: unknown;
  robots_txt_blocked: unknown;
  indexable: boolean | null;
  indexability_reason: string;
  canonical: unknown;
  canonical_type: unknown;
  title: unknown;
  description: unknown;
  word_count: unknown;
  content_hash: unknown;
  content_simhash: unknown;
  hreflang: { lang: string; href: string }[];
  rendered: boolean;
  js_only_fields: string[];
  content_raw_ratio: unknown;
  raw_word_count: unknown;
  [key: string]: unknown;
}

/** Colonne aggiunte dall'analisi tra pagine. */
export const ANALYSIS_COLUMNS = [
  'inlinks',
  'orphan',
  'outlinks_to_redirect',
  'outlinks_to_error',
  'outlinks_external_broken',
  'title_duplicates',
  'description_duplicates',
  'content_duplicates',
  'near_duplicates',
  'duplicate_group',
  'canonical_issue',
  'hreflang_reciprocal',
  'hreflang_issues',
  'sitemap_issue',
  'sitemap_lastmod',
  'url_params',
  'pagination',
  'param_duplicate_of',
] as const;

interface Group {
  value: string;
  count: number;
  urls: string[];
}

export interface SiteReport {
  generated_at: string;
  /** Controlli fatti con richieste dedicate a fine scansione; null se non eseguiti. */
  checks: SiteChecks | null;
  robots: {
    /** Fogli di stile e script che robots.txt vieta a Googlebot: senza, la pagina può essere resa male. */
    blocked_assets: { count: number; examples: string[] };
    /** Sezioni con pagine vietate che il sito stesso linka o mette in sitemap. */
    blocked_sections: { section: string; pages: number; in_sitemap: number; examples: string[] }[];
  };
  sitemap: {
    files: RunState['sitemaps'];
    entries: number;
    not_crawled: { count: number; examples: string[] };
    non_indexable: { count: number; by_reason: Record<string, number>; examples: { url: string; reason: string }[] };
    indexable_missing: { count: number; examples: string[] };
    lastmod: { with_date: number; without_date: number; invalid: number; future: number; most_common: { value: string; share: number } | null; note: string };
  };
  links: {
    internal_to_error: { links: number; targets: { url: string; status: number | null; sources: number; example_source: string }[] };
    internal_to_redirect: { links: number; targets: { url: string; status: number | null; sources: number; example_source: string }[] };
    external_broken: { links: number; targets: { url: string; status: number | null; error: string | null; sources: number; example_source: string }[] };
    external_checked: number;
    /** Siti esterni che rifiutano i crawler (401, 403, 429): il link può funzionare per una persona. */
    external_unverifiable: number;
  };
  orphans: { applicable: boolean; count: number; examples: string[]; note: string };
  duplicates: { titles: Group[]; descriptions: Group[]; content: Group[]; near: Group[] };
  parameters: { name: string; urls: number; duplicates: number; examples: string[] }[];
  pagination: { pages: number; canonical_to_other: number; noindex: number; examples: string[] };
  hreflang: { pages: number; languages: Record<string, number>; not_reciprocal: number; invalid_codes: string[]; examples: { url: string; issue: string }[] };
  geo: {
    /** Quanta parte del contenuto principale si legge senza eseguire JavaScript, sulle pagine renderizzate. */
    content_without_js: { rendered_pages: number; average_ratio: number | null; pages_below_half: number; js_only_content: number; by_template: { template: string; pages: number; average_ratio: number }[] };
  };
}

export interface AnalysisInput {
  links: MergedLink[];
  seeds: string[];
  sitemap: { loc: string; lastmod: string | null }[];
  sitemapFiles: RunState['sitemaps'];
  checks: LinkCheck[];
  site: SiteChecks | null;
  assets: string[];
  /** Testo dei robots.txt letti, per host. */
  robotsText: Record<string, string>;
  /** False se i link non sono stati seguiti (modalità a campione): le pagine orfane non si possono dire. */
  followedLinks: boolean;
  normalize: (u: string) => string | null;
}

const key = (v: unknown) => String(v ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const PAGINATION_PARAMS = new Set(['page', 'p', 'pagina', 'paged', 'pg', 'pagenum', 'page_number', 'start', 'offset']);
const LANG_RE = /^(?:x-default|[a-z]{2,3}(?:-[a-z0-9]{2,8})*)$/i;

/** Bit diversi tra due simhash scritti in esadecimale (16 cifre), senza BigInt: serve su migliaia di pagine. */
function popcount32(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function topGroups(map: Map<string, string[]>, label: (k: string) => string): Group[] {
  return [...map.entries()]
    .filter(([, urls]) => urls.length > 1)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 50)
    .map(([k, urls]) => ({ value: label(k), count: urls.length, urls: urls.slice(0, 20) }));
}

/**
 * Analisi che richiede di guardare più pagine insieme: grafo dei link e profondità, pagine orfane, duplicati,
 * canonical e hreflang tra pagine, sitemap, parametri e paginazione. Aggiunge le colonne ANALYSIS_COLUMNS alle
 * pagine (modificandole) e restituisce il riepilogo del sito.
 */
export function analyzeSite<T extends AnalyzablePage>(pages: T[], input: AnalysisInput): SiteReport {
  const byUrl = new Map<string, T>(pages.map((p) => [p.url, p]));
  const checkOf = new Map(input.checks.map((c) => [c.url, c]));
  const isError = (p: T) => p.fetched && (p.status === null || p.status >= 400);
  const isRedirect = (p: T) => !!p.redirect_to;

  // ---------- grafo dei link ----------
  const inlinks = new Map<string, Set<string>>();
  const out = new Map<string, Set<string>>();
  const toError = new Map<string, Set<string>>();
  const toRedirect = new Map<string, Set<string>>();
  const extBroken = new Map<string, Set<string>>();
  // le stesse relazioni viste dalla pagina che contiene il link
  const srcRedirect = new Map<string, Set<string>>();
  const srcError = new Map<string, Set<string>>();
  const srcExt = new Map<string, Set<string>>();
  let linksToError = 0;
  let linksToRedirect = 0;
  let linksExtBroken = 0;
  const add = (m: Map<string, Set<string>>, k: string, v: string) => {
    const s = m.get(k);
    if (s) s.add(v);
    else m.set(k, new Set([v]));
  };
  const brokenCheck = (c: LinkCheck) => (c.status !== null ? c.status === 404 || c.status === 410 || c.status >= 500 : !!c.error && /DNS|rifiutata|certificato/.test(c.error));
  const unverifiable = (c: LinkCheck) => c.status !== null && [401, 403, 405, 406, 429, 999].includes(c.status);
  for (const l of input.links) {
    if (!byUrl.has(l.source_url)) continue;
    const t = byUrl.get(l.target_url);
    if (l.is_internal && t) {
      if (l.source_url !== l.target_url) add(inlinks, l.target_url, l.source_url);
      add(out, l.source_url, l.target_url);
      if (isRedirect(t)) {
        add(toRedirect, l.target_url, l.source_url);
        add(srcRedirect, l.source_url, l.target_url);
        linksToRedirect++;
      } else if (isError(t)) {
        add(toError, l.target_url, l.source_url);
        add(srcError, l.source_url, l.target_url);
        linksToError++;
      }
      continue;
    }
    const c = checkOf.get(l.target_url);
    if (c && brokenCheck(c)) {
      if (c.kind === 'file') {
        add(toError, l.target_url, l.source_url);
        add(srcError, l.source_url, l.target_url);
        linksToError++;
      } else {
        add(extBroken, l.target_url, l.source_url);
        add(srcExt, l.source_url, l.target_url);
        linksExtBroken++;
      }
    }
  }

  // Profondità: cammino più breve dalle pagine di partenza seguendo i link; un redirect non costa un clic
  const depth = new Map<string, number>();
  let frontier = input.seeds.filter((s) => byUrl.has(s));
  for (const s of frontier) depth.set(s, 0);
  const follow = (u: string, d: number, next: string[]) => {
    // catena di redirect: stessa profondità di chi rimanda
    let cur = byUrl.get(u);
    const seen = new Set<string>();
    while (cur && isRedirect(cur) && !seen.has(cur.url)) {
      seen.add(cur.url);
      const to = input.normalize(String(cur.redirect_to));
      if (!to || !byUrl.has(to)) break;
      if (!depth.has(to) || depth.get(to)! > d) {
        depth.set(to, d);
        next.push(to);
      }
      cur = byUrl.get(to);
    }
  };
  for (let d = 0; frontier.length; d++) {
    const next: string[] = [];
    const level = [...frontier];
    for (const u of level) follow(u, d, level);
    for (const u of level) {
      for (const t of out.get(u) ?? []) {
        if (depth.has(t)) continue;
        depth.set(t, d + 1);
        next.push(t);
      }
    }
    frontier = next;
  }

  // ---------- duplicati (solo tra pagine indicizzabili) ----------
  const indexable = pages.filter((p) => p.indexable === true);
  const titles = new Map<string, string[]>();
  const descs = new Map<string, string[]>();
  const hashes = new Map<string, string[]>();
  for (const p of indexable) {
    const t = key(p.title);
    if (t) titles.set(t, [...(titles.get(t) ?? []), p.url]);
    const d = key(p.description);
    if (d) descs.set(d, [...(descs.get(d) ?? []), p.url]);
    const h = String(p.content_hash ?? '');
    // sotto le 30 parole due pagine "uguali" sono solo due pagine vuote: è un altro problema (pagina scarna)
    if (h && Number(p.word_count ?? 0) >= 30) hashes.set(h, [...(hashes.get(h) ?? []), p.url]);
  }
  // Quasi duplicati: simhash a distanza di 3 bit o meno, raggruppati
  const sim = indexable.filter((p) => String(p.content_simhash ?? '').length === 16 && Number(p.word_count ?? 0) >= 50);
  const hi = sim.map((p) => parseInt(String(p.content_simhash).slice(0, 8), 16));
  const lo = sim.map((p) => parseInt(String(p.content_simhash).slice(8), 16));
  const parent = sim.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < sim.length; i++) {
    for (let j = i + 1; j < sim.length; j++) {
      if (popcount32((hi[i] ^ hi[j]) >>> 0) + popcount32((lo[i] ^ lo[j]) >>> 0) <= 3) parent[find(i)] = find(j);
    }
  }
  const clusters = new Map<number, string[]>();
  sim.forEach((p, i) => clusters.set(find(i), [...(clusters.get(find(i)) ?? []), p.url]));
  const nearOf = new Map<string, string[]>();
  for (const urls of clusters.values()) if (urls.length > 1) for (const u of urls) nearOf.set(u, urls);
  const representative = (urls: string[]) => [...urls].sort((a, b) => (depth.get(a) ?? 999) - (depth.get(b) ?? 999) || a.length - b.length || a.localeCompare(b))[0];

  // ---------- sitemap ----------
  const lastmodOf = new Map<string, string | null>();
  for (const e of input.sitemap) {
    const u = input.normalize(e.loc);
    if (u && !lastmodOf.has(u)) lastmodOf.set(u, e.lastmod);
  }
  const hasSitemap = lastmodOf.size > 0;

  // ---------- hreflang: chi punta a chi ----------
  const hreflangTargets = new Map<string, string[]>();
  for (const p of pages) hreflangTargets.set(p.url, (p.hreflang ?? []).map((h) => input.normalize(h.href)).filter((u): u is string => !!u));
  const pointedByHreflang = new Set<string>();
  for (const [src, targets] of hreflangTargets) for (const t of targets) if (t !== src) pointedByHreflang.add(t);

  const params = new Map<string, { urls: string[]; duplicates: number }>();
  const report: Pick<SiteReport, 'pagination' | 'hreflang'> = {
    pagination: { pages: 0, canonical_to_other: 0, noindex: 0, examples: [] },
    hreflang: { pages: 0, languages: {}, not_reciprocal: 0, invalid_codes: [], examples: [] },
  };
  const sitemapNonIndexable: { url: string; reason: string }[] = [];
  const sitemapMissing: string[] = [];
  const orphans: string[] = [];

  for (const page of pages) {
    // le colonne dell'analisi si scrivono sulla pagina stessa
    const p: AnalyzablePage = page;
    const isPage = p.status === 200 && p.raw_word_count !== null && p.raw_word_count !== undefined;
    p.depth = depth.get(p.url) ?? null;
    p.inlinks = inlinks.get(p.url)?.size ?? 0;
    p.orphan = input.followedLinks ? isPage && p.depth === null : null;
    if (p.orphan) orphans.push(p.url);

    const nRedirect = srcRedirect.get(p.url)?.size ?? 0;
    const nError = srcError.get(p.url)?.size ?? 0;
    const nExt = srcExt.get(p.url)?.size ?? 0;
    p.outlinks_to_redirect = isPage ? nRedirect : null;
    p.outlinks_to_error = isPage ? nError : null;
    p.outlinks_external_broken = isPage ? nExt : null;

    // duplicati
    const dupT = p.indexable ? (titles.get(key(p.title))?.length ?? 1) - 1 : null;
    const dupD = p.indexable ? (descs.get(key(p.description))?.length ?? 1) - 1 : null;
    const exact = p.indexable ? (hashes.get(String(p.content_hash ?? '')) ?? [p.url]) : [p.url];
    const near = (nearOf.get(p.url) ?? [p.url]).filter((u) => !exact.includes(u));
    p.title_duplicates = dupT;
    p.description_duplicates = dupD;
    p.content_duplicates = p.indexable ? exact.length - 1 : null;
    p.near_duplicates = p.indexable ? near.length : null;
    const cluster = [...new Set([...exact, ...(nearOf.get(p.url) ?? [])])];
    p.duplicate_group = cluster.length > 1 ? representative(cluster) : null;

    // canonical tra pagine
    const ci: string[] = [];
    if (p.canonical_type === 'in-conflitto') ci.push('più canonical diversi tra loro');
    if (p.canonical_type === 'non-valido') ci.push('canonical vuoto o non valido');
    if (p.canonical_type === 'altra-pagina') {
      const t = byUrl.get(String(p.canonical));
      if (!t) ci.push('canonical verso un indirizzo non scansionato');
      else if (isRedirect(t)) ci.push(`canonical verso un redirect (${t.status})`);
      else if (isError(t)) ci.push(`canonical verso una pagina in errore (${t.status ?? 'nessuna risposta'})`);
      else if (!t.fetched) ci.push('canonical verso una pagina vietata da robots.txt');
      else if (t.canonical_type === 'altra-pagina') ci.push('canonical in catena: la destinazione ha a sua volta un canonical verso un\'altra pagina');
      else if (t.indexable === false) ci.push(`canonical verso una pagina non indicizzabile (${t.indexability_reason})`);
      if (p.in_sitemap) ci.push('in sitemap, ma con canonical verso un\'altra pagina');
      if (pointedByHreflang.has(p.url)) ci.push('indicata come versione in lingua (hreflang), ma con canonical verso un\'altra pagina');
    }
    p.canonical_issue = ci;

    // hreflang
    const hl = isPage ? (p.hreflang ?? []) : [];
    const hi2: string[] = [];
    let reciprocal: boolean | null = null;
    if (hl.length) {
      report.hreflang.pages++;
      reciprocal = true;
      let unknown = 0;
      let self = false;
      for (const h of hl) {
        report.hreflang.languages[h.lang] = (report.hreflang.languages[h.lang] ?? 0) + 1;
        if (!LANG_RE.test(h.lang)) {
          hi2.push(`codice lingua non valido "${h.lang}"`);
          if (!report.hreflang.invalid_codes.includes(h.lang)) report.hreflang.invalid_codes.push(h.lang);
        }
        const t = input.normalize(h.href);
        if (!t) continue;
        if (t === p.url) {
          self = true;
          continue;
        }
        const tp = byUrl.get(t);
        if (!tp) {
          unknown++;
          continue;
        }
        if (isRedirect(tp) || isError(tp) || tp.indexable === false) {
          hi2.push(`${h.lang}: destinazione non indicizzabile (${tp.indexability_reason || tp.status}) ${t}`);
          reciprocal = false;
        } else if (!(hreflangTargets.get(t) ?? []).includes(p.url)) {
          hi2.push(`${h.lang}: manca il ritorno da ${t}`);
          reciprocal = false;
        }
      }
      if (!self) hi2.push('manca il riferimento a sé stessa');
      if (unknown) {
        hi2.push(`${unknown === 1 ? '1 destinazione non scansionata' : `${unknown} destinazioni non scansionate`}: reciprocità non verificata`);
        if (reciprocal) reciprocal = null;
      }
      if (reciprocal === false) report.hreflang.not_reciprocal++;
      if (hi2.length && report.hreflang.examples.length < 20) report.hreflang.examples.push({ url: p.url, issue: hi2[0] });
    }
    p.hreflang_reciprocal = reciprocal;
    p.hreflang_issues = hi2;

    // sitemap
    let si = '';
    if (p.in_sitemap) {
      if (p.indexable === false) {
        si = `in sitemap ma non indicizzabile: ${p.indexability_reason}`;
        sitemapNonIndexable.push({ url: p.url, reason: p.indexability_reason });
      }
    } else if (hasSitemap && p.indexable === true) {
      si = 'indicizzabile ma assente dalla sitemap';
      sitemapMissing.push(p.url);
    }
    p.sitemap_issue = si || null;
    p.sitemap_lastmod = lastmodOf.get(p.url) ?? null;

    // parametri e paginazione
    const u = new URL(p.url);
    const names = [...new Set([...u.searchParams.keys()])];
    p.url_params = names;
    let pageNo: string | null = null;
    for (const [k, v] of u.searchParams) if (PAGINATION_PARAMS.has(k.toLowerCase()) && /^\d+$/.test(v)) pageNo = v;
    const m = /\/(?:page|pagina|p)\/(\d+)\/?$/i.exec(u.pathname);
    if (m) pageNo = m[1];
    p.pagination = pageNo ? `pagina ${pageNo}` : null;
    if (pageNo && isPage) {
      report.pagination.pages++;
      if (p.canonical_type === 'altra-pagina') report.pagination.canonical_to_other++;
      if (p.indexable === false && /noindex/.test(p.indexability_reason)) report.pagination.noindex++;
      if (report.pagination.examples.length < 10) report.pagination.examples.push(p.url);
    }
    let dupOf: string | null = null;
    if (names.length && isPage) {
      const bareUrl = input.normalize(u.origin + u.pathname);
      const base = bareUrl ? byUrl.get(bareUrl) : undefined;
      // Stessa pagina con e senza parametri: stesso contenuto, oppure stesso title quando il contenuto è poco
      if (base && base.url !== p.url && !pageNo && ((p.content_hash && p.content_hash === base.content_hash) || (key(p.title) && key(p.title) === key(base.title)))) dupOf = base.url;
      for (const n of names) {
        const e = params.get(n) ?? { urls: [], duplicates: 0 };
        e.urls.push(p.url);
        if (dupOf) e.duplicates++;
        params.set(n, e);
      }
    }
    p.param_duplicate_of = dupOf;
  }

  // ---------- robots.txt: risorse e sezioni bloccate ----------
  const robots = new Map(Object.entries(input.robotsText).map(([host, text]) => [host, parseRobots(text)]));
  const blockedAssets: string[] = [];
  for (const a of input.assets) {
    try {
      const u = new URL(a);
      const r = robots.get(u.host);
      if (r && !robotsCheck(r, 'Googlebot', u.pathname + u.search).allowed) blockedAssets.push(a);
    } catch {
      // indirizzo non valido
    }
  }
  const sections = new Map<string, { pages: number; in_sitemap: number; examples: string[] }>();
  for (const p of pages) {
    if (!p.robots_txt_blocked) continue;
    const seg = `/${new URL(p.url).pathname.split('/').filter(Boolean)[0] ?? ''}`;
    const s = sections.get(seg) ?? { pages: 0, in_sitemap: 0, examples: [] };
    s.pages++;
    if (p.in_sitemap) s.in_sitemap++;
    if (s.examples.length < 5) s.examples.push(p.url);
    sections.set(seg, s);
  }

  // ---------- date della sitemap ----------
  const now = Date.now();
  let withDate = 0;
  let invalid = 0;
  let future = 0;
  const values = new Map<string, number>();
  for (const e of input.sitemap) {
    if (!e.lastmod) continue;
    withDate++;
    const t = Date.parse(e.lastmod);
    if (!Number.isFinite(t) || !/^\d{4}-\d{2}(-\d{2})?/.test(e.lastmod) || t < Date.parse('1995-01-01')) invalid++;
    else if (t > now + 86400000) future++;
    const day = e.lastmod.slice(0, 10);
    values.set(day, (values.get(day) ?? 0) + 1);
  }
  const top = [...values.entries()].sort((a, b) => b[1] - a[1])[0];
  const share = top && withDate ? Math.round((top[1] / withDate) * 100) / 100 : 0;
  const lastmodNote = !input.sitemap.length
    ? 'nessuna sitemap letta'
    : !withDate
      ? 'nessuna data di modifica nella sitemap'
      : invalid || future
        ? `${invalid ? `${invalid} date non valide` : ''}${invalid && future ? ', ' : ''}${future ? `${future} date nel futuro` : ''}`
        : withDate >= 20 && share >= 0.9
          ? `il ${Math.round(share * 100)}% delle pagine ha la stessa data (${top![0]}): probabilmente è la data di generazione della sitemap, non quella di modifica della pagina`
          : 'date plausibili';
  const notCrawled = [...lastmodOf.keys()].filter((u) => !byUrl.has(u));

  // ---------- contenuto leggibile senza JavaScript ----------
  const rendered = pages.filter((p) => p.rendered && typeof p.content_raw_ratio === 'number');
  const ratio = (list: T[]) => Math.round((list.reduce((n, p) => n + Number(p.content_raw_ratio), 0) / list.length) * 100) / 100;
  const byTemplate = new Map<string, T[]>();
  for (const p of rendered) byTemplate.set(p.template, [...(byTemplate.get(p.template) ?? []), p]);

  const targets = (m: Map<string, Set<string>>) =>
    [...m.entries()]
      .sort((a, b) => b[1].size - a[1].size)
      .slice(0, 100)
      .map(([url, sources]) => ({ url, status: byUrl.get(url)?.status ?? checkOf.get(url)?.status ?? null, error: checkOf.get(url)?.error ?? null, sources: sources.size, example_source: [...sources][0] }));

  return {
    generated_at: new Date().toISOString(),
    checks: input.site,
    robots: {
      blocked_assets: { count: blockedAssets.length, examples: blockedAssets.slice(0, 20) },
      blocked_sections: [...sections.entries()].map(([section, s]) => ({ section, ...s })).sort((a, b) => b.pages - a.pages),
    },
    sitemap: {
      files: input.sitemapFiles,
      entries: input.sitemap.length,
      not_crawled: { count: notCrawled.length, examples: notCrawled.slice(0, 20) },
      non_indexable: {
        count: sitemapNonIndexable.length,
        by_reason: sitemapNonIndexable.reduce<Record<string, number>>((acc, x) => ((acc[x.reason] = (acc[x.reason] ?? 0) + 1), acc), {}),
        examples: sitemapNonIndexable.slice(0, 20),
      },
      indexable_missing: { count: sitemapMissing.length, examples: sitemapMissing.slice(0, 20) },
      lastmod: { with_date: withDate, without_date: input.sitemap.length - withDate, invalid, future, most_common: top ? { value: top[0], share } : null, note: lastmodNote },
    },
    links: {
      internal_to_error: { links: linksToError, targets: targets(toError).map(({ error: _e, ...t }) => t) },
      internal_to_redirect: { links: linksToRedirect, targets: targets(toRedirect).map(({ error: _e, ...t }) => t) },
      external_broken: { links: linksExtBroken, targets: targets(extBroken) },
      external_checked: input.checks.filter((c) => c.kind === 'esterno').length,
      external_unverifiable: input.checks.filter((c) => c.kind === 'esterno' && unverifiable(c)).length,
    },
    orphans: {
      applicable: input.followedLinks,
      count: orphans.length,
      examples: orphans.slice(0, 30),
      note: input.followedLinks ? 'pagine note dalla sitemap o dall\'elenco, ma non raggiungibili seguendo i link dal punto di partenza' : 'non valutabile: in questa scansione i link non sono stati seguiti',
    },
    duplicates: {
      titles: topGroups(titles, (k) => String(byUrl.get(titles.get(k)![0])?.title ?? k)),
      descriptions: topGroups(descs, (k) => String(byUrl.get(descs.get(k)![0])?.description ?? k)),
      content: topGroups(hashes, (k) => k),
      near: [...clusters.values()].filter((u) => u.length > 1).sort((a, b) => b.length - a.length).slice(0, 50).map((urls) => ({ value: representative(urls), count: urls.length, urls: urls.slice(0, 20) })),
    },
    parameters: [...params.entries()].map(([name, e]) => ({ name, urls: e.urls.length, duplicates: e.duplicates, examples: e.urls.slice(0, 5) })).sort((a, b) => b.urls - a.urls),
    pagination: report.pagination,
    hreflang: report.hreflang,
    geo: {
      content_without_js: {
        rendered_pages: rendered.length,
        average_ratio: rendered.length ? ratio(rendered) : null,
        pages_below_half: rendered.filter((p) => Number(p.content_raw_ratio) < 0.5).length,
        js_only_content: rendered.filter((p) => p.js_only_fields.includes('content')).length,
        by_template: [...byTemplate.entries()].map(([template, list]) => ({ template, pages: list.length, average_ratio: ratio(list) })).sort((a, b) => a.average_ratio - b.average_ratio),
      },
    },
  };
}
