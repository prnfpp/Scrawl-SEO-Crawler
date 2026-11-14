import { load } from 'cheerio';
import { contentHash, mainContent, simhash, visibleText } from './content.js';
import { structuredData, type StructuredData } from './structured.js';

export type Placement = 'main' | 'nav' | 'header' | 'footer' | 'aside' | 'body';

export interface PageLink {
  /** Indirizzo assoluto, senza frammento. */
  href: string;
  anchor: string;
  rel: string;
  nofollow: boolean;
  placement: Placement;
}

/** Ciò che si legge da un documento HTML: lo stesso per l'HTML del server e per il DOM renderizzato. */
export interface PageFacts {
  title: string | null;
  /** Quanti <title> nel documento (più di uno è un errore del template). */
  title_count: number;
  description: string | null;
  description_count: number;
  /** <link rel=canonical> nella <head>, risolti in indirizzi assoluti. */
  canonicals: string[];
  /** Canonical scritti nel <body>: i motori li ignorano. */
  canonical_in_body: number;
  /** Direttive di meta robots e meta googlebot, minuscole, senza ripetizioni. */
  robots_meta: string[];
  h1: string[];
  /** Titoli in ordine di comparsa: [livello, testo]. */
  headings: [number, string][];
  lang: string | null;
  hreflang: { lang: string; href: string }[];
  viewport: string | null;
  word_count: number;
  content_container: string;
  content_hash: string;
  content_simhash: string;
  links_internal: number;
  links_external: number;
  links_nofollow: number;
  images_count: number;
  /** Immagini senza attributo alt (alt="" è una scelta: immagine decorativa). */
  images_missing_alt: number;
  images_empty_alt: number;
  /** Immagini senza larghezza e altezza dichiarate: causano spostamenti del contenuto al caricamento. */
  images_missing_dimensions: number;
  schema: StructuredData;
}

export interface Extraction {
  facts: PageFacts;
  links: PageLink[];
  /** Indirizzi delle immagini della pagina (attributo src o primo candidato di srcset). */
  images: string[];
}

const collapse = (s: string | undefined | null) => (s ?? '').replace(/\s+/g, ' ').trim();
const SKIP = /^(?:javascript|mailto|tel|sms|data|whatsapp|skype|callto|fax|blob|about):/i;

