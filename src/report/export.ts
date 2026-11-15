import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pageType, sectionsOf, toCsv } from '../scookie/index.js';
import { parse } from 'yaml';
import { configSchema, type CrawlConfig } from '../config/schema.js';
import { Crawler } from '../crawl/crawler.js';
import { normalizeUrl } from '../crawl/scope.js';
import { RunStore, SCHEMA_VERSION, type PageRow, type RenderRow } from '../crawl/store.js';
import { canonicalOf, indexability, linkHeaderCanonical, xRobots, type CanonicalType } from '../extract/compare.js';
import { headingIssues, type PageFacts } from '../extract/extract.js';
import { ANALYSIS_COLUMNS, analyzeSite, type MergedLink, type SiteReport } from '../analyze/site.js';
import { joinTraffic, TRAFFIC_COLUMNS } from '../join/join.js';
import { readTraffic } from '../join/traffic.js';
import type { SiteChecks } from '../site/checks.js';
import { TOOL_VERSION } from '../version.js';

/**
 * Colonne di pages.csv, nell'ordine. Sono il contratto con la skill SEO: aggiungere, togliere o rinominare una
 * colonna richiede di aggiornare docs/FORMATO.md, il CHANGELOG (voce "Formato") e il test che le blocca.
 */
export const PAGE_COLUMNS = [
  // risposta (passo 2)
  'url', 'status', 'final_url', 'final_status', 'redirect_type', 'redirect_hops', 'redirect_chain', 'redirect_to', 'content_type', 'template', 'depth', 'source', 'found_on', 'in_sitemap', 'robots_txt_blocked', 'robots_txt_rule', 'fetched', 'fetch_ms', 'bytes', 'error', 'fetched_at',
  // indicizzabilità
  'robots_meta', 'x_robots_tag', 'canonical', 'canonical_type', 'canonical_count', 'indexable', 'indexability_reason',
  // contenuto
  'title', 'title_length', 'title_count', 'description', 'description_length', 'h1', 'h1_count', 'heading_issues', 'word_count', 'content_hash', 'content_simhash', 'lang', 'hreflang', 'hreflang_count', 'viewport',
  // link e immagini
  'outlinks_internal', 'outlinks_external', 'outlinks_nofollow', 'images_count', 'images_missing_alt', 'images_missing_dimensions', 'images_bytes', 'images_heavy', 'images_legacy_format',
  // dati strutturati
  'schema_types', 'schema_formats', 'schema_errors', 'schema_missing_required', 'schema_missing_recommended', 'schema_content_mismatch',
  // sorgente contro renderizzato
  'rendered', 'render_reason', 'render_error', 'raw_title', 'raw_description', 'raw_canonical', 'raw_robots_meta', 'raw_h1', 'raw_word_count', 'raw_schema_types', 'raw_outlinks_internal', 'diff_fields', 'js_only_fields', 'content_raw_ratio', 'links_only_rendered', 'links_only_raw', 'tracker_requests_blocked',
  // analisi tra pagine (passo 4)
  ...ANALYSIS_COLUMNS,
  // incrocio con Search Console e GA4 (passo 6)
  ...TRAFFIC_COLUMNS,
] as const;

export const LINK_COLUMNS = ['source_url', 'target_url', 'anchor', 'rel', 'nofollow', 'is_internal', 'in_raw', 'in_rendered', 'target_status', 'target_final_url', 'placement'] as const;

type Column = (typeof PAGE_COLUMNS)[number];
/** Una pagina nei file di dati: tutte le colonne, più i dettagli che stanno solo nel JSON. */
export type ExportedPage = Record<Column, unknown> & {
  url: string;
  status: number | null;
  final_url: string | null;
  final_status: number | null;
  template: string;
  depth: number | null;
  source: string;
  fetched: boolean;
  error: string | null;
  redirect_type: string;
  redirect_hops: number;
  redirect_chain: { url: string; status: number }[];
  robots_txt_rule: string | null;
  indexable: boolean | null;
  indexability_reason: string;
  rendered: boolean;
  diff_fields: string[];
  js_only_fields: string[];
  headers: Record<string, string>;
  headings: [number, string][];
  hreflang: { lang: string; href: string }[];
  images_heaviest: { url: string; bytes: number; type: string }[];
  rendered_url: string | null;
};

function savedConfig(runDir: string): CrawlConfig | null {
  try {
    return configSchema.parse(parse(Crawler.savedConfig(runDir) ?? ''));
  } catch {
    return null;
  }
}

