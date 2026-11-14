import type { PageFacts } from './extract.js';

/** Direttive di robots che contano per l'indicizzazione, da meta e da intestazione X-Robots-Tag. */
export function xRobots(header: string | undefined, crawler: string): string[] {
  if (!header) return [];
  const out = new Set<string>();
  // "noindex, nofollow" oppure "googlebot: noindex" (più valori separati da virgola nella stessa intestazione)
  for (const part of header.toLowerCase().split(',')) {
    const m = /^\s*([a-z0-9_-]+)\s*:\s*(.+)$/.exec(part);
    // con un nome davanti, la direttiva vale solo per quel crawler: si tengono quelle di Google e le nostre
    if (m && !/^(unavailable_after|max-snippet|max-image-preview|max-video-preview)$/.test(m[1])) {
      if (m[1] === 'googlebot' || m[1] === crawler.toLowerCase()) out.add(m[2].trim());
    } else if (part.trim()) out.add(part.trim());
  }
  return [...out];
}

export const hasNoindex = (directives: string[]) => directives.some((d) => d === 'noindex' || d === 'none');

export type CanonicalType = 'assente' | 'autoreferenziale' | 'altra-pagina' | 'in-conflitto' | 'non-valido';

/** Canonical dall'intestazione HTTP Link: <url>; rel="canonical". */
export function linkHeaderCanonical(header: string | undefined, base: string): string | null {
  if (!header) return null;
  for (const part of header.split(/,(?=\s*<)/)) {
    const m = /<([^>]+)>\s*;(.*)$/s.exec(part.trim());
    if (m && /rel\s*=\s*"?[^";]*\bcanonical\b/i.test(m[2])) {
      try {
        const u = new URL(m[1], base);
        u.hash = '';
        return u.toString();
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Canonical di una pagina. `normalize` porta gli indirizzi nella forma della coda, così il confronto con
 * l'indirizzo della pagina non scatta per un frammento o un parametro di tracciamento.
 */
export function canonicalOf(tags: string[], headerCanonical: string | null, pageUrl: string, normalize: (u: string) => string | null): { canonical: string | null; type: CanonicalType; count: number } {
  const all = [...tags, ...(headerCanonical ? [headerCanonical] : [])];
  if (!all.length) return { canonical: null, type: 'assente', count: 0 };
  const norm = all.map((c) => (c ? normalize(c) : null));
  if (norm.some((c) => !c)) return { canonical: norm.find((c) => c) ?? null, type: 'non-valido', count: all.length };
  const distinct = [...new Set(norm as string[])];
  if (distinct.length > 1) return { canonical: distinct[0], type: 'in-conflitto', count: all.length };
  return { canonical: distinct[0], type: distinct[0] === normalize(pageUrl) ? 'autoreferenziale' : 'altra-pagina', count: all.length };
}

export interface Diff {
  /** Campi diversi tra HTML del server e DOM renderizzato. */
  diff_fields: string[];
  /** Campi assenti nell'HTML del server e presenti solo dopo JavaScript. */
  js_only_fields: string[];
  /** Parole del contenuto principale nel sorgente, in rapporto al renderizzato (1 = tutto leggibile senza JavaScript). */
  content_raw_ratio: number | null;
  /** Link interni presenti solo dopo JavaScript / solo nel sorgente. */
  links_only_rendered: number;
  links_only_raw: number;
}

const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/** Confronto campo per campo tra ciò che manda il server e ciò che esiste dopo l'esecuzione di JavaScript. */
/** `rawInternal` e `renderedInternal`: destinazioni dei link interni, già in forma canonica. */
export function diffFacts(raw: PageFacts, rendered: PageFacts, rawInternal: string[], renderedInternal: string[]): Diff {
  const diff: string[] = [];
  const jsOnly: string[] = [];
  const field = (name: string, a: string, b: string) => {
    if (a === b) return;
    diff.push(name);
    if (!a && b) jsOnly.push(name);
  };
  field('title', raw.title ?? '', rendered.title ?? '');
  field('description', raw.description ?? '', rendered.description ?? '');
  field('canonical', [...new Set(raw.canonicals)].sort().join(' '), [...new Set(rendered.canonicals)].sort().join(' '));
  field('robots_meta', [...raw.robots_meta].sort().join(','), [...rendered.robots_meta].sort().join(','));
  field('h1', raw.h1.join(' | '), rendered.h1.join(' | '));
  field('lang', raw.lang ?? '', rendered.lang ?? '');
  field('hreflang', raw.hreflang.map((h) => `${h.lang}=${h.href}`).sort().join(' '), rendered.hreflang.map((h) => `${h.lang}=${h.href}`).sort().join(' '));
  if (!same(raw.schema.types, rendered.schema.types)) {
    diff.push('schema_types');
    if (!raw.schema.types.length && rendered.schema.types.length) jsOnly.push('schema_types');
  }
  const ratio = rendered.word_count > 0 ? Math.min(1, Math.round((raw.word_count / rendered.word_count) * 100) / 100) : raw.word_count > 0 ? 1 : null;
  // Contenuto: differenza solo se rilevante (oltre il 10% e almeno 30 parole), per non segnalare un contatore o un orario
  if (Math.abs(rendered.word_count - raw.word_count) >= Math.max(30, rendered.word_count * 0.1)) {
    diff.push('content');
    if (raw.word_count < 20 && rendered.word_count >= 50) jsOnly.push('content');
  }
  const a = new Set(rawInternal);
  const b = new Set(renderedInternal);
  let onlyRendered = 0;
  let onlyRaw = 0;
  for (const x of b) if (!a.has(x)) onlyRendered++;
  for (const x of a) if (!b.has(x)) onlyRaw++;
  if (onlyRendered || onlyRaw) {
    diff.push('links');
    if (!a.size && b.size) jsOnly.push('links');
  }
  return { diff_fields: diff, js_only_fields: jsOnly, content_raw_ratio: ratio, links_only_rendered: onlyRendered, links_only_raw: onlyRaw };
}

/** Differenze che cambiano ciò che un motore capisce della pagina: decidono se renderizzare tutto il modello. */
export const CRITICAL_DIFF = ['title', 'canonical', 'robots_meta', 'h1', 'schema_types', 'content', 'links', 'description'];

/**
 * Segnali, nel solo HTML del server, che la pagina dipende da JavaScript: se ce n'è almeno uno la pagina viene
 * renderizzata anche su un sito grande. `medianLinks` è la mediana dei link interni del suo modello di pagina.
 */
export function suspectRaw(raw: PageFacts, html: string, medianLinks: number): string | null {
  if (!raw.title) return 'title assente nel sorgente';
  if (raw.word_count < 50) return `contenuto principale scarso nel sorgente (${raw.word_count} parole)`;
  if (/<(?:div|main|section)[^>]+id=["'](?:app|root|__next|__nuxt|___gatsby|svelte)["'][^>]*>\s*<\/(?:div|main|section)>/i.test(html)) return 'contenitore dell\'applicazione vuoto nel sorgente';
  if (medianLinks >= 10 && raw.links_internal < medianLinks * 0.3) return `link interni molto sotto la mediana del modello (${raw.links_internal} contro ${Math.round(medianLinks)})`;
  return null;
}

export interface Indexability {
  indexable: boolean | null;
  reason: string;
}

/**
 * Esito per la singola pagina. I controlli che richiedono altre pagine (canonical verso una pagina non
 * indicizzabile, conflitti con sitemap e hreflang) arrivano al passo 4.
 */
export function indexability(p: { fetched: boolean; status: number | null; isHtml: boolean; redirect: boolean; robotsBlocked: boolean; xRobots: string[]; rawMeta: string[]; renderedMeta: string[] | null; canonicalType: CanonicalType; error: string | null }): Indexability {
  if (!p.fetched) return { indexable: false, reason: 'vietata da robots.txt (non letta)' };
  if (p.status === null) return { indexable: false, reason: `nessuna risposta${p.error ? `: ${p.error}` : ''}` };
  if (p.redirect) return { indexable: false, reason: `redirect (${p.status})` };
  if (p.status >= 400) return { indexable: false, reason: `errore ${p.status}` };
  if (!p.isHtml) return { indexable: null, reason: 'non è una pagina HTML' };
  if (p.robotsBlocked) return { indexable: false, reason: 'vietata da robots.txt' };
  if (hasNoindex(p.xRobots)) return { indexable: false, reason: 'noindex nell\'intestazione X-Robots-Tag' };
  if (hasNoindex(p.rawMeta)) return { indexable: false, reason: 'noindex nel meta robots' };
  if (p.renderedMeta && hasNoindex(p.renderedMeta)) return { indexable: false, reason: 'noindex nel meta robots, aggiunto da JavaScript' };
  if (p.canonicalType === 'altra-pagina') return { indexable: false, reason: 'canonical verso un\'altra pagina' };
  return { indexable: true, reason: '' };
}
