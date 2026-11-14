import { load } from 'cheerio';

export interface RawLink {
  /** Indirizzo assoluto, senza frammento. */
  href: string;
  anchor: string;
  rel: string;
  nofollow: boolean;
}

/**
 * Link <a href> dell'HTML ricevuto dal server, risolti rispetto a <base href> se presente.
 * Passo 2: serve ad alimentare la coda. Dal passo 3 l'estrazione completa (posizione del link, confronto con il
 * DOM renderizzato) sostituisce questa funzione senza cambiare il formato di links.jsonl.
 */
export function extractLinks(html: string, pageUrl: string): RawLink[] {
  const $ = load(html);
  let base = pageUrl;
  const baseHref = $('base[href]').first().attr('href');
  if (baseHref) {
    try {
      base = new URL(baseHref, pageUrl).toString();
    } catch {
      // <base> non valido: si usa l'indirizzo della pagina
    }
  }
  const out: RawLink[] = [];
  $('a[href]').each((_, el) => {
    const raw = ($(el).attr('href') ?? '').trim();
    if (!raw || raw.startsWith('#') || /^(?:javascript|mailto|tel|sms|data|whatsapp|skype|callto|fax):/i.test(raw)) return;
    let href: string;
    try {
      const u = new URL(raw, base);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
      u.hash = '';
      href = u.toString();
    } catch {
      return;
    }
    const rel = ($(el).attr('rel') ?? '').toLowerCase().trim();
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    // Link fatto solo da un'immagine: il testo di ancoraggio è il suo testo alternativo
    const anchor = text || ($(el).find('img[alt]').first().attr('alt') ?? '').trim() || ($(el).attr('aria-label') ?? '').trim();
    out.push({ href, anchor: anchor.slice(0, 300), rel, nofollow: /\bnofollow\b/.test(rel) });
  });
  return out;
}
