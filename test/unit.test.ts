import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configSchema } from '../src/config/schema.js';
import { crawlDelayFor, parseRobots, robotsCheck } from '../src/crawl/robots.js';
import { normalizeUrl, Scope } from '../src/crawl/scope.js';
import { parseSitemapXml } from '../src/crawl/sitemap.js';
import { LINK_COLUMNS, PAGE_COLUMNS } from '../src/report/export.js';

const cfg = (extra: Record<string, unknown> = {}) => configSchema.parse({ cliente: 'Test', partenza: { dominio: 'https://www.esempio.it/' }, ...extra });

test('indirizzi: forma canonica per la coda', () => {
  const ign = cfg().perimetro.parametriIgnorati;
  assert.equal(normalizeUrl('HTTPS://WWW.Esempio.IT:443/Pagina#sezione', undefined, ign), 'https://www.esempio.it/Pagina');
  assert.equal(normalizeUrl('/a?utm_source=x&id=3&gclid=abc', 'https://www.esempio.it/', ign), 'https://www.esempio.it/a?id=3');
  assert.equal(normalizeUrl('/a?utm_source=x', 'https://www.esempio.it/', ign), 'https://www.esempio.it/a');
  assert.equal(normalizeUrl('/a/', 'https://www.esempio.it/', ign), 'https://www.esempio.it/a/', 'la barra finale resta');
  assert.equal(normalizeUrl('/a?b=2&a=1', 'https://www.esempio.it/', ign), 'https://www.esempio.it/a?b=2&a=1', "l'ordine dei parametri resta");
  assert.equal(normalizeUrl('mailto:a@b.it', 'https://www.esempio.it/', ign), null);
});

test('perimetro: sottodomini, cartelle, file', () => {
  const s = new Scope(cfg({ perimetro: { escludi: ['^/area-riservata'] } }), ['https://www.esempio.it/']);
  assert.equal(s.reason('https://www.esempio.it/prodotti/x'), null);
  assert.equal(s.reason('https://esempio.it/prodotti/x'), null, 'con e senza www sono lo stesso sito');
  assert.equal(s.reason('https://shop.esempio.it/'), 'sottodominio-escluso');
  assert.equal(s.reason('https://altro.com/'), 'altro-dominio');
  assert.equal(s.reason('https://www.esempio.it/area-riservata/x'), 'escluso');
  assert.equal(s.reason('https://www.esempio.it/listino.pdf'), 'non-pagina');
  assert.equal(new Scope(cfg({ perimetro: { sottodomini: 'includi' } }), ['https://www.esempio.it/']).reason('https://shop.esempio.it/'), null);
  const list = new Scope(cfg({ perimetro: { sottodomini: ['shop.esempio.it'] } }), ['https://www.esempio.it/']);
  assert.equal(list.reason('https://shop.esempio.it/'), null);
  assert.equal(list.reason('https://blog.esempio.it/'), 'sottodominio-escluso');
  assert.equal(new Scope(cfg({ perimetro: { includi: ['^/it/'] } }), ['https://www.esempio.it/']).reason('https://www.esempio.it/en/x'), 'non-incluso');
});

test('robots.txt: gruppo del crawler, regola più lunga, $ e *', () => {
  const r = parseRobots(`User-agent: *\nDisallow: /privato/\nAllow: /privato/pubblico\nDisallow: /*.json$\nCrawl-delay: 2\n\nUser-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\n\nSitemap: https://www.esempio.it/sitemap.xml\nFoo: bar\n`);
  assert.equal(robotsCheck(r, 'ScrawlSEO', '/privato/x').allowed, false);
  assert.equal(robotsCheck(r, 'ScrawlSEO', '/privato/pubblico/x').allowed, true);
  assert.equal(robotsCheck(r, 'ScrawlSEO', '/api/dati.json').allowed, false);
  assert.equal(robotsCheck(r, 'ScrawlSEO', '/api/dati.json?x=1').allowed, true);
  assert.equal(robotsCheck(r, 'GPTBot', '/').allowed, false);
  assert.equal(robotsCheck(r, 'ClaudeBot', '/qualsiasi').allowed, false);
  assert.equal(robotsCheck(r, 'Googlebot', '/qualsiasi').allowed, true);
  assert.equal(crawlDelayFor(r, 'ScrawlSEO'), 2);
  assert.deepEqual(r.sitemaps, ['https://www.esempio.it/sitemap.xml']);
  assert.equal(r.problems.length, 1);
});

test('sitemap: indice, pagine con lastmod, testo semplice', () => {
  const idx = parseSitemapXml('<sitemapindex><sitemap><loc>https://x.it/s1.xml</loc></sitemap></sitemapindex>');
  assert.equal(idx.kind, 'indice');
  const set = parseSitemapXml('<urlset><url><loc><![CDATA[https://x.it/a?b=1&amp;c=2]]></loc><lastmod>2026-01-02</lastmod></url><url><loc>https://x.it/b</loc></url></urlset>');
  assert.deepEqual(set.items, [{ loc: 'https://x.it/a?b=1&c=2', lastmod: '2026-01-02' }, { loc: 'https://x.it/b', lastmod: null }]);
  assert.equal(parseSitemapXml('https://x.it/a\nhttps://x.it/b\n').items.length, 2);
  assert.equal(parseSitemapXml('<html><body>404</body></html>').kind, 'non-valida');
});

test('formato: le colonne dei file di dati non cambiano senza una voce "Formato" nel CHANGELOG', () => {
  // Le colonne possono solo aumentare finché schema_version è 0: le prime restano dove sono
  assert.deepEqual(PAGE_COLUMNS.slice(0, 21), ['url', 'status', 'final_url', 'final_status', 'redirect_type', 'redirect_hops', 'redirect_chain', 'redirect_to', 'content_type', 'template', 'depth', 'source', 'found_on', 'in_sitemap', 'robots_txt_blocked', 'robots_txt_rule', 'fetched', 'fetch_ms', 'bytes', 'error', 'fetched_at']);
  assert.deepEqual(PAGE_COLUMNS.slice(21), ['robots_meta', 'x_robots_tag', 'canonical', 'canonical_type', 'canonical_count', 'indexable', 'indexability_reason', 'title', 'title_length', 'title_count', 'description', 'description_length', 'h1', 'h1_count', 'heading_issues', 'word_count', 'content_hash', 'content_simhash', 'lang', 'hreflang', 'hreflang_count', 'viewport', 'outlinks_internal', 'outlinks_external', 'outlinks_nofollow', 'images_count', 'images_missing_alt', 'images_missing_dimensions', 'images_bytes', 'images_heavy', 'images_legacy_format', 'schema_types', 'schema_formats', 'schema_errors', 'schema_missing_required', 'schema_missing_recommended', 'schema_content_mismatch', 'rendered', 'render_reason', 'render_error', 'raw_title', 'raw_description', 'raw_canonical', 'raw_robots_meta', 'raw_h1', 'raw_word_count', 'raw_schema_types', 'raw_outlinks_internal', 'diff_fields', 'js_only_fields', 'content_raw_ratio', 'links_only_rendered', 'links_only_raw', 'tracker_requests_blocked']);
  assert.deepEqual([...LINK_COLUMNS], ['source_url', 'target_url', 'anchor', 'rel', 'nofollow', 'is_internal', 'in_raw', 'in_rendered', 'target_status', 'target_final_url', 'placement']);
});
