// Copiato da Scookie (prnfpp/Scookie---Scanner-Cookier, versione 0.1.2, commit f5bcd4a). Vedi src/scookie/LEGGIMI.md.

export interface SampledPage {
  url: string;
  type: string;
  source: 'home' | 'extra' | 'sitemap' | 'link' | 'esplorazione';
}

/**
 * Tipo di pagina: prima i pattern della configurazione, poi il primo segmento del path.
 * La home è sempre "home".
 */
/** Primo segmento del percorso (saltando il prefisso lingua), per le URL con almeno due livelli: sono le "sezioni". */
export function sectionsOf(urls: string[]): Set<string> {
  const out = new Set<string>();
  for (const u of urls) {
    try {
      const all = new URL(u).pathname.split('/').filter(Boolean);
      const segs = /^[a-z]{2}(?:-[a-z]{2})?$/i.test(all[0] ?? '') ? all.slice(1) : all;
      if (segs.length > 1) out.add(segs[0].toLowerCase());
    } catch {
      // URL non valida
    }
  }
  return out;
}

/**
 * Tipo di pagina. Con `sections` (le sezioni che hanno sottopagine), le pagine a un solo livello che non sono
 * l'indice di una sezione si raggruppano in "pagina": senza, siti con indirizzi piatti avrebbero un tipo per pagina.
 */
export function pageType(url: string, patterns: Record<string, string>, sections?: Set<string>): string {
  const u = new URL(url);
  // Instradamento nel frammento (#/offerte): il percorso vero è nel frammento.
  const hashRoute = /^#!?\//.test(u.hash) ? u.hash.replace(/^#!?/, '') : '';
  const path = (u.pathname.replace(/\/+$/, '') + hashRoute).replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
  if (path === '/' || /^\/(?:index\.\w+|[a-z]{2}(?:-[a-z]{2})?)$/i.test(path)) return 'home';
  for (const [name, re] of Object.entries(patterns)) {
    if (new RegExp(re, 'i').test(u.pathname)) return name;
  }
  const all = path.split('/').filter(Boolean);
  // Salta il prefisso lingua (/it/, /en-gb/)
  const segs = /^[a-z]{2}(?:-[a-z]{2})?$/i.test(all[0] ?? '') ? all.slice(1) : all;
  const first = segs[0];
  if (!first) return 'altro';
  // Più livelli: il primo è la sezione (/blog/…, /prodotti/…)
  if (segs.length > 1) return first.toLowerCase().slice(0, 40);
  // Un solo livello con numeri o estensione (es. PrestaShop /10-nome.html, /16-categoria):
  // si raggruppa per forma, altrimenti ogni prodotto diventerebbe un tipo a sé.
  const ext = /\.[a-z0-9]{2,5}$/i.exec(first)?.[0].toLowerCase() ?? '';
  if (ext || /\d/.test(first)) return `${/\d/.test(first) ? 'numerata' : 'pagina'}${ext}`;
  // Pagina con nome pulito (chi-siamo, contatti): tipo a sé se è l'indice di una sezione, altrimenti "pagina"
  if (sections && !sections.has(first.toLowerCase())) return 'pagina';
  return first.toLowerCase().slice(0, 40);
}

/**
 * Campione deterministico: per ogni tipo, prende pagine equidistanti nell'elenco ordinato.
 * La stessa configurazione e lo stesso sito producono sempre lo stesso campione.
 */
export function sample(
  urls: { url: string; source: SampledPage['source'] }[],
  homeUrl: string,
  extras: string[],
  cfg: { perTipo: number; maxPagine: number; tipi: Record<string, string> },
): SampledPage[] {
  const sections = sectionsOf(urls.map((u) => u.url));
  const out: SampledPage[] = [{ url: homeUrl, type: 'home', source: 'home' }];
  const seen = new Set([homeUrl]);
  for (const e of extras) {
    if (seen.has(e)) continue;
    seen.add(e);
    out.push({ url: e, type: pageType(e, cfg.tipi, sections), source: 'extra' });
  }
  const groups = new Map<string, { url: string; source: SampledPage['source'] }[]>();
  for (const u of urls) {
    if (seen.has(u.url)) continue;
    const t = pageType(u.url, cfg.tipi, sections);
    if (t === 'home') continue;
    const g = groups.get(t) ?? [];
    if (!g.some((x) => x.url === u.url)) g.push(u);
    groups.set(t, g);
  }
  // Tipi più popolosi prima; poi alfabetico per stabilità.
  const types = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const picked = new Map<string, SampledPage[]>();
  for (const [type, list] of types) {
    list.sort((a, b) => a.url.localeCompare(b.url));
    // Si preparano più pagine di perTipo: servono a completare il campione se i tipi sono pochi.
    const n = Math.min(cfg.maxPagine, list.length);
    const step = list.length / n;
    picked.set(
      type,
      Array.from({ length: n }, (_, i) => ({ ...list[Math.floor(i * step)], type })),
    );
  }
  // Round-robin tra i tipi, così il campione resta vario: prima fino a perTipo pagine per tipo,
  // poi, se i tipi sono pochi, si completa fino a maxPagine.
  for (let round = 0; out.length < cfg.maxPagine; round++) {
    let added = false;
    for (const [, list] of picked) {
      if (out.length >= cfg.maxPagine) break;
      const p = list[round];
      if (p) {
        out.push(p);
        added = true;
      }
    }
    if (!added) break;
  }
  return out;
}
