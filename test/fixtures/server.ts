import { createServer, type Server } from 'node:http';

const page = (title: string, links: string[]) => `<!doctype html><html lang="it"><head><title>${title}</title></head><body><h1>${title}</h1>${links.map((l) => `<a href="${l}">vai a ${l}</a>`).join('\n')}</body></html>`;

const PAGES: Record<string, string> = {
  '/': page('Home', ['/a', '/b', '/redir', '/blog/post-1', '/blog/post-2', '/privato/x', 'https://example.org/', '/file.pdf', '/a#sezione', '/a?utm_source=newsletter', 'mailto:info@esempio.test', '/missing', '/js/spa', '/noindex', '/canon', '/jsnoindex', '/prodotto', '/xrobots']),
  '/a': page('A', ['/b', '/c']),
  '/b': page('B', ['/']),
  '/c': page('C', ['/deep/1']),
  '/deep/1': page('Deep 1', ['/deep/2']),
  '/deep/2': page('Deep 2', ['/deep/3']),
  '/deep/3': page('Deep 3', []),
  '/blog/post-1': page('Post 1', ['/blog/post-2']),
  '/blog/post-2': page('Post 2', ['/blog/post-1']),
  '/orfana': page('Orfana', ['/loop1']),
  '/privato/x': page('Privato', []),
};
const LOREM = Array.from({ length: 90 }, (_, i) => `parola${i}`).join(' ');
/** Pagine scritte a mano: applicazione JavaScript, direttive, dati strutturati. */
const SPECIAL: Record<string, string> = {
  // Applicazione: nel sorgente c'è solo il contenitore vuoto; titolo, H1, testo, canonical, link e dati strutturati arrivano da JavaScript
  '/js/spa': `<!doctype html><html lang="it"><head><title>Caricamento</title></head><body><div id="app"></div><script>
    document.title = 'Prodotto SPA';
    var c = document.createElement('link'); c.rel = 'canonical'; c.href = location.origin + '/js/spa'; document.head.appendChild(c);
    var ld = document.createElement('script'); ld.type = 'application/ld+json'; ld.textContent = JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: 'Prodotto SPA', offers: { '@type': 'Offer', price: '49.00', priceCurrency: 'EUR' } }); document.head.appendChild(ld);
    document.getElementById('app').innerHTML = '<main><h1>Prodotto SPA</h1><p>${LOREM}</p><p>Prezzo 49,00 euro</p><a href="/solo-js">pagina raggiungibile solo dopo JavaScript</a><a href="/a">A</a></main>';
    fetch('/g/collect?v=2&tid=G-PROVA&en=page_view').catch(function () {});
    new Image().src = '/matomo.php?idsite=1&rec=1';
  </script></body></html>`,
  '/solo-js': page('Solo JS', ['/']),
  '/noindex': `<!doctype html><html lang="it"><head><title>Noindex</title><meta name="robots" content="NOINDEX, follow"><link rel="canonical" href="/noindex"></head><body><h1>Noindex</h1></body></html>`,
  '/canon': `<!doctype html><html lang="it"><head><title>Canonical altrove</title><link rel="canonical" href="/a"></head><body><h1>Canonical altrove</h1></body></html>`,
  '/jsnoindex': `<!doctype html><html lang="it"><head><title>Noindex da JS</title></head><body><h1>Noindex da JS</h1><script>var m = document.createElement('meta'); m.name = 'robots'; m.content = 'noindex'; document.head.appendChild(m);</script></body></html>`,
  '/xrobots': page('X-Robots', []),
  '/prodotto': `<!doctype html><html lang="it-IT"><head><title>Divano Milano</title><meta name="description" content="Divano a tre posti."><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="canonical" href="/prodotto"><link rel="alternate" hreflang="en" href="/en/prodotto">
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Poltrona Roma","image":"/img.png"}</script>
    <script type="application/ld+json">{"@type":"BreadcrumbList", "itemListElement": [ {"position":1,} ]}</script>
    </head><body><header><a href="/">Home</a></header><main><h1>Divano Milano</h1><h3>Dettagli</h3><p>${LOREM}</p><img src="/img.png"><img src="/img.png" alt="Divano" width="10" height="10"><a href="/a" rel="nofollow">scheda</a></main><footer><a href="/b">B</a></footer></body></html>`,
};
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const REDIRECTS: Record<string, [number, string]> = { '/redir': [301, '/redir2'], '/redir2': [302, '/a'], '/loop1': [302, '/loop2'], '/loop2': [302, '/loop1'] };

export interface Fixture {
  server: Server;
  origin: string;
  /** Richieste ricevute per percorso. */
  hits: Map<string, number>;
  close: () => Promise<void>;
}

export async function startFixture(delayMs = 0): Promise<Fixture> {
  const hits = new Map<string, number>();
  let origin = '';
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const reply = () => {
      if (path === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`User-agent: *\nDisallow: /privato/\n\nSitemap: ${origin}/sitemap.xml\n`);
      } else if (path === '/sitemap.xml') {
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/a', '/orfana', '/missing'].map((p) => `<url><loc>${origin}${p}</loc><lastmod>2026-10-01</lastmod></url>`).join('')}</urlset>`);
      } else if (REDIRECTS[path]) {
        res.writeHead(REDIRECTS[path][0], { location: REDIRECTS[path][1] });
        res.end();
      } else if (path === '/img.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(PNG);
      } else if (path === '/g/collect' || path === '/matomo.php') {
        res.writeHead(204);
        res.end();
      } else if (SPECIAL[path]) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...(path === '/xrobots' ? { 'x-robots-tag': 'googlebot: noindex, max-snippet: 10' } : {}) });
        res.end(SPECIAL[path]);
      } else if (PAGES[path]) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(PAGES[path]);
      } else {
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end(page('Non trovata', []));
      }
    };
    if (delayMs) setTimeout(reply, delayMs);
    else reply();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const addr = server.address();
  origin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  return { server, origin, hits, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}
