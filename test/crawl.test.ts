import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { stringify } from 'yaml';
import { loadConfigText } from '../src/config/load.js';
import { Crawler } from '../src/crawl/crawler.js';
import { RunStore, type PageRow } from '../src/crawl/store.js';
import { exportRun, loadPages, PAGE_COLUMNS } from '../src/report/export.js';
import { startUi } from '../src/ui/server.js';
import { startFixture, type Fixture } from './fixtures/server.js';

/** Indirizzi del sito di prova raggiungibili senza JavaScript. */
const BASE_PATHS = ['/', '/a', '/b', '/blog/post-1', '/blog/post-2', '/c', '/deep/1', '/deep/2', '/deep/3', '/loop1', '/loop2', '/missing', '/orfana', '/privato/x', '/redir', '/redir2', '/js/spa', '/noindex', '/canon', '/jsnoindex', '/prodotto', '/xrobots'];

let fx: Fixture;
before(async () => {
  fx = await startFixture(15);
});
after(async () => {
  await fx.close();
});

const dir = () => mkdtempSync(join(tmpdir(), 'scrawl-'));
const config = (extra: Record<string, unknown> = {}) =>
  loadConfigText(stringify({ cliente: 'Sito di prova', partenza: { dominio: `${fx.origin}/` }, cortesia: { pausaMs: 0, paralleli: 3 }, rendering: { attivo: false }, ...extra }), '/tmp/prova.yaml');
const byPath = (rows: PageRow[]) => new Map(rows.map((r) => [new URL(r.url).pathname + new URL(r.url).search, r]));

