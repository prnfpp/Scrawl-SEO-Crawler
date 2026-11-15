import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { stringify } from 'yaml';
import { analyzeSite, type AnalyzablePage } from '../src/analyze/site.js';
import { loadConfigText } from '../src/config/load.js';
import { Crawler } from '../src/crawl/crawler.js';
import { parseRobots } from '../src/crawl/robots.js';
import { RunStore } from '../src/crawl/store.js';
import { simhash } from '../src/extract/content.js';
import { exportRun, loadRun } from '../src/report/export.js';
import { aiAccess, aiCrawlers } from '../src/site/checks.js';
import { startFixture, type Fixture } from './fixtures/server.js';

let fx: Fixture;
before(async () => {
  fx = await startFixture(5);
});
after(async () => {
  await fx.close();
});

const dir = () => mkdtempSync(join(tmpdir(), 'scrawl-s-'));
const config = (extra: Record<string, unknown> = {}) => loadConfigText(stringify({ cliente: 'Sito di prova', partenza: { dominio: `${fx.origin}/` }, cortesia: { pausaMs: 0, paralleli: 3 }, rendering: { attivo: false }, ...extra }), '/tmp/prova.yaml');

test('controlli di sito, grafo dei link, duplicati', async () => {
  const d = dir();
  const state = await new Crawler(config(), d).run();
  assert.equal(state.status, 'completata');
  const { pages, site } = loadRun(d);
  const get = (path: string) => pages.find((p) => new URL(p.url).pathname + new URL(p.url).search === path) as unknown as Record<string, any>;

  // grafo: link in entrata, profondità ricalcolata, orfane
  assert.equal(get('/a').inlinks, 2, 'la home e /prodotto');
  assert.equal(get('/c').depth, 2);
  assert.equal(get('/redir2').depth, 1, 'un redirect non costa un clic');
  assert.equal(get('/orfana').orphan, true);
  assert.equal(get('/orfana').depth, null);
  assert.equal(get('/a').orphan, false);
  assert.deepEqual(site.orphans.examples, [`${fx.origin}/orfana`]);

  // link verso redirect, errori, file rotti, esterni rotti
  const home = get('/');
  assert.equal(home.outlinks_to_redirect, 1);
  assert.equal(home.outlinks_to_error, 2, '/missing e /file.pdf');
  assert.equal(home.outlinks_external_broken, 1);
  assert.equal(site.links.external_checked, 1);
  assert.ok(site.links.internal_to_error.targets.some((t) => t.url.endsWith('/file.pdf') && t.status === 404));
  assert.equal(site.links.external_broken.targets[0].status, 404);

  // duplicati
  assert.equal(get('/dup1').title_duplicates, 1);
  assert.equal(get('/dup1').description_duplicates, 1);
  assert.equal(get('/dup1').content_duplicates, 1);
  assert.equal(get('/dup1').near_duplicates, 1, '/near');
  assert.equal(get('/near').near_duplicates, 2);
  assert.equal(get('/near').duplicate_group, `${fx.origin}/dup1`);
  assert.equal(get('/b').duplicate_group, null);
  assert.ok(site.duplicates.titles.some((g) => g.value === 'Doppione' && g.count === 2));
  assert.equal(get('/noindex').title_duplicates, null, 'i duplicati si contano solo tra pagine indicizzabili');

  // canonical tra pagine
  assert.deepEqual(get('/canon2').canonical_issue, ['canonical verso una pagina non indicizzabile (noindex nel meta robots)']);
  assert.deepEqual(get('/canon').canonical_issue, []);

  // hreflang
  const it = get('/it/pagina');
  assert.equal(it.hreflang_reciprocal, false);
  assert.ok(it.hreflang_issues.includes(`en: manca il ritorno da ${fx.origin}/en/page`));
  assert.ok(it.hreflang_issues.includes('codice lingua non valido "english"'));
  assert.equal(get('/en/page').hreflang_reciprocal, true);
  assert.equal(site.hreflang.not_reciprocal, 1);
  assert.deepEqual(site.hreflang.invalid_codes, ['english']);

  // sitemap
  assert.equal(get('/missing').sitemap_issue, 'in sitemap ma non indicizzabile: errore 404');
  assert.equal(get('/b').sitemap_issue, 'indicizzabile ma assente dalla sitemap');
  assert.equal(get('/a').sitemap_lastmod, '2026-10-01');
  assert.equal(site.sitemap.non_indexable.count, 1);
  assert.equal(site.sitemap.lastmod.note, 'date plausibili');

  // parametri e paginazione
  assert.deepEqual(get('/a?sort=asc').url_params, ['sort']);
  assert.equal(get('/a?sort=asc').param_duplicate_of, `${fx.origin}/a`);
  assert.deepEqual(site.parameters.find((p) => p.name === 'sort'), { name: 'sort', urls: 1, duplicates: 1, examples: [`${fx.origin}/a?sort=asc`] });
  assert.equal(get('/lista?page=2').pagination, 'pagina 2');
  assert.equal(get('/lista?page=2').param_duplicate_of, null);
  assert.deepEqual([site.pagination.pages, site.pagination.canonical_to_other], [1, 1]);

  // robots.txt: risorse e sezioni bloccate
  assert.deepEqual(site.robots.blocked_assets, { count: 1, examples: [`${fx.origin}/privato/app.js`] });
  assert.equal(site.robots.blocked_sections[0].section, '/privato');

  // controlli con richieste dedicate
  const c = site.checks!;
  assert.equal(c.not_found.correct, true);
  assert.equal(c.not_found.status, 404);
  assert.equal(c.llms_txt[0].found, false);
  assert.equal(c.trailing_slash?.behaviour, 'errore');
  assert.equal(c.domain_variants.variants.length, 2, 'un indirizzo IP non ha la versione www');
  assert.equal(c.domain_variants.https, false);
  assert.match(c.domain_variants.note, /una versione non risponde/);
  const ai = (n: string) => c.ai_crawlers.elenco.find((x) => x.nome === n)!;
  assert.deepEqual([ai('GPTBot').accesso, ai('GPTBot').regole_da], ['bloccato', 'gruppo proprio']);
  assert.deepEqual([ai('ClaudeBot').accesso, ai('ClaudeBot').regole_da, ai('ClaudeBot').disallow], ['parziale', 'regole generali (*)', ['/privato/']]);

  // file
  exportRun(d);
  const json = JSON.parse(readFileSync(join(d, 'site.json'), 'utf8'));
  assert.equal(json.schema_version, 0);
  assert.equal(json.orphans.count, 1);
  assert.match(readFileSync(join(d, 'links.csv'), 'utf8'), /esterno-rotto;[^\n]*;404;/);
  assert.ok(RunStore.readLinkChecks(d).length >= 2);
});

