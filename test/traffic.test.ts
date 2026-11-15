import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { stringify } from 'yaml';
import { loadConfigText } from '../src/config/load.js';
import { Crawler } from '../src/crawl/crawler.js';
import { ga4Pages, gscPages, gscSites } from '../src/google/api.js';
import { accessToken, authUrl, ENDPOINTS, exchangeCode, googleStatus, parseCredentials, pkce, saveCredentials } from '../src/google/auth.js';
import { fetchTraffic, parseGa4Csv, parseGscCsv, parseNumber, periodOf, type Traffic } from '../src/join/traffic.js';
import { siteSummary } from '../src/analyze/summary.js';
import { exportRun, loadRun } from '../src/report/export.js';
import { parseCsv } from '../src/scookie/index.js';
import { startUi } from '../src/ui/server.js';
import { zip } from '../src/util/zip.js';
import { startFixture, type Fixture } from './fixtures/server.js';

let fx: Fixture;
before(async () => {
  fx = await startFixture(2);
});
after(async () => {
  await fx.close();
});
const dir = () => mkdtempSync(join(tmpdir(), 'scrawl-t-'));

test('numeri e file esportati da Search Console e GA4', () => {
  assert.equal(parseNumber('1.234', true), 1234);
  assert.equal(parseNumber('1,234', true), 1234);
  assert.equal(parseNumber('3,5%'), 3.5);
  assert.equal(parseNumber('12.4'), 12.4);
  assert.equal(parseNumber('1.234,56'), 1234.56);
  assert.equal(parseNumber('1,234.56'), 1234.56);
  assert.equal(parseNumber(''), 0);

  const gsc = parseGscCsv('﻿Pagine più visitate,Clic,Impressioni,CTR,Posizione\nhttps://x.it/a,"1.234","20.000","6,17%","4,3"\nhttps://x.it/b,0,15,0%,38.2\n');
  assert.deepEqual(gsc, [{ url: 'https://x.it/a', clicks: 1234, impressions: 20000, ctr: 0.0617, position: 4.3 }, { url: 'https://x.it/b', clicks: 0, impressions: 15, ctr: 0, position: 38.2 }]);
  assert.equal(parseGscCsv('Top pages;Clicks;Impressions;CTR;Position\nhttps://x.it/a;5;100;5%;2.1\n')[0].clicks, 5);
  assert.throws(() => parseGscCsv('Query,Clic\nscarpe,3\n'), /Pagine\.csv/);

  const ga4 = parseGa4Csv('# ----------------------------------------\n# Pagina di destinazione\n# Data di inizio: 20260801\n#\nPagina di destinazione,Sessioni,Sessioni organiche,Eventi chiave\n/a?utm_source=x,"1.200",300,12\n(not set),40,0,0\n/b,10,2,0\n');
  assert.deepEqual(ga4, [{ host: null, path: '/a?utm_source=x', sessions: 1200, organic_sessions: 300, key_events: 12, views: 0 }, { host: null, path: '/b', sessions: 10, organic_sessions: 2, key_events: 0, views: 0 }]);
  const views = parseGa4Csv('Page path and screen class,Views,Sessions\n/a,500,200\n');
  assert.deepEqual(views[0], { host: null, path: '/a', sessions: 0, organic_sessions: 0, key_events: 0, views: 500 });
  assert.throws(() => parseGa4Csv('Città,Utenti\nRoma,3\n'), /GA4 per pagina/);
  assert.deepEqual(periodOf(28, new Date('2026-11-15T10:00:00Z')), { start: '2026-10-16', end: '2026-11-12' });
});