test('scansione completa: perimetro, redirect, robots, sitemap, profondità', async () => {
  fx.hits.clear();
  const d = dir();
  const state = await new Crawler(config(), d).run();
  assert.equal(state.status, 'completata');
  const rows = byPath(RunStore.readPages(d));

  assert.deepEqual([...rows.keys()].sort(), [...BASE_PATHS].sort());
  assert.equal(rows.get('/')!.depth, 0);
  assert.equal(rows.get('/a')!.depth, 1);
  assert.equal(rows.get('/c')!.depth, 2);
  assert.equal(rows.get('/deep/3')!.depth, 5);
  assert.equal(rows.get('/missing')!.status, 404);

  // parametro di tracciamento e frammento non creano un secondo indirizzo
  assert.ok(!rows.has('/a?utm_source=newsletter'));

  // catena di redirect: una riga per passaggio, senza richieste ripetute
  const redir = rows.get('/redir')!;
  assert.equal(redir.status, 301);
  assert.equal(redir.redirect_type, 'catena');
  assert.equal(redir.final_url, `${fx.origin}/a`);
  assert.equal(redir.final_status, 200);
  assert.deepEqual(redir.redirect_chain.map((h) => h.status), [301, 302, 200]);
  assert.equal(rows.get('/redir2')!.redirect_type, 'singolo');
  assert.equal(fx.hits.get('/redir2'), 1);

  // loop
  assert.equal(rows.get('/loop1')!.redirect_type, 'loop');
  assert.match(rows.get('/loop1')!.error ?? '', /loop/);

  // robots.txt: pagina vietata registrata ma non richiesta
  const priv = rows.get('/privato/x')!;
  assert.equal(priv.fetched, false);
  assert.equal(priv.robots_txt_blocked, true);
  assert.equal(priv.robots_txt_rule, 'Disallow: /privato/');
  assert.equal(fx.hits.get('/privato/x'), undefined);

  // pagina solo in sitemap: nessuna profondità, e i suoi link restano "non raggiungibili dalla partenza"
  assert.equal(rows.get('/orfana')!.depth, null);
  assert.equal(rows.get('/orfana')!.in_sitemap, true);
  assert.equal(rows.get('/orfana')!.source, 'sitemap');
  assert.equal(rows.get('/loop1')!.depth, null);
  assert.equal(rows.get('/b')!.in_sitemap, false);

  // nessuna pagina richiesta due volte
  for (const [path, n] of fx.hits) if (!['/robots.txt', '/sitemap.xml', '/loop1', '/loop2', '/a'].includes(path)) assert.equal(n, 1, `${path} richiesta ${n} volte`);

  // fuori perimetro: contati e dichiarati
  assert.equal(state.excluded['altro dominio'].count, 1);
  assert.equal(state.excluded['file che non è una pagina'].count, 1);
  assert.ok(state.limits.some((l) => /Rendering con browser disattivato/.test(l)));
  assert.ok(state.limits.some((l) => /robots\.txt/.test(l)));

  // link
  const links = RunStore.readLinks(d);
  const ext = links.find((l) => l.target_url === 'https://example.org/')!;
  assert.equal(ext.is_internal, false);
  assert.equal(links.find((l) => l.source_url === `${fx.origin}/` && l.target_url === `${fx.origin}/a`)!.anchor, 'vai a /a');

  // file di dati
  exportRun(d);
  const csv = readFileSync(join(d, 'pages.csv'), 'utf8');
  assert.equal(csv.replace(/^﻿/, '').split(/\r?\n/)[0].replace(/"/g, ''), PAGE_COLUMNS.join(csv.includes(';') && !csv.split('\n')[0].includes(',') ? ';' : ','));
  const manifest = JSON.parse(readFileSync(join(d, 'manifest.json'), 'utf8'));
  assert.equal(manifest.counts.pages, BASE_PATHS.length);
  assert.ok(manifest.not_verified.length > 0);
  const pages = loadPages(d);
  assert.equal(pages.find((p) => p.url === `${fx.origin}/`)!.template, 'home');
  assert.equal(pages.find((p) => p.url.endsWith('/blog/post-1'))!.template, 'blog');
});

test('pausa e ripresa: stesso risultato, nessuna pagina ripetuta', async () => {
  const full = dir();
  await new Crawler(config(), full).run();
  const expected = RunStore.readPages(full).map((r) => r.url).sort();

  fx.hits.clear();
  const d = dir();
  const first: Crawler = new Crawler(config({ cortesia: { pausaMs: 20, paralleli: 1 } }), d, { progressIntervalMs: 0, onProgress: (p) => p.done >= 4 && first.pause() });
  const s1 = await first.run();
  assert.equal(s1.status, 'in-pausa');
  const partial = RunStore.readPages(d).length;
  assert.ok(partial >= 4 && partial < expected.length, `pagine prima della pausa: ${partial}`);

  // la ripresa usa la configurazione salvata nella cartella
  const saved = Crawler.savedConfig(d)!;
  const s2 = await new Crawler(loadConfigText(saved, join(d, 'config.yaml')), d).run();
  assert.equal(s2.status, 'completata');
  const rows = RunStore.readPages(d);
  assert.deepEqual(rows.map((r) => r.url).sort(), expected);
  assert.equal(new Set(rows.map((r) => r.url)).size, rows.length, 'nessuna riga doppia');
  for (const [path, n] of fx.hits) if (!['/robots.txt', '/sitemap.xml', '/loop1', '/loop2', '/a'].includes(path)) assert.equal(n, 1, `${path} richiesta ${n} volte`);
  assert.ok(s2.elapsed_s >= s1.elapsed_s);
});

test('ripresa dopo una chiusura improvvisa: riga scritta a metà scartata', async () => {
  const d = dir();
  const c: Crawler = new Crawler(config({ cortesia: { pausaMs: 20, paralleli: 1 } }), d, { progressIntervalMs: 0, onProgress: (p) => p.done >= 3 && c.pause() });
  await c.run();
  const { appendFileSync } = await import('node:fs');
  appendFileSync(join(d, 'pagine.jsonl'), '{"url":"http://127.0.0.1/tronc');
  const s = await new Crawler(loadConfigText(Crawler.savedConfig(d)!, join(d, 'config.yaml')), d).run();
  assert.equal(s.status, 'completata');
  assert.equal(loadPages(d).length, BASE_PATHS.length);
});

test('limiti: pagine e profondità, con ciò che resta fuori dichiarato', async () => {
  const d = dir();
  const s = await new Crawler(config({ perimetro: { maxPagine: 5 }, partenza: { dominio: `${fx.origin}/`, sitemapAutomatica: false } }), d).run();
  assert.equal(s.status, 'completata');
  const n = RunStore.readPages(d).filter((r) => r.fetched).length;
  assert.ok(n >= 5 && n <= 8, `il limite ferma la scansione (più le richieste già in corso): ${n}`);
  assert.ok(s.not_reached.count > 0);
  assert.ok(s.limits.some((l) => /limite di 5 pagine/.test(l)));

  const d2 = dir();
  const s2 = await new Crawler(config({ perimetro: { maxProfondita: 1 }, partenza: { dominio: `${fx.origin}/`, sitemapAutomatica: false } }), d2).run();
  const rows = RunStore.readPages(d2);
  assert.ok(rows.every((r) => (r.depth ?? 0) <= 1));
  assert.ok(!rows.some((r) => r.url.endsWith('/c')));
  assert.ok(s2.excluded['oltre 1 livelli di profondità'].count > 0);
});

test('robots.txt ignorato in modo esplicito: la pagina vietata viene visitata e il limite lo dichiara', async () => {
  const d = dir();
  const s = await new Crawler(config({ cortesia: { pausaMs: 0, rispettaRobots: false } }), d).run();
  const priv = RunStore.readPages(d).find((r) => r.url.endsWith('/privato/x'))!;
  assert.equal(priv.fetched, true);
  assert.equal(priv.status, 200);
  assert.equal(priv.robots_txt_blocked, true, 'il dato "vietata da robots.txt" resta');
  assert.ok(s.limits.some((l) => /ignorato per scelta esplicita/.test(l)));
});

test('modalità a campione: poche pagine per tipologia, il resto dichiarato', async () => {
  const d = dir();
  const s = await new Crawler(config({ modalita: 'campione', campionamento: { perTipo: 1, maxPagine: 4 } }), d).run();
  const rows = RunStore.readPages(d);
  assert.equal(s.status, 'completata');
  assert.ok(rows.some((r) => r.depth === 0));
  assert.ok(rows.filter((r) => r.source !== 'redirect').length <= 4, `righe: ${rows.map((r) => r.url).join(', ')}`);
  assert.ok(s.sample && s.sample.candidates > s.sample.picked);
  assert.ok(s.limits.some((l) => /a campione/.test(l)));
});

test('solo sitemap come punto di partenza', async () => {
  const d = dir();
  const s = await new Crawler(config({ partenza: { sitemap: [`${fx.origin}/sitemap.xml`] }, perimetro: { seguiLink: false } }), d).run();
  assert.equal(s.status, 'completata');
  assert.deepEqual(RunStore.readPages(d).map((r) => new URL(r.url).pathname).sort(), ['/', '/a', '/missing', '/orfana']);
});

test('interfaccia: progetto, avvio, avanzamento, risultati', async () => {
  const root = dir();
  const ui = await startUi({ port: 0, root });
  try {
    const call = async (path: string, data?: unknown) => {
      const res = await fetch(ui.url + path, data === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
      return { status: res.status, json: (await res.json()) as any };
    };
    assert.match(await (await fetch(ui.url + '/')).text(), /<title>Scrawl<\/title>/);
    const bad = await call('/api/progetti', { config: { cliente: 'X', partenza: {} } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /punto di partenza/);
    const saved = await call('/api/progetti', { config: { cliente: 'Sito di prova', partenza: { dominio: `${fx.origin}/` }, cortesia: { pausaMs: 0 }, rendering: { attivo: false } } });
    assert.equal(saved.json.name, 'Sito-di-prova');
    assert.ok(existsSync(join(root, 'clienti', 'Sito-di-prova.yaml')));
    const run = await call('/api/scansioni', { project: 'Sito-di-prova' });
    assert.equal(run.status, 200);
    assert.equal((await call('/api/scansioni', { project: 'Sito-di-prova' })).status, 409, 'una scansione alla volta');
    for (let i = 0; i < 200; i++) {
      if (!(await call('/api/stato')).json.active) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const pages = await call(`/api/scansioni/${run.json.id}/pagine?filtro=client`);
    assert.equal(pages.json.total, BASE_PATHS.length);
    assert.equal(pages.json.matching, 1);
    assert.equal(pages.json.run.status, 'completata');
    assert.equal(pages.json.run.exported, true);
    const projects = await call('/api/progetti');
    assert.equal(projects.json[0].lastRun.id, run.json.id);
    // richieste da un altro sito aperto nel browser: rifiutate
    assert.equal((await fetch(ui.url + '/api/stato', { headers: { origin: 'https://altro.example' } })).status, 403);
    assert.equal((await call('/api/scansioni/..%2F..%2Fetc/pagine')).status >= 400, true);
  } finally {
    await ui.close();
  }
});