/**
 * Righe delle pagine di una scansione. I campi senza prefisso (title, canonical, h1…) sono il valore che conta:
 * quello del DOM renderizzato se la pagina è stata renderizzata, altrimenti quello dell'HTML del server.
 * I campi raw_* sono sempre l'HTML del server.
 */
function basePages(runDir: string): ExportedPage[] {
  const rows = RunStore.readPages(runDir);
  const seen = new Set<string>();
  const unique = rows.filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)));
  const cfg = savedConfig(runDir);
  const crawler = cfg?.cortesia.nomeCrawler ?? 'ScrawlSEO';
  const ignored = cfg?.perimetro.parametriIgnorati ?? [];
  const normalize = (u: string) => normalizeUrl(u, undefined, ignored);
  const renders = new Map<string, RenderRow>();
  for (const r of RunStore.readRender(runDir)) renders.set(r.url, r);
  const sections = sectionsOf(unique.map((r) => r.url));
  const eligible = unique.filter((r) => r.raw).length;
  const small = eligible <= (cfg?.rendering.soglia ?? 500);

  return unique.map((r: PageRow) => {
    const rd = renders.get(r.url);
    const raw: PageFacts | null = r.raw ?? null;
    const ren: PageFacts | null = rd?.facts ?? null;
    const f = ren ?? raw;
    const isRedirect = !!r.redirect_to;
    const x = xRobots(r.headers['x-robots-tag'], crawler);
    const headerCanonical = linkHeaderCanonical(r.headers.link, r.url);
    const canon = f ? canonicalOf(f.canonicals, headerCanonical, r.url, normalize) : { canonical: null, type: 'assente' as CanonicalType, count: 0 };
    const rawCanon = raw ? canonicalOf(raw.canonicals, headerCanonical, r.url, normalize) : null;
    const idx = indexability({ fetched: r.fetched, status: r.status, isHtml: !!raw, redirect: isRedirect, robotsBlocked: r.robots_txt_blocked, xRobots: x, rawMeta: raw?.robots_meta ?? [], renderedMeta: ren?.robots_meta ?? null, canonicalType: canon.type, error: r.error });
    const renderReason = rd
      ? rd.reason
      : !raw
        ? ''
        : cfg && !cfg.rendering.attivo
          ? 'non renderizzata: rendering disattivato'
          : small
            ? 'non renderizzata'
            : 'non renderizzata: il campione del suo modello non mostra differenze e il sorgente non è sospetto';
    return {
      url: r.url,
      status: r.status,
      final_url: r.final_url,
      final_status: r.final_status,
      redirect_type: r.redirect_type,
      redirect_hops: Math.max(0, r.redirect_chain.length - 1),
      redirect_chain: r.redirect_chain,
      redirect_to: r.redirect_to,
      content_type: r.content_type,
      template: pageType(r.url, cfg?.campionamento.tipi ?? {}, sections),
      depth: r.depth,
      source: r.source,
      found_on: r.found_on,
      in_sitemap: r.in_sitemap,
      robots_txt_blocked: r.robots_txt_blocked,
      robots_txt_rule: r.robots_txt_rule,
      fetched: r.fetched,
      fetch_ms: r.fetch_ms,
      bytes: r.bytes,
      error: r.error,
      fetched_at: r.fetched_at,

      robots_meta: f?.robots_meta ?? [],
      x_robots_tag: x,
      canonical: canon.canonical,
      canonical_type: f ? canon.type : null,
      canonical_count: f ? canon.count : null,
      indexable: idx.indexable,
      indexability_reason: idx.reason,

      title: f?.title ?? null,
      title_length: f ? (f.title?.length ?? 0) : null,
      title_count: f?.title_count ?? null,
      description: f?.description ?? null,
      description_length: f ? (f.description?.length ?? 0) : null,
      h1: f?.h1 ?? [],
      h1_count: f ? f.h1.length : null,
      heading_issues: f ? headingIssues(f) : [],
      word_count: f?.word_count ?? null,
      content_hash: f?.content_hash ?? null,
      content_simhash: f?.content_simhash ?? null,
      lang: f?.lang ?? null,
      hreflang: f?.hreflang ?? [],
      hreflang_count: f ? f.hreflang.length : null,
      viewport: f?.viewport ?? null,

      outlinks_internal: f?.links_internal ?? null,
      outlinks_external: f?.links_external ?? null,
      outlinks_nofollow: f?.links_nofollow ?? null,
      images_count: f?.images_count ?? null,
      images_missing_alt: f?.images_missing_alt ?? null,
      images_missing_dimensions: f?.images_missing_dimensions ?? null,
      // peso e formato si conoscono solo per le pagine renderizzate: il browser ha scaricato le immagini
      images_bytes: ren ? rd!.images.bytes : null,
      images_heavy: ren ? rd!.images.heavy : null,
      images_legacy_format: ren ? rd!.images.legacy_format : null,

      schema_types: f?.schema.types ?? [],
      schema_formats: f?.schema.formats ?? [],
      schema_errors: f?.schema.errors ?? [],
      schema_missing_required: f?.schema.missing_required ?? [],
      schema_missing_recommended: f?.schema.missing_recommended ?? [],
      schema_content_mismatch: f?.schema.content_mismatch ?? [],

      rendered: !!ren,
      render_reason: renderReason,
      render_error: rd?.error ?? null,
      raw_title: raw?.title ?? null,
      raw_description: raw?.description ?? null,
      raw_canonical: rawCanon?.canonical ?? null,
      raw_robots_meta: raw?.robots_meta ?? [],
      raw_h1: raw?.h1 ?? [],
      raw_word_count: raw?.word_count ?? null,
      raw_schema_types: raw?.schema.types ?? [],
      raw_outlinks_internal: raw?.links_internal ?? null,
      diff_fields: rd?.diff?.diff_fields ?? [],
      js_only_fields: rd?.diff?.js_only_fields ?? [],
      content_raw_ratio: rd?.diff?.content_raw_ratio ?? null,
      links_only_rendered: rd?.diff ? rd.diff.links_only_rendered : null,
      links_only_raw: rd?.diff ? rd.diff.links_only_raw : null,
      tracker_requests_blocked: rd ? rd.tracker_requests_blocked : null,

      headers: r.headers,
      headings: f?.headings ?? [],
      images_heaviest: rd?.images.heaviest ?? [],
      rendered_url: rd?.rendered_url ?? null,
    } as unknown as ExportedPage;
  });
}