test('scansione con i dati di traffico: indirizzi di Search Console in coda, problemi pesati sul traffico', async () => {
  const d = dir();
  const traffic: Traffic = {
    fetched_at: new Date().toISOString(),
    period: { start: '2026-08-01', end: '2026-10-31' },
    gsc: {
      source: 'api',
      property: 'sc-domain:prova',
      rows: [
        { url: `${fx.origin}/`, clicks: 100, impressions: 2000, ctr: 0.05, position: 3 },
        { url: `${fx.origin}/noindex`, clicks: 40, impressions: 900, ctr: 0.044, position: 6 },
        { url: `${fx.origin}/redir`, clicks: 7, impressions: 300, ctr: 0.023, position: 9 },
        { url: `${fx.origin}/a#sezione`, clicks: 3, impressions: 50, ctr: 0.06, position: 4 },
        { url: `${fx.origin}/a`, clicks: 2, impressions: 50, ctr: 0.04, position: 8 },
        { url: `${fx.origin}/solo-js`, clicks: 9, impressions: 120, ctr: 0.075, position: 5 },
        { url: `${fx.origin}/vecchia-pagina`, clicks: 25, impressions: 400, ctr: 0.06, position: 7 },
        { url: 'https://altro-sito.example/x', clicks: 1, impressions: 10, ctr: 0.1, position: 1 },
      ],
    },
    ga4: { source: 'api', property: '123', rows: [{ host: new URL(fx.origin).host, path: '/?gclid=abc', sessions: 500, organic_sessions: 220, key_events: 9, views: 0 }, { host: new URL(fx.origin).host, path: '/', sessions: 0, organic_sessions: 0, key_events: 0, views: 800 }, { host: 'altro.example', path: '/b', sessions: 99, organic_sessions: 99, key_events: 0, views: 0 }] },
  };
  const cfg = loadConfigText(stringify({ cliente: 'Prova', partenza: { dominio: `${fx.origin}/` }, cortesia: { pausaMs: 0, paralleli: 3 }, rendering: { attivo: false }, controlli: { sito: false, link: false }, traffico: { gsc: 'sc-domain:prova', ga4: '123' } }), '/tmp/p.yaml');
  const state = await new Crawler(cfg, d, { traffic: async () => traffic }).run();
  assert.equal(state.status, 'completata');
  const { pages, site } = loadRun(d);
  const get = (path: string) => pages.find((p) => new URL(p.url).pathname === path) as unknown as Record<string, any>;

  // indirizzi noti solo a Search Console: visitati, e orfani se nessun link li raggiunge
  assert.equal(get('/solo-js').source, 'search-console');
  assert.equal(get('/solo-js').orphan, true);
  assert.equal(get('/vecchia-pagina').status, 404);
  assert.equal(get('/vecchia-pagina').traffic_issue, 'riceve 400 impression e 25 clic ma non è indicizzabile: errore 404');

  // somma del frammento sulla pagina, CTR ricalcolato, posizione pesata sulle impression
  assert.deepEqual([get('/a').gsc_clicks, get('/a').gsc_impressions, get('/a').gsc_ctr, get('/a').gsc_position], [5, 100, 0.05, 6]);
  assert.deepEqual([get('/').ga4_sessions, get('/').ga4_organic_sessions, get('/').ga4_key_events, get('/').ga4_views], [500, 220, 9, 800]);
  assert.deepEqual([get('/b').gsc_clicks, get('/b').gsc_impressions, get('/b').ga4_sessions], [0, 0, 0], 'visitata ma assente dai dati: zero, non vuoto');
  assert.equal(get('/b').traffic_issue, 'indicizzabile ma senza impression nel periodo');
  assert.match(get('/noindex').traffic_issue, /^riceve 900 impression e 40 clic ma non è indicizzabile: noindex/);
  assert.match(get('/redir').traffic_issue, /redirect \(301\)/);
  assert.equal(get('/').traffic_issue, null);

  const t = site.traffic!;
  assert.equal(t.available, true);
  assert.deepEqual([t.with_traffic_not_indexable.count, t.with_traffic_not_indexable.clicks], [3, 72]);
  assert.equal(t.with_traffic_not_indexable.examples[0].url, `${fx.origin}/noindex`, 'in ordine di clic');
  assert.deepEqual(t.in_gsc_not_crawled.examples.map((e) => e.url), ['https://altro-sito.example/x']);
  assert.equal(t.gsc!.clicks, 187);
  assert.equal(t.ga4!.matched_paths, 1);
  assert.ok(t.indexable_without_impressions.count > 5);
  const items = siteSummary(site).filter((i) => i.area === 'Traffico');
  assert.equal(items.find((i) => i.title.startsWith('Pagine con traffico'))!.level, 'problema');
  assert.match(items[0].text, /coprono il 99% dei clic/);

  exportRun(d);
  const csv = parseCsv(readFileSync(join(d, 'pages.csv'), 'utf8'), ';');
  const row = csv.find((r) => r[0] === `${fx.origin}/noindex`)!;
  assert.equal(row[csv[0].indexOf('gsc_clicks')], '40');
  assert.equal(JSON.parse(readFileSync(join(d, 'manifest.json'), 'utf8')).traffic.gsc.property, 'sc-domain:prova');

  // senza dati: colonne vuote e controllo "non verificato"
  const d2 = dir();
  await new Crawler(loadConfigText(stringify({ cliente: 'Prova', partenza: { url: [`${fx.origin}/a`] }, perimetro: { seguiLink: false }, cortesia: { pausaMs: 0 }, rendering: { attivo: false }, controlli: { sito: false, link: false }, traffico: { gsc: 'sc-domain:prova' } }), '/tmp/p.yaml'), d2).run();
  const r2 = loadRun(d2);
  assert.equal((r2.pages[0] as any).gsc_clicks, null);
  assert.equal(siteSummary(r2.site)[0].level, 'non-verificato');
  assert.ok(JSON.parse(readFileSync(join(d2, 'stato.json'), 'utf8')).notes.some((n: string) => /Google non è collegato/.test(n)));
});