test('pagina 404 che risponde 200 e llms.txt presente', async () => {
  const { runSiteChecks } = await import('../src/site/checks.js');
  const hop = (url: string, status: number, type = 'text/html') => ({ hops: [{ url, status, location: null, headers: { 'content-type': type }, ms: 1 }], redirectType: 'nessuno' as const, body: type === 'text/plain' ? '# Sito\n> descrizione' : '<html></html>', bytes: 20, truncated: false, error: null });
  const c = await runSiteChecks({ startUrl: 'https://www.esempio.it/', robots: null, robotsStatus: 404, samplePage: 'https://www.esempio.it/chi-siamo', get: async (u) => (u.endsWith('/llms.txt') ? hop(u, 200, 'text/plain') : u.startsWith('http://') ? { ...hop(u, 301), hops: [{ url: u, status: 301, location: 'https://www.esempio.it/', headers: {}, ms: 1 }, { url: 'https://www.esempio.it/', status: 200, location: null, headers: {}, ms: 1 }] } : hop(u, 200)) });
  assert.equal(c.not_found.correct, false);
  assert.match(c.not_found.note, /soft 404/);
  assert.equal(c.llms_txt[0].found, true);
  assert.equal(c.llms_txt[1].found, false, 'una pagina HTML servita a ogni indirizzo non è un llms-full.txt');
  assert.equal(c.domain_variants.variants.length, 4);
  assert.equal(c.domain_variants.consistent, false, 'http rimanda a www, ma https senza www risponde per conto suo');
  assert.equal(c.trailing_slash?.behaviour, 'duplicato');
  assert.ok(c.ai_crawlers.elenco.every((x) => x.accesso === 'consentito'));
});