/** Link del sorgente e del renderizzato, uniti per pagina e destinazione. */
function mergedLinks(runDir: string): MergedLink[] {
  const rendered = new Set(RunStore.readRender(runDir).filter((r) => r.facts).map((r) => r.url));
  const inRender = new Map<string, Set<string>>();
  const renderLinks = RunStore.readRenderLinks(runDir);
  for (const l of renderLinks) {
    const set = inRender.get(l.source_url);
    if (set) set.add(l.target_url);
    else inRender.set(l.source_url, new Set([l.target_url]));
  }
  const inRaw = new Map<string, Set<string>>();
  const out: MergedLink[] = [];
  for (const l of RunStore.readLinks(runDir)) {
    const set = inRaw.get(l.source_url);
    if (set) set.add(l.target_url);
    else inRaw.set(l.source_url, new Set([l.target_url]));
    out.push({ source_url: l.source_url, target_url: l.target_url, anchor: l.anchor, rel: l.rel, nofollow: l.nofollow, is_internal: l.is_internal, in_raw: true, in_rendered: rendered.has(l.source_url) ? (inRender.get(l.source_url)?.has(l.target_url) ?? false) : null, placement: l.placement ?? '' });
  }
  for (const l of renderLinks) {
    if (inRaw.get(l.source_url)?.has(l.target_url)) continue;
    out.push({ source_url: l.source_url, target_url: l.target_url, anchor: l.anchor, rel: l.rel, nofollow: l.nofollow, is_internal: l.is_internal, in_raw: false, in_rendered: true, placement: l.placement });
  }
  return out;
}

export interface LoadedRun {
  pages: ExportedPage[];
  links: MergedLink[];
  site: SiteReport;
}

const cache = new Map<string, { stamp: string; run: LoadedRun }>();

/**
 * Tutti i dati di una scansione, con l'analisi tra pagine. Il risultato resta in memoria finché i file della
 * scansione non cambiano: l'interfaccia lo chiede a ogni filtro e su un sito grande rileggerlo ogni volta è lento.
 */
export function loadRun(runDir: string): LoadedRun {
  const stamp = ['pagine.jsonl', 'render.jsonl', 'link.jsonl', 'link-render.jsonl', 'controllo-link.jsonl', 'sito.json', 'traffico.json']
    .map((f) => (existsSync(join(runDir, f)) ? `${statSync(join(runDir, f)).size}-${statSync(join(runDir, f)).mtimeMs}` : 0))
    .join(':');
  const hit = cache.get(runDir);
  if (hit && hit.stamp === stamp) return hit.run;
  const cfg = savedConfig(runDir);
  const state = RunStore.readState(runDir);
  const ignored = cfg?.perimetro.parametriIgnorati ?? [];
  const pages = basePages(runDir);
  const links = mergedLinks(runDir);
  const site = analyzeSite(pages, {
    links,
    seeds: state?.seeds ?? [],
    sitemap: RunStore.readSitemapEntries(runDir),
    sitemapFiles: state?.sitemaps ?? [],
    checks: RunStore.readLinkChecks(runDir),
    site: RunStore.readSite<SiteChecks>(runDir),
    assets: RunStore.readAssets(runDir),
    robotsText: RunStore.readRobotsTexts(runDir),
    followedLinks: !cfg || (cfg.modalita === 'completa' && cfg.perimetro.seguiLink),
    normalize: (u) => normalizeUrl(u, undefined, ignored),
  });
  site.traffic = joinTraffic(pages, readTraffic(runDir), (u) => normalizeUrl(u, undefined, ignored));
  const run = { pages, links, site };
  if (cache.size > 4) cache.clear();
  cache.set(runDir, { stamp, run });
  return run;
}