test('collegamento a Google e lettura delle API (server finto)', async () => {
  const calls: { path: string; body: any; auth?: string }[] = [];
  let tokens = 0;
  const srv = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0];
      const body = req.headers['content-type']?.includes('json') ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw));
      calls.push({ path, body, auth: req.headers.authorization });
      const json = (o: unknown, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      if (path === '/token') {
        tokens++;
        if (body.grant_type === 'authorization_code') return body.code === 'buono' ? json({ access_token: 'acc1', refresh_token: 'ref1', expires_in: 1, scope: 'https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly' }) : json({ error: 'invalid_grant' }, 400);
        return json({ access_token: `acc${tokens}`, expires_in: 3600 });
      }
      if (path === '/gsc/sites') return json({ siteEntry: [{ siteUrl: 'sc-domain:x.it', permissionLevel: 'siteOwner' }, { siteUrl: 'https://non-mio.it/', permissionLevel: 'siteUnverifiedUser' }] });
      if (path.endsWith('/searchAnalytics/query')) return json({ rows: body.startRow === 0 ? [{ keys: ['https://x.it/a'], clicks: 5, impressions: 100, ctr: 0.05, position: 3.26 }] : [] });
      if (path.endsWith(':runReport')) {
        const dim = body.dimensions[1].name;
        const organic = !!body.dimensionFilter;
        if (dim === 'pagePathPlusQueryString') return json({ rowCount: 1, rows: [{ dimensionValues: [{ value: 'x.it' }, { value: '/a' }], metricValues: [{ value: '900' }] }] });
        return json({ rowCount: 2, rows: [{ dimensionValues: [{ value: 'x.it' }, { value: '/a' }], metricValues: organic ? [{ value: '30' }, { value: '4' }] : [{ value: '120' }] }, { dimensionValues: [{ value: 'x.it' }, { value: '(not set)' }], metricValues: [{ value: '9' }, { value: '0' }] }] });
      }
      json({ error: { message: 'Google Analytics Admin API has not been used in project 1 before or it is disabled. Enable it.' } }, 403);
    });
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', () => ok()));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const saved = { ...ENDPOINTS };
  Object.assign(ENDPOINTS, { token: `${base}/token`, searchConsole: `${base}/gsc`, analyticsData: `${base}/ga4`, analyticsAdmin: `${base}/admin` });
  try {
    const g = dir();
    assert.throws(() => parseCredentials('{"installed":{}}'), /App desktop/);
    saveCredentials(g, JSON.stringify({ installed: { client_id: 'id.apps.googleusercontent.com', client_secret: 'segreto' } }));
    assert.deepEqual(googleStatus(g), { credentials: true, connected: false });
    const p = pkce();
    const u = new URL(authUrl({ client_id: 'id', client_secret: 's' }, 'http://127.0.0.1:4788/api/google/callback', 'stato', p.challenge));
    assert.equal(u.searchParams.get('access_type'), 'offline');
    assert.match(u.searchParams.get('scope')!, /webmasters\.readonly .*analytics\.readonly/);
    assert.doesNotMatch(u.searchParams.get('scope')!, /auth\/webmasters( |$)/, 'solo lettura');

    await assert.rejects(exchangeCode(g, 'cattivo', 'http://127.0.0.1/cb', p.verifier), /scaduto o è stato revocato/);
    await exchangeCode(g, 'buono', 'http://127.0.0.1/cb', p.verifier);
    assert.equal(googleStatus(g).connected, true);
    assert.equal(calls.at(-1)!.body.code_verifier, p.verifier);

    // token scaduto (durava un secondo): rinnovato da solo
    const token = await accessToken(g);
    assert.notEqual(token, 'acc1');
    assert.equal(await accessToken(g), token, 'il token rinnovato viene riusato');

    assert.deepEqual(await gscSites(token), [{ siteUrl: 'sc-domain:x.it', permissionLevel: 'siteOwner' }]);
    assert.deepEqual(await gscPages(token, 'sc-domain:x.it', '2026-08-01', '2026-10-31'), [{ url: 'https://x.it/a', clicks: 5, impressions: 100, ctr: 0.05, position: 3.3 }]);
    assert.ok(calls.some((c) => c.path === '/gsc/sites/sc-domain%3Ax.it/searchAnalytics/query' && c.auth === `Bearer ${token}`));
    assert.deepEqual(await ga4Pages(token, '123', '2026-08-01', '2026-10-31'), [{ host: 'x.it', path: '/a', sessions: 120, organic_sessions: 30, key_events: 4, views: 900 }]);
    const t = await fetchTraffic(g, { gsc: 'sc-domain:x.it', ga4: '123', giorni: 28 });
    assert.equal(t.gsc!.rows.length, 1);
    assert.equal(t.ga4!.rows[0].organic_sessions, 30);
    assert.match(t.period!.start, /^\d{4}-\d{2}-\d{2}$/);

    // interfaccia: stato di Google, elenco GA4 non disponibile se l'API di amministrazione è spenta
    const root = dir();
    const ui = await startUi({ port: 0, root });
    try {
      const call = async (path: string, data?: unknown) => {
        const res = await fetch(ui.url + path, data === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
        return { status: res.status, json: (await res.json().catch(() => null)) as any, res };
      };
      assert.deepEqual((await call('/api/google')).json, { credentials: false, connected: false, sites: [], properties: null });
      assert.equal((await call('/api/google/collega', {})).status, 400);
      assert.equal((await call('/api/google/credenziali', { text: 'non json' })).status, 400);
      await call('/api/google/credenziali', { text: JSON.stringify({ installed: { client_id: 'id', client_secret: 's' } }) });
      const link = await call('/api/google/collega', {});
      const state = new URL(link.json.url).searchParams.get('state');
      assert.match(await (await fetch(`${ui.url}/api/google/callback?code=buono&state=sbagliato`)).text(), /non valido/);
      const again = await call('/api/google/collega', {});
      assert.notEqual(new URL(again.json.url).searchParams.get('state'), state);
      assert.match(await (await fetch(`${ui.url}/api/google/callback?code=buono&state=${new URL(again.json.url).searchParams.get('state')}`)).text(), /Google è collegato/);
      const st = (await call('/api/google')).json;
      assert.deepEqual([st.connected, st.sites, st.properties], [true, ['sc-domain:x.it'], null]);

      // scansione, poi dati aggiunti dopo: da un file e dalle API; zip dei risultati
      await call('/api/progetti', { config: { cliente: 'Prova', partenza: { url: [`${fx.origin}/a`, `${fx.origin}/noindex`] }, perimetro: { seguiLink: false }, cortesia: { pausaMs: 0, userAgent: 'MioUserAgent/1.0' }, rendering: { attivo: false }, controlli: { sito: false, link: false } } });
      const run = await call('/api/scansioni', { project: 'Prova' });
      for (let i = 0; i < 200 && (await call('/api/stato')).json.active; i++) await new Promise((r) => setTimeout(r, 50));
      assert.equal((await call(`/api/scansioni/${run.json.id}/importa`, { tipo: 'gsc', text: 'Città,Clic\nRoma,1' })).status, 400);
      const imp = await call(`/api/scansioni/${run.json.id}/importa`, { tipo: 'gsc', text: `Pagine più visitate,Clic,Impressioni,CTR,Posizione\n${fx.origin}/noindex,12,340,"3,5%","7,1"\n` });
      assert.deepEqual(imp.json, { ok: true, rows: 1 });
      const rows = await call(`/api/scansioni/${run.json.id}/pagine?filtro=trafficononindex&ordine=clic`);
      assert.deepEqual([rows.json.traffic, rows.json.matching, rows.json.rows[0].gsc_clicks], [true, 1, 12]);
      assert.equal(rows.json.run.status, 'completata');
      assert.equal((await call(`/api/scansioni/${run.json.id}/traffico`, {})).status, 400, 'il progetto non indica proprietà');
      assert.equal((await call(`/api/scansioni/${run.json.id}/traffico`, { ga4: '123', giorni: 28 })).status, 200);
      const sito = await call(`/api/scansioni/${run.json.id}/sito`);
      assert.match(sito.json.items[0].text, /Search Console .* e GA4/);

      const z = await fetch(`${ui.url}/api/scansioni/${run.json.id}/zip`);
      assert.equal(z.headers.get('content-type'), 'application/zip');
      const file = join(root, 'out.zip');
      writeFileSync(file, Buffer.from(await z.arrayBuffer()));
      const listing = execFileSync('unzip', ['-l', file], { encoding: 'utf8' });
      for (const n of ['pages.csv', 'pages.json', 'links.csv', 'site.json', 'manifest.json', 'config.yaml']) assert.ok(listing.includes(n), n);
      assert.match(execFileSync('unzip', ['-p', file, 'manifest.json'], { encoding: 'utf8' }), /"user_agent": "MioUserAgent\/1\.0"/);
    } finally {
      await ui.close();
    }
  } finally {
    Object.assign(ENDPOINTS, saved);
    await new Promise<void>((ok) => srv.close(() => ok()));
  }
});

test('zip: file letti correttamente da unzip, nomi accentati compresi', () => {
  const d = dir();
  const file = join(d, 'a.zip');
  writeFileSync(file, zip([{ name: 'uno.txt', data: Buffer.from('ciao\n') }, { name: 'perché.csv', data: Buffer.from('a;b\n'.repeat(2000)) }]));
  assert.equal(execFileSync('unzip', ['-p', file, 'uno.txt'], { encoding: 'utf8' }), 'ciao\n');
  assert.match(execFileSync('unzip', ['-t', file], { encoding: 'utf8' }), /No errors detected/);
});
