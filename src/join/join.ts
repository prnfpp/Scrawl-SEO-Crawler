import type { AnalyzablePage } from '../analyze/site.js';
import type { Traffic } from './traffic.js';

/** Colonne aggiunte dall'incrocio con Search Console e GA4. Vuote se la fonte non è stata fornita. */
export const TRAFFIC_COLUMNS = ['gsc_clicks', 'gsc_impressions', 'gsc_ctr', 'gsc_position', 'ga4_sessions', 'ga4_organic_sessions', 'ga4_key_events', 'ga4_views', 'traffic_issue'] as const;

interface Hit {
  url: string;
  clicks: number;
  impressions: number;
  reason: string;
}

export interface TrafficReport {
  available: boolean;
  period: { start: string; end: string } | null;
  gsc: { source: string; property: string | null; urls: number; clicks: number; impressions: number; matched_urls: number; matched_clicks: number } | null;
  ga4: { source: string; property: string | null; paths: number; sessions: number; organic_sessions: number; matched_paths: number } | null;
  /** Pagine che ricevono impression o traffico ma non sono indicizzabili, sono in errore o in redirect. */
  with_traffic_not_indexable: { count: number; clicks: number; impressions: number; by_reason: Record<string, { pages: number; clicks: number; impressions: number }>; examples: Hit[] };
  /** Pagine indicizzabili che nel periodo non hanno avuto nemmeno un'impression. */
  indexable_without_impressions: { count: number; share: number; examples: string[] };
  /** Indirizzi presenti in Search Console che la scansione non ha visitato. */
  in_gsc_not_crawled: { count: number; clicks: number; impressions: number; examples: { url: string; clicks: number; impressions: number }[] };
}

/**
 * Incrocia le pagine con i dati di traffico: scrive le colonne TRAFFIC_COLUMNS sulle pagine e restituisce il
 * riepilogo. `normalize` porta gli indirizzi di Search Console nella forma usata dalla scansione.
 */
