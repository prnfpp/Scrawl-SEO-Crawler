import { ENDPOINTS, GoogleError } from './auth.js';

async function call<T>(token: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
  } catch {
    throw new GoogleError('Google non raggiungibile: controlla la connessione.');
  }
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; status?: string } };
  if (!res.ok) {
    const msg = json.error?.message ?? `risposta ${res.status}`;
    if (/has not been used in project|is disabled|SERVICE_DISABLED/i.test(msg)) throw new GoogleError(`API non attiva nel progetto Google Cloud delle credenziali: ${msg.split('. ')[0]}.`);
    if (res.status === 403) throw new GoogleError(`L'account collegato non ha accesso a questa proprietà (${msg.slice(0, 160)}).`);
    throw new GoogleError(`Errore di Google: ${msg.slice(0, 200)}`);
  }
  return json;
}

export interface GscRow {
  url: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface Ga4Row {
  host: string | null;
  /** Percorso con l'eventuale query, come lo riporta GA4. */
  path: string;
  /** Sessioni iniziate su questa pagina (pagina di destinazione), tutti i canali. */
  sessions: number;
  /** Di cui dalla ricerca organica. */
  organic_sessions: number;
  /** Eventi chiave delle sessioni organiche iniziate su questa pagina. */
  key_events: number;
  /** Visualizzazioni della pagina. */
  views: number;
}

/** Proprietà di Search Console a cui l'account ha accesso. */
export async function gscSites(token: string): Promise<{ siteUrl: string; permissionLevel: string }[]> {
  const r = await call<{ siteEntry?: { siteUrl: string; permissionLevel: string }[] }>(token, `${ENDPOINTS.searchConsole}/sites`);
  return (r.siteEntry ?? []).filter((s) => s.permissionLevel !== 'siteUnverifiedUser').sort((a, b) => a.siteUrl.localeCompare(b.siteUrl));
}

/** Clic e impression per pagina nel periodo (ricerca web, tutti i paesi e dispositivi). */
export async function gscPages(token: string, site: string, start: string, end: string, max = 100000): Promise<GscRow[]> {
  const rows: GscRow[] = [];
  for (let startRow = 0; startRow < max; startRow += 25000) {
    const r = await call<{ rows?: { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }[] }>(token, `${ENDPOINTS.searchConsole}/sites/${encodeURIComponent(site)}/searchAnalytics/query`, { startDate: start, endDate: end, dimensions: ['page'], type: 'web', rowLimit: 25000, startRow });
    for (const x of r.rows ?? []) rows.push({ url: x.keys[0], clicks: x.clicks, impressions: x.impressions, ctr: Math.round(x.ctr * 10000) / 10000, position: Math.round(x.position * 10) / 10 });
    if ((r.rows?.length ?? 0) < 25000) break;
  }
  return rows;
}

/** Proprietà GA4 dell'account. Null se l'API di amministrazione non è attiva: l'ID si scrive a mano. */
export async function ga4Properties(token: string): Promise<{ id: string; name: string; account: string }[] | null> {
  try {
    const out: { id: string; name: string; account: string }[] = [];
    let pageToken = '';
    do {
      const r = await call<{ accountSummaries?: { displayName: string; propertySummaries?: { property: string; displayName: string }[] }[]; nextPageToken?: string }>(token, `${ENDPOINTS.analyticsAdmin}/accountSummaries?pageSize=200${pageToken ? `&pageToken=${pageToken}` : ''}`);
      for (const a of r.accountSummaries ?? []) for (const p of a.propertySummaries ?? []) out.push({ id: p.property.replace('properties/', ''), name: p.displayName, account: a.displayName });
      pageToken = r.nextPageToken ?? '';
    } while (pageToken);
    return out;
  } catch {
    return null;
  }
}

interface Report {
  rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[];
  rowCount?: number;
}

async function report(token: string, property: string, body: Record<string, unknown>): Promise<NonNullable<Report['rows']>> {
  const rows: NonNullable<Report['rows']> = [];
  for (let offset = 0; offset < 200000; offset += 50000) {
    const r = await call<Report>(token, `${ENDPOINTS.analyticsData}/properties/${encodeURIComponent(property.replace(/^properties\//, ''))}:runReport`, { ...body, limit: 50000, offset });
    rows.push(...(r.rows ?? []));
    if (rows.length >= (r.rowCount ?? 0) || !(r.rows?.length)) break;
  }
  return rows;
}

/**
 * Dati di GA4 per pagina: sessioni iniziate sulla pagina (tutti i canali e solo ricerca organica), eventi chiave
 * delle sessioni organiche, visualizzazioni.
 */
export async function ga4Pages(token: string, property: string, start: string, end: string): Promise<Ga4Row[]> {
  const dateRanges = [{ startDate: start, endDate: end }];
  const landing = [{ name: 'hostName' }, { name: 'landingPagePlusQueryString' }];
  const organic = { filter: { fieldName: 'sessionDefaultChannelGroup', stringFilter: { matchType: 'EXACT', value: 'Organic Search' } } };
  const [all, org, views] = await Promise.all([
    report(token, property, { dateRanges, dimensions: landing, metrics: [{ name: 'sessions' }] }),
    report(token, property, { dateRanges, dimensions: landing, metrics: [{ name: 'sessions' }, { name: 'keyEvents' }], dimensionFilter: organic }),
    report(token, property, { dateRanges, dimensions: [{ name: 'hostName' }, { name: 'pagePathPlusQueryString' }], metrics: [{ name: 'screenPageViews' }] }),
  ]);
  const map = new Map<string, Ga4Row>();
  const row = (host: string, path: string) => {
    const k = `${host}\n${path}`;
    let r = map.get(k);
    if (!r) map.set(k, (r = { host: host || null, path, sessions: 0, organic_sessions: 0, key_events: 0, views: 0 }));
    return r;
  };
  const num = (v: string | undefined) => Number(v ?? 0) || 0;
  for (const x of all) if (x.dimensionValues[1].value.startsWith('/')) row(x.dimensionValues[0].value, x.dimensionValues[1].value).sessions += num(x.metricValues[0]?.value);
  for (const x of org) {
    if (!x.dimensionValues[1].value.startsWith('/')) continue;
    const r = row(x.dimensionValues[0].value, x.dimensionValues[1].value);
    r.organic_sessions += num(x.metricValues[0]?.value);
    r.key_events += num(x.metricValues[1]?.value);
  }
  for (const x of views) if (x.dimensionValues[1].value.startsWith('/')) row(x.dimensionValues[0].value, x.dimensionValues[1].value).views += num(x.metricValues[0]?.value);
  return [...map.values()];
}
