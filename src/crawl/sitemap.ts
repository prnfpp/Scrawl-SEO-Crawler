export interface SitemapEntry {
  loc: string;
  lastmod: string | null;
  /** Sitemap in cui compare. */
  sitemap: string;
}

export interface SitemapFile {
  url: string;
  status: number | null;
  kind: 'indice' | 'pagine' | 'non-valida';
  entries: number;
  error: string | null;
}

const clean = (s: string) =>
  s
    .replace(/^\s*<!\[CDATA\[/, '')
    .replace(/\]\]>\s*$/, '')
    .trim()
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");

const tag = (block: string, name: string) => {
  const m = new RegExp(`<(?:\\w+:)?${name}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'i').exec(block);
  return m ? clean(m[1]) : null;
};

/** Legge una sitemap XML (indice o elenco di pagine) o un elenco di indirizzi in testo semplice. */
export function parseSitemapXml(xml: string): { kind: SitemapFile['kind']; items: { loc: string; lastmod: string | null }[] } {
  const isIndex = /<(?:\w+:)?sitemapindex[\s>]/i.test(xml);
  const isUrlset = /<(?:\w+:)?urlset[\s>]/i.test(xml);
  if (!isIndex && !isUrlset) {
    // Sitemap in testo semplice: un indirizzo per riga
    const lines = xml.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length && lines.every((l) => /^https?:\/\/\S+$/i.test(l))) return { kind: 'pagine', items: lines.map((loc) => ({ loc, lastmod: null })) };
    return { kind: 'non-valida', items: [] };
  }
  const items: { loc: string; lastmod: string | null }[] = [];
  const re = new RegExp(`<(?:\\w+:)?${isIndex ? 'sitemap' : 'url'}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${isIndex ? 'sitemap' : 'url'}>`, 'gi');
  for (const m of xml.matchAll(re)) {
    const loc = tag(m[1], 'loc');
    if (loc) items.push({ loc, lastmod: tag(m[1], 'lastmod') });
  }
  return { kind: isIndex ? 'indice' : 'pagine', items };
}

/**
 * Legge le sitemap indicate seguendo gli indici. `get` scarica un indirizzo (stesso client, stesse pause del resto
 * della scansione). Si ferma a 200 file o a `maxUrls` indirizzi: i limiti raggiunti finiscono nelle note.
 */
export async function readSitemaps(
  start: string[],
  get: (url: string) => Promise<{ status: number | null; body: string | null; error: string | null }>,
  maxUrls: number,
): Promise<{ files: SitemapFile[]; entries: SitemapEntry[]; notes: string[] }> {
  const queue = [...start];
  const visited = new Set<string>();
  const files: SitemapFile[] = [];
  const entries: SitemapEntry[] = [];
  const notes: string[] = [];
  while (queue.length) {
    const url = queue.shift()!;
    if (visited.has(url)) continue;
    if (visited.size >= 200) {
      notes.push(`Sitemap: letti 200 file, ${queue.length + 1} non letti`);
      break;
    }
    visited.add(url);
    const r = await get(url);
    if (!r.body || (r.status ?? 0) >= 400) {
      files.push({ url, status: r.status, kind: 'non-valida', entries: 0, error: r.error ?? (r.status ? `risposta ${r.status}` : 'non leggibile') });
      continue;
    }
    const parsed = parseSitemapXml(r.body);
    files.push({ url, status: r.status, kind: parsed.kind, entries: parsed.items.length, error: parsed.kind === 'non-valida' ? 'il contenuto non è una sitemap' : null });
    if (parsed.kind === 'indice') queue.push(...parsed.items.map((i) => i.loc));
    else {
      for (const i of parsed.items) {
        if (entries.length >= maxUrls) {
          notes.push(`Sitemap: letti i primi ${maxUrls} indirizzi, gli altri non sono stati considerati`);
          return { files, entries, notes };
        }
        entries.push({ ...i, sitemap: url });
      }
    }
  }
  return { files, entries, notes };
}