export const loadPages = (runDir: string): ExportedPage[] => loadRun(runDir).pages;

/** Valore di una cella CSV: elenchi separati da " | ", booleani true/false, vuoto per il dato assente. */
function cell(c: Column, p: ExportedPage): unknown {
  const v = p[c];
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (c === 'redirect_chain') return p.redirect_chain.map((h) => `${h.status} ${h.url}`).join(' > ');
  if (c === 'hreflang') return p.hreflang.map((h) => `${h.lang}=${h.href}`).join(' | ');
  if (Array.isArray(v)) return v.join(' | ');
  return v;
}

const bool = (v: boolean | null | undefined) => (v === null || v === undefined ? '' : v ? 'true' : 'false');

/** Scrive i file di dati della scansione: pages.csv, pages.json, links.csv, site.json, manifest.json. */
export function exportRun(runDir: string): string[] {
  const { pages, links, site } = loadRun(runDir);
  const state = RunStore.readState(runDir);
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  const checks = new Map(RunStore.readLinkChecks(runDir).map((c) => [c.url, c]));

  writeFileSync(join(runDir, 'pages.csv'), toCsv([...PAGE_COLUMNS], pages.map((p) => PAGE_COLUMNS.map((c) => cell(c, p)))));
  writeFileSync(join(runDir, 'pages.json'), JSON.stringify(pages, null, 1));

  // Codice della destinazione: dalla scansione, o dalla verifica dei link per gli indirizzi non scansionati
  const target = (url: string) => {
    const t = byUrl.get(url);
    if (t) return [t.status ?? '', t.final_url && t.final_url !== t.url ? t.final_url : ''];
    const c = checks.get(url);
    return c ? [c.status ?? '', c.final_url && c.final_url !== c.url ? c.final_url : ''] : ['', ''];
  };
  writeFileSync(
    join(runDir, 'links.csv'),
    toCsv(
      [...LINK_COLUMNS],
      links.map((l) => [l.source_url, l.target_url, l.anchor, l.rel, bool(l.nofollow), bool(l.is_internal), bool(l.in_raw), bool(l.in_rendered), ...target(l.target_url), l.placement]),
    ),
  );
  writeFileSync(join(runDir, 'site.json'), JSON.stringify({ schema_version: SCHEMA_VERSION, ...site }, null, 2));

  writeFileSync(
    join(runDir, 'manifest.json'),
    JSON.stringify(
      {
        schema_version: SCHEMA_VERSION,
        schema_note: 'Formato in costruzione: finché schema_version è 0 le colonne possono solo aumentare. Vedi docs/FORMATO.md.',
        tool: 'scrawl',
        tool_version: TOOL_VERSION,
        exported_at: new Date().toISOString(),
        cliente: state?.cliente ?? null,
        status: state?.status ?? null,
        started_at: state?.started_at ?? null,
        ended_at: state?.ended_at ?? null,
        user_agent: state?.user_agent ?? null,
        seeds: state?.seeds ?? [],
        counts: { pages: pages.length, links: links.length, rendered: pages.filter((p) => p.rendered).length, links_checked: checks.size },
        rendering: state?.rendering ?? null,
        sitemaps: state?.sitemaps ?? [],
        robots: state?.robots ?? [],
        sample: state?.sample ?? null,
        excluded: state?.excluded ?? {},
        not_reached: state?.not_reached ?? null,
        traffic: site.traffic?.available ? { period: site.traffic.period, gsc: site.traffic.gsc, ga4: site.traffic.ga4 } : null,
        not_verified: state?.limits ?? [],
        notes: state?.notes ?? [],
        files: { pages: ['pages.csv', 'pages.json'], links: ['links.csv'], site: 'site.json', config: 'config.yaml' },
      },
      null,
      2,
    ),
  );
  return ['pages.csv', 'pages.json', 'links.csv', 'site.json', 'manifest.json'];
}
