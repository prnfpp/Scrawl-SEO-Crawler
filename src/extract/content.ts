import { createHash } from 'node:crypto';
import type { CheerioAPI } from 'cheerio';

/** Elementi che non sono contenuto leggibile. */
const NOT_TEXT = 'script, style, noscript, template, svg, iframe, object, embed, canvas, link, meta';
/** Parti ripetute della pagina, fuori dal contenuto principale. */
const CHROME = 'header, nav, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [role="dialog"], [aria-modal="true"]';
/** Banner di consenso più diffusi: il loro testo non è contenuto della pagina. */
export const CONSENT = '#onetrust-consent-sdk, #onetrust-banner-sdk, #CybotCookiebotDialog, #iubenda-cs-banner, .iubenda-cs-container, #cookie-law-info-bar, .cky-consent-container, .cmplz-cookiebanner, #cmplz-cookiebanner-container, .cc-window, #cc-main, #didomi-host, #usercentrics-root, #hs-eu-cookie-confirmation, [id^="cookie-banner"], [class^="cookie-banner"], [id^="cookiebanner"], [class^="cookiebanner"]';

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

export interface MainContent {
  /** Testo del contenuto principale, spazi ridotti. */
  text: string;
  words: number;
  /** Da dove è stato preso: main, article o body senza testata, menu e piè di pagina. */
  container: 'main' | 'article' | 'body';
}

/** Testo di tutta la pagina (senza script e stili), per i confronti con i dati strutturati. */
export function visibleText($: CheerioAPI): string {
  const body = $('body').clone();
  body.find(NOT_TEXT).remove();
  return collapse(body.text());
}

/**
 * Contenuto principale: <main> o [role=main] se ha testo, altrimenti l'<article> più lungo, altrimenti il body
 * senza testata, menu, piè di pagina, barre laterali e banner di consenso. Stessa regola sull'HTML del server e sul
 * DOM renderizzato, così i due conteggi sono confrontabili.
 */
export function mainContent($: CheerioAPI): MainContent {
  const textOf = (sel: ReturnType<CheerioAPI>, stripChrome: boolean) => {
    const c = sel.clone();
    c.find(NOT_TEXT).remove();
    c.find(CONSENT).remove();
    if (stripChrome) c.find(CHROME).remove();
    // I blocchi vanno separati: senza, "Titolo" e "Testo" di due elementi vicini si attaccano
    c.find('p, div, li, td, th, h1, h2, h3, h4, h5, h6, br, section, article, dd, dt, blockquote').append(' ');
    return collapse(c.text());
  };
  const count = (t: string) => (t.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) ?? []).length;
  const main = $('main, [role="main"]').first();
  if (main.length) {
    const text = textOf(main, true);
    if (count(text) >= 20) return { text, words: count(text), container: 'main' };
  }
  let best = '';
  $('article').each((_, el) => {
    const t = textOf($(el), true);
    if (t.length > best.length) best = t;
  });
  const body = textOf($('body'), true);
  // Un articolo vale come contenuto principale solo se è la parte prevalente della pagina (non una card in un elenco)
  if (count(best) >= 50 && best.length >= body.length * 0.5) return { text: best, words: count(best), container: 'article' };
  return { text: body, words: count(body), container: 'body' };
}

const norm = (text: string) => text.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();

/** Impronta del testo: uguale tra due pagine solo se il contenuto principale è identico. Vuota se non c'è testo. */
export function contentHash(text: string): string {
  const n = norm(text);
  return n ? createHash('sha1').update(n).digest('hex').slice(0, 16) : '';
}

const MASK = (1n << 64n) - 1n;
function fnv64(s: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 0x100000001b3n) & MASK;
  }
  return h;
}

/**
 * Simhash a 64 bit su terne di parole: due testi quasi uguali hanno impronte che differiscono in pochi bit.
 * Serve al passo 4 per i contenuti quasi duplicati. Vuoto sotto le 20 parole (troppo poco per un confronto).
 */
export function simhash(text: string): string {
  const words = norm(text).split(' ').filter(Boolean);
  if (words.length < 20) return '';
  const v = new Array<number>(64).fill(0);
  for (let i = 0; i + 2 < words.length; i++) {
    const h = fnv64(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
    for (let b = 0; b < 64; b++) v[b] += (h >> BigInt(b)) & 1n ? 1 : -1;
  }
  let out = 0n;
  for (let b = 0; b < 64; b++) if (v[b] > 0) out |= 1n << BigInt(b);
  return out.toString(16).padStart(16, '0');
}

/** Bit diversi tra due simhash (0 = uguali, 64 = opposti). */
export function simhashDistance(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}