export function joinTraffic(pages: AnalyzablePage[], traffic: Traffic | null, normalize: (u: string) => string | null): TrafficReport {
  const empty: TrafficReport = {
    available: false,
    period: null,
    gsc: null,
    ga4: null,
    with_traffic_not_indexable: { count: 0, clicks: 0, impressions: 0, by_reason: {}, examples: [] },
    indexable_without_impressions: { count: 0, share: 0, examples: [] },
    in_gsc_not_crawled: { count: 0, clicks: 0, impressions: 0, examples: [] },
  };
  for (const p of pages) for (const c of TRAFFIC_COLUMNS) p[c] = null;
  if (!traffic || (!traffic.gsc && !traffic.ga4)) return empty;

  const byUrl = new Map(pages.map((p) => [p.url, p]));
  const report: TrafficReport = { ...empty, available: true, period: traffic.period };

  // --- Search Console: per indirizzo completo ---
  if (traffic.gsc) {
    const sums = new Map<string, { clicks: number; impressions: number; pos: number }>();
    let clicks = 0;
    let impressions = 0;
    for (const r of traffic.gsc.rows) {
      clicks += r.clicks;
      impressions += r.impressions;
      // Search Console riporta anche gli indirizzi con frammento (#sezione): si sommano alla pagina
      const u = normalize(r.url) ?? r.url;
      const s = sums.get(u) ?? { clicks: 0, impressions: 0, pos: 0 };
      s.clicks += r.clicks;
      s.impressions += r.impressions;
      s.pos += r.position * r.impressions;
      sums.set(u, s);
    }
    let matched = 0;
    let matchedClicks = 0;
    const missing: { url: string; clicks: number; impressions: number }[] = [];
    for (const [u, s] of sums) {
      const p = byUrl.get(u);
      if (!p) {
        missing.push({ url: u, clicks: s.clicks, impressions: s.impressions });
        continue;
      }
      matched++;
      matchedClicks += s.clicks;
      p.gsc_clicks = s.clicks;
      p.gsc_impressions = s.impressions;
      p.gsc_ctr = s.impressions ? Math.round((s.clicks / s.impressions) * 10000) / 10000 : 0;
      p.gsc_position = s.impressions ? Math.round((s.pos / s.impressions) * 10) / 10 : null;
    }
    // Pagina visitata ma assente da Search Console: zero, non "dato mancante"
    for (const p of pages) {
      if (p.gsc_clicks === null) {
        p.gsc_clicks = 0;
        p.gsc_impressions = 0;
      }
    }
    missing.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
    report.gsc = { source: traffic.gsc.source, property: traffic.gsc.property, urls: sums.size, clicks, impressions, matched_urls: matched, matched_clicks: matchedClicks };
    report.in_gsc_not_crawled = { count: missing.length, clicks: missing.reduce((a, x) => a + x.clicks, 0), impressions: missing.reduce((a, x) => a + x.impressions, 0), examples: missing.slice(0, 30) };
  }

  // --- GA4: per percorso (e host, se c'è) ---
  if (traffic.ga4) {
    const key = (host: string | null, path: string) => `${(host ?? '').replace(/^www\./, '')}\n${path}`;
    const index = new Map<string, AnalyzablePage>();
    const byPath = new Map<string, AnalyzablePage>();
    for (const p of pages) {
      const u = new URL(p.url);
      index.set(key(u.host, u.pathname + u.search), p);
      if (!byPath.has(u.pathname + u.search)) byPath.set(u.pathname + u.search, p);
    }
    let sessions = 0;
    let organic = 0;
    const matched = new Set<string>();
    for (const r of traffic.ga4.rows) {
      sessions += r.sessions;
      organic += r.organic_sessions;
      // GA4 tiene i parametri di tracciamento nel percorso: si prova il percorso com'è, poi senza query
      const bare = r.path.split('?')[0];
      const p = (r.host ? (index.get(key(r.host, r.path)) ?? index.get(key(r.host, bare))) : undefined) ?? (r.host ? undefined : (byPath.get(r.path) ?? byPath.get(bare)));
      if (!p) continue;
      matched.add(p.url);
      p.ga4_sessions = Number(p.ga4_sessions ?? 0) + r.sessions;
      p.ga4_organic_sessions = Number(p.ga4_organic_sessions ?? 0) + r.organic_sessions;
      p.ga4_key_events = Number(p.ga4_key_events ?? 0) + r.key_events;
      p.ga4_views = Number(p.ga4_views ?? 0) + r.views;
    }
    for (const p of pages) {
      if (p.ga4_sessions === null) {
        p.ga4_sessions = 0;
        p.ga4_organic_sessions = 0;
        p.ga4_key_events = 0;
        p.ga4_views = 0;
      }
    }
    report.ga4 = { source: traffic.ga4.source, property: traffic.ga4.property, paths: traffic.ga4.rows.length, sessions, organic_sessions: organic, matched_paths: matched.size };
  }

  // --- problemi pesati sul traffico ---
  const hits: Hit[] = [];
  const without: string[] = [];
  let indexable = 0;
  for (const p of pages) {
    const clicks = Number(p.gsc_clicks ?? 0);
    const impressions = Number(p.gsc_impressions ?? 0);
    const organic = Number(p.ga4_organic_sessions ?? 0);
    const has = clicks > 0 || impressions > 0 || organic > 0;
    if (p.indexable === false && has) {
      const what = impressions ? `${impressions.toLocaleString('it-IT')} impression e ${clicks.toLocaleString('it-IT')} clic` : `${organic.toLocaleString('it-IT')} sessioni dalla ricerca organica`;
      p.traffic_issue = `riceve ${what} ma non è indicizzabile: ${p.indexability_reason}`;
      hits.push({ url: p.url, clicks, impressions, reason: p.indexability_reason });
    } else if (p.indexable === true) {
      indexable++;
      if (traffic.gsc && impressions === 0) {
        p.traffic_issue = 'indicizzabile ma senza impression nel periodo';
        without.push(p.url);
      }
    }
  }
  hits.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
  const byReason: TrafficReport['with_traffic_not_indexable']['by_reason'] = {};
  for (const h of hits) {
    // "redirect (301)" e "errore 404" restano distinti; i dettagli tra parentesi dei noindex no
    const r = (byReason[h.reason] ??= { pages: 0, clicks: 0, impressions: 0 });
    r.pages++;
    r.clicks += h.clicks;
    r.impressions += h.impressions;
  }
  report.with_traffic_not_indexable = { count: hits.length, clicks: hits.reduce((a, h) => a + h.clicks, 0), impressions: hits.reduce((a, h) => a + h.impressions, 0), by_reason: byReason, examples: hits.slice(0, 50) };
  report.indexable_without_impressions = { count: without.length, share: indexable ? Math.round((without.length / indexable) * 100) / 100 : 0, examples: without.slice(0, 30) };
  return report;
}
