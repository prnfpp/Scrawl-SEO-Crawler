import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TrackerBlocker } from '../src/crawl/trackers.js';
import { canonicalOf, diffFacts, hasNoindex, indexability, linkHeaderCanonical, suspectRaw, xRobots } from '../src/extract/compare.js';
import { simhash, simhashDistance } from '../src/extract/content.js';
import { extractPage, headingIssues } from '../src/extract/extract.js';

const internal = (h: string) => h === 'x.it' || h === 'www.x.it';
const words = (n: number, w = 'parola') => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ');

const HTML = `<!doctype html><html lang="it-IT"><head>
<title> Divano  Milano </title><meta name="Description" content="Tre posti."><meta name="robots" content="Index, Follow"><meta name="googlebot" content="max-snippet:-1">
<link rel="canonical" href="/prodotti/divano?utm_source=x#top"><link rel="alternate" hreflang="EN" href="/en/sofa"><link rel="alternate" hreflang="x-default" href="/">
<meta name="viewport" content="width=device-width"><base href="https://x.it/prodotti/">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Product","name":"Divano Milano","offers":{"@type":"Offer","price":"1299.00"}},{"@type":["Organization","Corporation"],"name":"X"}]}</script>
<script type="application/ld+json">{"@type":"FAQPage",}</script>
</head><body>
<header><a href="/">Home</a><svg><title>icona</title></svg></header>
<nav><a href="altri">Altri</a></nav>
<main><h2>Prima</h2><h1>Divano Milano</h1><h4>Salto</h4><p>${words(60)}</p><p>Prezzo: 1.299,00 €</p>
<a href="scheda.pdf" rel="NoFollow sponsored"> Scarica  la scheda </a><a href="https://altro.com/"><img alt="Partner" src="p.png"></a><a href="tel:123">t</a><a href="#su">su</a>
<img src="a.jpg"><img src="b.jpg" alt=""><img src="c.jpg" alt="C" width="10" height="10">
<div itemscope itemtype="https://schema.org/LocalBusiness"><span itemprop="name">Negozio X</span><div itemprop="address" itemscope itemtype="https://schema.org/PostalAddress"><span itemprop="streetAddress">Via Roma 1</span></div></div>
</main>
<footer><link rel="canonical" href="/sbagliato"><a href="/privacy">Privacy</a></footer>
<div id="onetrust-consent-sdk">${words(40, 'cookie')}<a href="/cookie-policy">Cookie policy</a></div>
</body></html>`;

test('estrazione: testata, titoli, link, immagini, contenuto principale', () => {
  const { facts: f, links, images } = extractPage(HTML, 'https://x.it/prodotti/divano', internal);
  assert.equal(f.title, 'Divano Milano');
  assert.equal(f.title_count, 1, 'il <title> di un SVG non conta');
  assert.equal(f.description, 'Tre posti.');
  assert.deepEqual(f.robots_meta, ['index', 'follow', 'max-snippet:-1']);
  assert.deepEqual(f.canonicals, ['https://x.it/prodotti/divano?utm_source=x']);
  assert.equal(f.canonical_in_body, 1);
  assert.equal(f.lang, 'it-IT');
  assert.deepEqual(f.hreflang, [{ lang: 'en', href: 'https://x.it/en/sofa' }, { lang: 'x-default', href: 'https://x.it/' }]);
  assert.equal(f.viewport, 'width=device-width');
  assert.deepEqual(f.h1, ['Divano Milano']);
  assert.deepEqual(headingIssues(f), ["il primo titolo è un H2, non l'H1", 'salto da H1 a H4']);
  assert.deepEqual(links.map((l) => [l.href, l.anchor, l.placement, l.nofollow]), [
    ['https://x.it/', 'Home', 'header', false],
    ['https://x.it/prodotti/altri', 'Altri', 'nav', false],
    ['https://x.it/prodotti/scheda.pdf', 'Scarica la scheda', 'main', true],
    ['https://altro.com/', 'Partner', 'main', false],
    ['https://x.it/privacy', 'Privacy', 'footer', false],
  ]);
  assert.equal(f.links_internal, 4);
  assert.equal(f.links_external, 1);
  assert.equal(f.links_nofollow, 1);
  assert.equal(f.images_count, 4);
  assert.equal(f.images_missing_alt, 1);
  assert.equal(f.images_empty_alt, 1);
  assert.equal(f.images_missing_dimensions, 3);
  assert.equal(images.length, 4);
  assert.equal(f.content_container, 'main');
  assert.ok(f.word_count >= 66 && f.word_count < 85, `parole: ${f.word_count} (senza menu, piè di pagina e banner)`);
  assert.equal(f.content_hash.length, 16);
});

