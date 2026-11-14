import { createServer, type Server } from 'node:http';

const page = (title: string, links: string[]) => `<!doctype html><html lang="it"><head><title>${title}</title></head><body><h1>${title}</h1>${links.map((l) => `<a href="${l}">vai a ${l}</a>`).join('\n')}</body></html>`;

const PAGES: Record<string, string> = {
  '/': page('Home', ['/a', '/b', '/redir', '/blog/post-1', '/blog/post-2', '/privato/x', 'https://example.org/', '/file.pdf', '/a#sezione', '/a?utm_source=newsletter', 'mailto:info@esempio.test', '/missing']),
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