test('crawler AI: elenco verificato e lettura di robots.txt', () => {
  const list = aiCrawlers();
  assert.match(list.verificato_il, /^\d{4}-\d{2}-\d{2}$/);
  for (const n of ['GPTBot', 'OAI-SearchBot', 'ClaudeBot', 'Claude-SearchBot', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended', 'CCBot']) assert.ok(list.crawler.some((c) => c.nome === n), n);
  const r = parseRobots('User-agent: *\nAllow: /\n\nUser-agent: ClaudeBot\nUser-agent: GPTBot\nDisallow: /\n\nUser-agent: PerplexityBot\nDisallow: /blog/\n');
  const ai = (n: string) => aiAccess(r).find((x) => x.nome === n)!;
  assert.equal(ai('ClaudeBot').accesso, 'bloccato');
  assert.equal(ai('Claude-SearchBot').accesso, 'consentito', 'il gruppo di ClaudeBot non vale per Claude-SearchBot');
  assert.equal(ai('PerplexityBot').accesso, 'parziale');
  assert.equal(ai('Googlebot').accesso, 'consentito');
});

test('analisi: contenuto leggibile senza JavaScript e date della sitemap', () => {
  const words = (n: number, w = 'parola') => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ');
  const page = (url: string, extra: Partial<AnalyzablePage> = {}): AnalyzablePage => ({ url, status: 200, final_url: url, redirect_to: null, fetched: true, template: 'pagina', depth: null, in_sitemap: true, robots_txt_blocked: false, indexable: true, indexability_reason: '', canonical: null, canonical_type: 'assente', title: url, description: null, word_count: 200, content_hash: url, content_simhash: simhash(words(200, url)), hreflang: [], rendered: true, js_only_fields: [], content_raw_ratio: 1, raw_word_count: 200, ...extra });
  const pages = [page('https://x.it/'), page('https://x.it/a', { content_raw_ratio: 0.1, js_only_fields: ['content'], template: 'prodotto' }), page('https://x.it/b', { content_raw_ratio: 0.3, template: 'prodotto' })];
  const sitemap = Array.from({ length: 30 }, (_, i) => ({ loc: `https://x.it/p${i}`, lastmod: i === 0 ? '2031-01-01' : '2026-11-01' }));
  const site = analyzeSite(pages, { links: [], seeds: ['https://x.it/'], sitemap, sitemapFiles: [], checks: [], site: null, assets: [], robotsText: {}, followedLinks: false, normalize: (u) => u });
  assert.deepEqual(site.geo.content_without_js, { rendered_pages: 3, average_ratio: 0.47, pages_below_half: 2, js_only_content: 1, by_template: [{ template: 'prodotto', pages: 2, average_ratio: 0.2 }, { template: 'pagina', pages: 1, average_ratio: 1 }] });
  assert.equal(site.sitemap.lastmod.future, 1);
  assert.match(site.sitemap.lastmod.note, /1 date nel futuro/);
  assert.equal(site.sitemap.not_crawled.count, 30);
  assert.equal(site.orphans.applicable, false);
  assert.equal(pages[1].orphan, null);
  const same = analyzeSite([page('https://x.it/')], { links: [], seeds: [], sitemap: sitemap.map((s) => ({ ...s, lastmod: '2026-11-01' })), sitemapFiles: [], checks: [], site: null, assets: [], robotsText: {}, followedLinks: true, normalize: (u) => u });
  assert.match(same.sitemap.lastmod.note, /stessa data/);
});
