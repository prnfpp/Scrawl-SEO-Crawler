import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { parseCsv } from 'scookie/engine';
import { stringify } from 'yaml';
import { loadConfigText } from '../src/config/load.js';
import { Crawler } from '../src/crawl/crawler.js';
import { RunStore } from '../src/crawl/store.js';
import { exportRun, loadPages, type ExportedPage } from '../src/report/export.js';
import { startFixture, type Fixture } from './fixtures/server.js';

let fx: Fixture;
before(async () => {
  fx = await startFixture(5);
});
after(async () => {
  await fx.close();
});

const dir = () => mkdtempSync(join(tmpdir(), 'scrawl-r-'));
const config = (rendering: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  loadConfigText(stringify({ cliente: 'Sito di prova', partenza: { dominio: `${fx.origin}/` }, cortesia: { pausaMs: 0, paralleli: 2 }, rendering: { attesaMs: 100, ...rendering }, ...extra }), '/tmp/prova.yaml');
const byPath = (pages: ExportedPage[]) => new Map(pages.map((p) => [new URL(p.url).pathname, p]));

test('rendering: ciò che esiste solo dopo JavaScript, link compresi, senza toccare gli analytics', async () => {
  fx.hits.clear();
  const d = dir();
  const state = await new Crawler(config(), d).run();
  assert.equal(state.status, 'completata');
  assert.equal(state.rendering?.mode, 'tutte');
  assert.match(state.user_agent, /Chrome\/[\d.]+ Safari\/537\.36 ScrawlSEO\//);
  assert.doesNotMatch(state.user_agent, /Headless/);
  const pages = byPath(loadPages(d));

  // applicazione JavaScript: tutto arriva dopo il rendering
  const spa = pages.get('/js/spa')!;
  assert.equal(spa.rendered, true);
  assert.equal(spa.raw_title, 'Caricamento');
  assert.equal(spa.title, 'Prodotto SPA');
  assert.deepEqual(spa.h1, ['Prodotto SPA']);
  assert.deepEqual(spa.raw_h1, []);
  assert.equal(spa.raw_canonical, null);
  assert.equal(spa.canonical, `${fx.origin}/js/spa`);
  assert.equal(spa.canonical_type, 'autoreferenziale');
  assert.deepEqual(spa.schema_types, ['Product', 'Offer']);
  assert.deepEqual(spa.raw_schema_types, []);
  assert.deepEqual(spa.schema_content_mismatch, []);
  assert.deepEqual(spa.diff_fields, ['title', 'canonical', 'h1', 'schema_types', 'content', 'links']);
  assert.deepEqual(spa.js_only_fields, ['canonical', 'h1', 'schema_types', 'content', 'links']);
  assert.equal(spa.content_raw_ratio, 0);
  assert.equal(spa.links_only_rendered, 2);
  assert.equal(spa.indexable, true);
  assert.ok((spa.word_count as number) > 90);

  // il link che esiste solo dopo JavaScript è stato seguito
  const only = pages.get('/solo-js')!;
  assert.equal(only.status, 200);
  assert.equal(only.found_on, `${fx.origin}/js/spa`);
  assert.equal(only.depth, 2);
  assert.equal(only.rendered, true, 'anche le pagine scoperte dal rendering vengono renderizzate');

  // analytics: gli invii non sono partiti
  assert.equal(fx.hits.get('/g/collect'), undefined);
  assert.equal(fx.hits.get('/matomo.php'), undefined);
  assert.equal(spa.tracker_requests_blocked, 2);
  assert.ok(state.notes.some((n) => /bloccate durante il rendering: 2/.test(n)));

  // pagina senza JavaScript: nessuna differenza
  const a = pages.get('/a')!;
  assert.equal(a.rendered, true);
  assert.deepEqual(a.diff_fields, []);
  assert.equal(a.content_raw_ratio, 1);

  // indicizzabilità
  assert.deepEqual([pages.get('/noindex')!.indexable, pages.get('/noindex')!.indexability_reason], [false, 'noindex nel meta robots']);
  assert.deepEqual([pages.get('/jsnoindex')!.indexable, pages.get('/jsnoindex')!.indexability_reason], [false, 'noindex nel meta robots, aggiunto da JavaScript']);
  assert.deepEqual(pages.get('/jsnoindex')!.raw_robots_meta, []);
  assert.deepEqual([pages.get('/canon')!.indexable, pages.get('/canon')!.canonical_type, pages.get('/canon')!.canonical], [false, 'altra-pagina', `${fx.origin}/a`]);
  assert.deepEqual([pages.get('/xrobots')!.indexable, pages.get('/xrobots')!.indexability_reason], [false, "noindex nell'intestazione X-Robots-Tag"]);
  assert.deepEqual([pages.get('/redir')!.indexable, pages.get('/redir')!.indexability_reason], [false, 'redirect (301)']);
  assert.equal(pages.get('/missing')!.indexability_reason, 'errore 404');
  assert.equal(pages.get('/privato/x')!.indexable, false);
  assert.equal(pages.get('/a')!.canonical_type, 'assente');

  // pagina prodotto: contenuto, immagini, dati strutturati
  const p = pages.get('/prodotto')!;
  assert.equal(p.title, 'Divano Milano');
  assert.equal(p.title_length, 13);
  assert.equal(p.description, 'Divano a tre posti.');
  assert.equal(p.lang, 'it-IT');
  assert.equal(p.hreflang_count, 1);
  assert.deepEqual(p.heading_issues, ['salto da H1 a H3']);
  assert.equal(p.images_count, 2);
  assert.equal(p.images_missing_alt, 1);
  assert.equal(p.images_missing_dimensions, 1);
  assert.ok((p.images_bytes as number) > 0);
  assert.equal(p.images_legacy_format, 1, 'PNG');
  assert.deepEqual(p.schema_types, ['Product']);
  assert.equal((p.schema_errors as string[]).length, 1);
  assert.deepEqual(p.schema_missing_required, ['Product: una tra offers, review, aggregateRating']);
  assert.equal((p.schema_content_mismatch as string[]).length, 1);
  assert.equal(p.outlinks_nofollow, 1);

  // file di dati: colonne e link con la provenienza
  exportRun(d);
  const csv = parseCsv(readFileSync(join(d, 'pages.csv'), 'utf8'), ';');
  const col = (name: string) => csv[0].indexOf(name);
  const spaRow = csv.find((r) => r[0].endsWith('/js/spa'))!;
  assert.equal(spaRow[col('title')], 'Prodotto SPA');
  assert.equal(spaRow[col('js_only_fields')], 'canonical | h1 | schema_types | content | links');
  assert.equal(spaRow[col('rendered')], 'true');
  const links = parseCsv(readFileSync(join(d, 'links.csv'), 'utf8'), ';');
  const lc = (name: string) => links[0].indexOf(name);
  const jsLink = links.find((r) => r[lc('target_url')].endsWith('/solo-js'))!;
  assert.deepEqual([jsLink[lc('in_raw')], jsLink[lc('in_rendered')], jsLink[lc('placement')], jsLink[lc('target_status')]], ['false', 'true', 'main', '200']);
  const footer = links.find((r) => r[lc('source_url')].endsWith('/prodotto') && r[lc('target_url')].endsWith('/b'))!;
  assert.deepEqual([footer[lc('in_raw')], footer[lc('in_rendered')], footer[lc('placement')]], ['true', 'true', 'footer']);
  const manifest = JSON.parse(readFileSync(join(d, 'manifest.json'), 'utf8'));
  assert.equal(manifest.rendering.mode, 'tutte');
  assert.equal(manifest.counts.rendered, manifest.rendering.rendered);
});

test('sito sopra la soglia: campione per modello e pagine con sorgente sospetto', async () => {
  const d = dir();
  const state = await new Crawler(config({ soglia: 3, perModello: 1 }), d).run();
  assert.equal(state.rendering?.mode, 'selezione');
  const pages = byPath(loadPages(d));
  const rendered = [...pages.values()].filter((p) => p.rendered);
  const eligible = [...pages.values()].filter((p) => p.raw_word_count !== null);
  assert.ok(rendered.length > 0 && rendered.length < eligible.length, `renderizzate ${rendered.length} su ${eligible.length}`);
  assert.equal(pages.get('/')!.render_reason, 'campione del modello di pagina');
  assert.match(String(pages.get('/js/spa')!.render_reason), /^(campione del modello di pagina|sorgente sospetto)/);
  assert.equal(pages.get('/js/spa')!.rendered, true);
  const skipped = eligible.find((p) => !p.rendered)!;
  assert.match(String(skipped.render_reason), /^non renderizzata: il campione/);
  assert.equal(skipped.title, skipped.raw_title, 'senza rendering vale il sorgente');
  assert.ok(state.limits.some((l) => /sopra la soglia di 3 pagine/.test(l)));
});

test('rendering: pausa e ripresa senza ripetere le pagine già fatte', async () => {
  const d = dir();
  const first: Crawler = new Crawler(config(), d, { progressIntervalMs: 0, onProgress: (p) => p.rendered >= 3 && first.pause() });
  const s1 = await first.run();
  assert.equal(s1.status, 'in-pausa');
  const before = RunStore.readRender(d).length;
  assert.ok(before >= 3);
  const s2 = await new Crawler(loadConfigText(Crawler.savedConfig(d)!, join(d, 'config.yaml')), d).run();
  assert.equal(s2.status, 'completata');
  const renders = RunStore.readRender(d);
  assert.equal(new Set(renders.map((r) => r.url)).size, renders.length, 'nessuna pagina renderizzata due volte');
  const pages = loadPages(d);
  assert.equal(pages.filter((p) => p.raw_word_count !== null && !p.rendered).length, 0);
  assert.ok(pages.some((p) => p.url.endsWith('/solo-js')));
});
