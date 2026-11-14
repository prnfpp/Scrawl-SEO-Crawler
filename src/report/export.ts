import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pageType, sectionsOf, toCsv } from 'scookie/engine';
import { parse } from 'yaml';
import { Crawler } from '../crawl/crawler.js';
import { RunStore, SCHEMA_VERSION, type LinkRow, type PageRow } from '../crawl/store.js';
import { TOOL_VERSION } from '../version.js';

/**
 * Colonne di pages.csv, nell'ordine. Sono il contratto con la skill SEO: aggiungere, togliere o rinominare una
 * colonna richiede di aggiornare docs/FORMATO.md, il CHANGELOG (voce "Formato") e il test che le blocca.
 */
export const PAGE_COLUMNS = [
  'url',
  'status',
  'final_url',
  'final_status',
  'redirect_type',
  'redirect_hops',
  'redirect_chain',
  'redirect_to',
  'content_type',
  'template',
  'depth',
  'source',
  'found_on',
  'in_sitemap',
  'robots_txt_blocked',
  'robots_txt_rule',
  'fetched',
  'fetch_ms',
  'bytes',
  'error',
  'fetched_at',
] as const;

export const LINK_COLUMNS = ['source_url', 'target_url', 'anchor', 'rel', 'nofollow', 'is_internal', 'in_raw', 'in_rendered', 'target_status', 'target_final_url'] as const;

export type ExportedPage = Omit<PageRow, 'redirect_chain'> & { template: string; redirect_hops: number; redirect_chain: { url: string; status: number }[] };

/** Righe delle pagine di una scansione, con il modello di pagina (tipologia) ricavato dalla struttura degli indirizzi. */
export function loadPages(runDir: string): ExportedPage[] {
  const rows = RunStore.readPages(runDir);
  const seen = new Set<string>();
  const unique = rows.filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)));
  let tipi: Record<string, string> = {};
  try {
    tipi = (parse(Crawler.savedConfig(runDir) ?? '') as { campionamento?: { tipi?: Record<string, string> } })?.campionamento?.tipi ?? {};
  } catch {
    // configurazione non leggibile: si usa solo la struttura degli indirizzi
  }
  const sections = sectionsOf(unique.map((r) => r.url));
  return unique.map((r) => ({ ...r, template: pageType(r.url, tipi, sections), redirect_hops: Math.max(0, r.redirect_chain.length - 1) }));
}

const cell = (v: unknown): unknown => (v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? 'true' : 'false') : v);

/** Scrive i file di dati della scansione: pages.csv, pages.json, links.csv, manifest.json. */
export function exportRun(runDir: string): string[] {
  const pages = loadPages(runDir);
  const state = RunStore.readState(runDir);
  const byUrl = new Map(pages.map((p) => [p.url, p]));

  writeFileSync(
    join(runDir, 'pages.csv'),
    toCsv(
      [...PAGE_COLUMNS],
      pages.map((p) => PAGE_COLUMNS.map((c) => (c === 'redirect_chain' ? p.redirect_chain.map((h) => `${h.status} ${h.url}`).join(' > ') : cell(p[c])))),
    ),
  );
  writeFileSync(join(runDir, 'pages.json'), JSON.stringify(pages, null, 1));

  const links: LinkRow[] = RunStore.readLinks(runDir);
  writeFileSync(
    join(runDir, 'links.csv'),
    toCsv(
      [...LINK_COLUMNS],
      links.map((l) => {
        const t = byUrl.get(l.target_url);
        return [l.source_url, l.target_url, l.anchor, l.rel, cell(l.nofollow), cell(l.is_internal), cell(l.in_raw), cell(l.in_rendered), cell(t?.status ?? null), cell(t && t.final_url !== t.url ? t.final_url : null)];
      }),
    ),
  );

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
        counts: { pages: pages.length, links: links.length },
        sitemaps: state?.sitemaps ?? [],
        robots: state?.robots ?? [],
        sample: state?.sample ?? null,
        excluded: state?.excluded ?? {},
        not_reached: state?.not_reached ?? null,
        not_verified: state?.limits ?? [],
        notes: state?.notes ?? [],
        files: { pages: ['pages.csv', 'pages.json'], links: ['links.csv'], config: 'config.yaml' },
      },
      null,
      2,
    ),
  );
  return ['pages.csv', 'pages.json', 'links.csv', 'manifest.json'];
}