function absolute(raw: string | undefined, base: string): string | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  try {
    const u = new URL(v, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Legge una pagina. `isInternal` dice se un host è del sito in esame (per contare link interni ed esterni).
 * `pageUrl` è l'indirizzo finale della risposta: i link relativi si risolvono rispetto a quello, o a <base href>.
 */
export function extractPage(html: string, pageUrl: string, isInternal: (hostname: string) => boolean): Extraction {
  const $ = load(html);
  let base = pageUrl;
  const baseHref = absolute($('base[href]').first().attr('href'), pageUrl);
  if (baseHref) base = baseHref;

  const titles = $('head > title, title').filter((_, el) => !$(el).parents('svg').length);
  const descs = $('meta[name="description" i]');
  const robots = new Set<string>();
  $('meta[name="robots" i], meta[name="googlebot" i]').each((_, el) => {
    for (const d of ($(el).attr('content') ?? '').toLowerCase().split(',')) if (d.trim()) robots.add(d.trim());
  });

  const canonicals: string[] = [];
  let canonicalInBody = 0;
  $('link[rel]').each((_, el) => {
    if (!/(^|\s)canonical(\s|$)/i.test($(el).attr('rel') ?? '')) return;
    if ($(el).parents('body').length) {
      canonicalInBody++;
      return;
    }
    const href = absolute($(el).attr('href'), base);
    // href vuoto o non valido: conta come canonical presente ma inutilizzabile
    canonicals.push(href ?? '');
  });

  const hreflang: { lang: string; href: string }[] = [];
  $('link[rel][hreflang]').each((_, el) => {
    if (!/(^|\s)alternate(\s|$)/i.test($(el).attr('rel') ?? '')) return;
    const href = absolute($(el).attr('href'), base);
    if (href) hreflang.push({ lang: ($(el).attr('hreflang') ?? '').trim().toLowerCase(), href });
  });

  const headings: [number, string][] = [];
  $('h1, h2, h3, h4, h5, h6').each((_, el) => {
    const t = collapse($(el).text()) || collapse($(el).find('img[alt]').first().attr('alt'));
    if (headings.length < 200) headings.push([Number(el.tagName[1]), t.slice(0, 200)]);
  });

  const links: PageLink[] = [];
  let internal = 0;
  let external = 0;
  let nofollow = 0;
  $('a[href]').each((_, el) => {
    const raw = ($(el).attr('href') ?? '').trim();
    if (!raw || raw.startsWith('#') || SKIP.test(raw)) return;
    const href = absolute(raw, base);
    if (!href) return;
    const rel = collapse($(el).attr('rel')).toLowerCase();
    const anchor = collapse($(el).text()) || collapse($(el).find('img[alt]').first().attr('alt')) || collapse($(el).attr('aria-label')) || collapse($(el).attr('title'));
    const within = $(el).closest('nav, [role="navigation"], header, footer, aside, main, [role="main"], article');
    const name = String(within.prop('tagName') ?? '').toLowerCase();
    const tag = within.length ? (within.attr('role') === 'navigation' ? 'nav' : within.attr('role') === 'main' || name === 'article' ? 'main' : name) : 'body';
    const link: PageLink = { href, anchor: anchor.slice(0, 300), rel, nofollow: /\bnofollow\b/.test(rel), placement: tag as Placement };
    links.push(link);
    if (isInternal(new URL(href).hostname)) internal++;
    else external++;
    if (link.nofollow) nofollow++;
  });

  const images: string[] = [];
  let missingAlt = 0;
  let emptyAlt = 0;
  let missingDims = 0;
  const imgs = $('img');
  imgs.each((_, el) => {
    const alt = $(el).attr('alt');
    if (alt === undefined) missingAlt++;
    else if (!alt.trim()) emptyAlt++;
    if (!$(el).attr('width') || !$(el).attr('height')) missingDims++;
    const src = absolute($(el).attr('src') ?? $(el).attr('data-src') ?? ($(el).attr('srcset') ?? '').split(',')[0]?.trim().split(/\s+/)[0], base);
    if (src && images.length < 500 && !images.includes(src)) images.push(src);
  });

  const visible = visibleText($);
  const main = mainContent($);
  const facts: PageFacts = {
    title: titles.length ? collapse(titles.first().text()) || null : null,
    title_count: titles.length,
    description: descs.length ? collapse(descs.first().attr('content')) || null : null,
    description_count: descs.length,
    canonicals,
    canonical_in_body: canonicalInBody,
    robots_meta: [...robots],
    h1: headings.filter((h) => h[0] === 1).map((h) => h[1]),
    headings,
    lang: collapse($('html').attr('lang')) || null,
    hreflang,
    viewport: collapse($('meta[name="viewport" i]').first().attr('content')) || null,
    word_count: main.words,
    content_container: main.container,
    content_hash: contentHash(main.text),
    content_simhash: simhash(main.text),
    links_internal: internal,
    links_external: external,
    links_nofollow: nofollow,
    images_count: imgs.length,
    images_missing_alt: missingAlt,
    images_empty_alt: emptyAlt,
    images_missing_dimensions: missingDims,
    schema: structuredData($, visible),
  };
  return { facts, links, images };
}

/** Problemi nella gerarchia dei titoli, in chiaro. */
export function headingIssues(f: Pick<PageFacts, 'headings' | 'h1'>): string[] {
  const out: string[] = [];
  if (!f.h1.length) out.push('H1 assente');
  else if (f.h1.length > 1) out.push(`${f.h1.length} H1`);
  if (f.h1.some((t) => !t)) out.push('H1 vuoto');
  if (f.headings.length && f.headings[0][0] !== 1 && f.h1.length) out.push(`il primo titolo è un H${f.headings[0][0]}, non l'H1`);
  const jumps = new Set<string>();
  for (let i = 1; i < f.headings.length; i++) {
    const [prev, cur] = [f.headings[i - 1][0], f.headings[i][0]];
    if (cur > prev + 1) jumps.add(`salto da H${prev} a H${cur}`);
  }
  out.push(...jumps);
  return out;
}