test('dati strutturati: tipi, sintassi, proprietà mancanti, coerenza con il testo', () => {
  const { facts: f } = extractPage(HTML, 'https://x.it/prodotti/divano', internal);
  const s = f.schema;
  assert.deepEqual(s.types, ['Product', 'Offer', 'Organization', 'Corporation', 'LocalBusiness', 'PostalAddress']);
  assert.deepEqual(s.formats, ['jsonld', 'microdata']);
  assert.equal(s.errors.length, 1);
  assert.match(s.errors[0], /^JSON-LD 2:/);
  assert.deepEqual(s.missing_required, [], 'Product ha name e offers; LocalBusiness ha name e address');
  assert.ok(s.missing_recommended.includes('Product: image'));
  assert.ok(s.missing_recommended.includes('Product: offers.priceCurrency'));
  assert.ok(s.missing_recommended.includes('Organization: url'));
  assert.ok(s.missing_recommended.includes('LocalBusiness: telephone'));
  assert.deepEqual(s.content_mismatch, [], 'nome e prezzo (1299.00 = 1.299,00) sono nel testo');

  const bad = extractPage('<html><head><script type="application/ld+json">{"@type":"Product","name":"Poltrona Roma","offers":{"price":"80"}}</script><script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[{"position":1,"name":"Home"},{"position":2}]}</script><script type="application/ld+json">{"@type":"NewsArticle"}</script></head><body><h1>Divano</h1><p>Costa 90 euro</p></body></html>', 'https://x.it/p', internal).facts.schema;
  assert.deepEqual(bad.missing_required, ['BreadcrumbList: itemListElement.name']);
  assert.ok(bad.missing_recommended.includes('NewsArticle (Article): headline'));
  assert.equal(bad.content_mismatch.length, 2);
  assert.match(bad.content_mismatch[0], /Product\.name non compare/);
  assert.match(bad.content_mismatch[1], /offers\.price/);
  const none = extractPage('<html><head><script type="application/ld+json">{"@type":"Product","name":"X"}</script></head><body>X</body></html>', 'https://x.it/p', internal).facts.schema;
  assert.deepEqual(none.missing_required, ['Product: una tra offers, review, aggregateRating']);
});

test('contenuto principale senza <main>: body senza testata, menu e piè di pagina', () => {
  const f = extractPage(`<html><body><header>${words(30, 'menu')}</header><div><h1>Titolo</h1><p>${words(40)}</p></div><footer>${words(30, 'footer')}</footer></body></html>`, 'https://x.it/', internal).facts;
  assert.equal(f.content_container, 'body');
  assert.equal(f.word_count, 41);
  assert.equal(extractPage('<html><body></body></html>', 'https://x.it/', internal).facts.content_hash, '');
});

test('simhash: testi quasi uguali vicini, testi diversi lontani', () => {
  const a = simhash(words(200));
  const b = simhash(`${words(200)} con una frase in più alla fine`);
  const c = simhash(words(200, 'altro'));
  assert.ok(simhashDistance(a, b) <= 6, `quasi uguali: ${simhashDistance(a, b)}`);
  assert.ok(simhashDistance(a, c) >= 20, `diversi: ${simhashDistance(a, c)}`);
  assert.equal(simhash('poche parole'), '');
});

test('robots e canonical: intestazioni, tipi, esito di indicizzabilità', () => {
  assert.deepEqual(xRobots('noindex, nofollow', 'ScrawlSEO'), ['noindex', 'nofollow']);
  assert.deepEqual(xRobots('googlebot: noindex, max-snippet: 10', 'ScrawlSEO'), ['noindex', 'max-snippet: 10']);
  assert.deepEqual(xRobots('bingbot: noindex', 'ScrawlSEO'), [], 'direttiva per un altro crawler');
  assert.ok(hasNoindex(['none']));
  assert.equal(linkHeaderCanonical('<https://x.it/a>; rel="canonical", </b>; rel="next"', 'https://x.it/z'), 'https://x.it/a');
  assert.equal(linkHeaderCanonical('</b>; rel="next"', 'https://x.it/z'), null);

  const n = (u: string) => {
    const x = new URL(u);
    x.searchParams.delete('utm_source');
    return x.toString();
  };
  assert.equal(canonicalOf([], null, 'https://x.it/a', n).type, 'assente');
  assert.equal(canonicalOf(['https://x.it/a?utm_source=y'], null, 'https://x.it/a', n).type, 'autoreferenziale');
  assert.equal(canonicalOf(['https://x.it/b'], null, 'https://x.it/a', n).type, 'altra-pagina');
  assert.equal(canonicalOf(['https://x.it/a', 'https://x.it/b'], null, 'https://x.it/a', n).type, 'in-conflitto');
  assert.equal(canonicalOf(['https://x.it/a'], 'https://x.it/b', 'https://x.it/a', n).type, 'in-conflitto', 'tag e intestazione diversi');
  assert.equal(canonicalOf([''], null, 'https://x.it/a', n).type, 'non-valido');

  const base = { fetched: true, status: 200, isHtml: true, redirect: false, robotsBlocked: false, xRobots: [], rawMeta: [], renderedMeta: null, canonicalType: 'autoreferenziale' as const, error: null };
  assert.deepEqual(indexability(base), { indexable: true, reason: '' });
  assert.equal(indexability({ ...base, status: 301, redirect: true }).reason, 'redirect (301)');
  assert.equal(indexability({ ...base, status: 404 }).reason, 'errore 404');
  assert.equal(indexability({ ...base, xRobots: ['noindex'] }).reason, "noindex nell'intestazione X-Robots-Tag");
  assert.equal(indexability({ ...base, rawMeta: ['noindex'] }).reason, 'noindex nel meta robots');
  assert.equal(indexability({ ...base, renderedMeta: ['noindex'] }).reason, 'noindex nel meta robots, aggiunto da JavaScript');
  assert.equal(indexability({ ...base, canonicalType: 'altra-pagina' }).reason, "canonical verso un'altra pagina");
  assert.equal(indexability({ ...base, isHtml: false }).indexable, null);
  assert.equal(indexability({ ...base, fetched: false }).indexable, false);
});

test('confronto sorgente e renderizzato', () => {
  const raw = extractPage('<html><head><title>Caricamento</title></head><body><div id="app"></div></body></html>', 'https://x.it/p', internal);
  const ren = extractPage(`<html><head><title>Prodotto</title><link rel="canonical" href="https://x.it/p"><script type="application/ld+json">{"@type":"Product","name":"Prodotto"}</script></head><body><div id="app"><main><h1>Prodotto</h1><p>${words(80)}</p><a href="/a">a</a></main></div></body></html>`, 'https://x.it/p', internal);
  const d = diffFacts(raw.facts, ren.facts, [], ['https://x.it/a']);
  assert.deepEqual(d.diff_fields, ['title', 'canonical', 'h1', 'schema_types', 'content', 'links']);
  assert.deepEqual(d.js_only_fields, ['canonical', 'h1', 'schema_types', 'content', 'links']);
  assert.equal(d.content_raw_ratio, 0);
  assert.equal(d.links_only_rendered, 1);
  assert.match(suspectRaw(raw.facts, '<div id="app"></div>', 0) ?? '', /scarso/);
  assert.match(suspectRaw({ ...ren.facts }, '<body><div id="root"></div></body>', 0) ?? '', /contenitore/);
  assert.equal(suspectRaw(ren.facts, '<html></html>', 0), null);
  assert.match(suspectRaw(ren.facts, '<html></html>', 40) ?? '', /mediana/);
  const same = diffFacts(ren.facts, ren.facts, ['https://x.it/a'], ['https://x.it/a']);
  assert.deepEqual(same.diff_fields, []);
  assert.equal(same.content_raw_ratio, 1);
});

test('blocco dei tracker: invii di dati fermati, caricatori di tag e pagine no', () => {
  const b = new TrackerBlocker(['stats.cliente.it']);
  assert.ok(b.blocks('https://www.google-analytics.com/g/collect?v=2&tid=G-X'));
  assert.ok(b.blocks('https://region1.google-analytics.com/g/collect?v=2'));
  assert.ok(b.blocks('https://www.cliente.it/g/collect?v=2&tid=G-X'), 'tracciamento sul dominio del cliente');
  assert.ok(b.blocks('https://www.cliente.it/matomo.php?idsite=1'));
  assert.ok(b.blocks('https://stats.cliente.it/qualsiasi'));
  assert.ok(b.blocks('https://www.facebook.com/tr/?id=123&ev=PageView'));
  assert.ok(!b.blocks('https://www.googletagmanager.com/gtm.js?id=GTM-X'), 'il caricatore dei tag può scrivere contenuti');
  assert.ok(!b.blocks('https://www.cliente.it/prodotti/collect'));
  assert.ok(!b.blocks('https://www.cliente.it/'));
});
