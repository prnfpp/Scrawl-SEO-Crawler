import type { SiteReport } from './site.js';

export type Level = 'ok' | 'attenzione' | 'problema' | 'info' | 'non-verificato';

/** Una voce dei controlli di sito, pronta da mostrare: esito, una frase, qualche esempio. */
export interface SiteItem {
  area: 'Traffico' | 'Dominio' | 'robots.txt' | 'Sitemap' | 'Link' | 'Duplicati' | 'Lingue' | 'GEO';
  title: string;
  level: Level;
  text: string;
  details: string[];
}

const n = (x: number, one: string, many: string) => (x === 1 ? `1 ${one}` : `${x.toLocaleString('it-IT')} ${many}`);

/**
 * Riepilogo leggibile dei controlli di sito. Descrive ciò che è stato trovato; non dice cosa fare
 * (raccomandazioni e priorità sono della skill SEO).
 */
export function siteSummary(s: SiteReport): SiteItem[] {
  const out: SiteItem[] = [];
  const c = s.checks;

  // --- traffico (Search Console e GA4) ---
  const t = s.traffic;
  if (t?.available) {
    const period = t.period ? ` dal ${t.period.start} al ${t.period.end}` : '';
    const src = [t.gsc ? `Search Console (${n(t.gsc.urls, 'indirizzo', 'indirizzi')}, ${t.gsc.clicks.toLocaleString('it-IT')} clic)` : '', t.ga4 ? `GA4 (${n(t.ga4.paths, 'percorso', 'percorsi')}, ${t.ga4.organic_sessions.toLocaleString('it-IT')} sessioni dalla ricerca organica)` : ''].filter(Boolean).join(' e ');
    out.push({ area: 'Traffico', title: 'Dati incrociati', level: 'info', text: `${src}${period}.${t.gsc && t.gsc.clicks ? ` Le pagine visitate coprono il ${Math.round((t.gsc.matched_clicks / t.gsc.clicks) * 100)}% dei clic.` : ''}`, details: [] });
    const w = t.with_traffic_not_indexable;
    out.push({ area: 'Traffico', title: 'Pagine con traffico ma non indicizzabili', level: w.count ? 'problema' : 'ok', text: w.count ? `${n(w.count, 'pagina riceve', 'pagine ricevono')} impression o traffico ma ${w.count === 1 ? 'non è indicizzabile' : 'non sono indicizzabili'}, in errore o in redirect: ${w.clicks.toLocaleString('it-IT')} clic e ${w.impressions.toLocaleString('it-IT')} impression nel periodo.` : 'Nessuna pagina con impression o traffico risulta non indicizzabile, in errore o in redirect.', details: [...Object.entries(w.by_reason).sort((a, b) => b[1].clicks - a[1].clicks).map(([r, x]) => `${r}: ${n(x.pages, 'pagina', 'pagine')}, ${x.clicks.toLocaleString('it-IT')} clic`), ...w.examples.slice(0, 10).map((e) => `${e.url} — ${e.clicks.toLocaleString('it-IT')} clic, ${e.impressions.toLocaleString('it-IT')} impression — ${e.reason}`)] });
    if (t.gsc) {
      const z = t.indexable_without_impressions;
      out.push({ area: 'Traffico', title: 'Pagine indicizzabili senza impression', level: z.count ? 'attenzione' : 'ok', text: z.count ? `${n(z.count, 'pagina indicizzabile non ha avuto', 'pagine indicizzabili non hanno avuto')} impression nel periodo (${Math.round(z.share * 100)}% delle indicizzabili).` : 'Tutte le pagine indicizzabili hanno avuto impression nel periodo.', details: z.examples.slice(0, 10) });
      const m = t.in_gsc_not_crawled;
      out.push({ area: 'Traffico', title: 'In Search Console ma non visitate', level: m.count ? 'non-verificato' : 'ok', text: m.count ? `${n(m.count, 'indirizzo con impression non è stato visitato', 'indirizzi con impression non sono stati visitati')} dalla scansione (fuori perimetro, oltre i limiti, o dati aggiunti a scansione finita): ${m.clicks.toLocaleString('it-IT')} clic.` : 'Tutti gli indirizzi di Search Console sono stati visitati.', details: m.examples.slice(0, 10).map((e) => `${e.url} — ${e.clicks.toLocaleString('it-IT')} clic, ${e.impressions.toLocaleString('it-IT')} impression`) });
    }
  } else {
    out.push({ area: 'Traffico', title: 'Search Console e GA4', level: 'non-verificato', text: 'Dati di traffico non forniti: i problemi non sono pesati sul traffico reale delle pagine.', details: [] });
  }

  // --- dominio ---
  if (c) {
    const v = c.domain_variants;
    out.push({ area: 'Dominio', title: 'Versioni del dominio', level: !v.destinations.length ? 'non-verificato' : !v.consistent ? 'problema' : !v.https ? 'attenzione' : 'ok', text: v.note.charAt(0).toUpperCase() + v.note.slice(1), details: v.variants.map((x) => `${x.url} → ${x.status ?? x.error ?? 'nessuna risposta'}${x.final_url && x.final_url !== x.url ? ` ${x.final_url}` : ''}${x.hops > 1 ? ` (${x.hops} redirect)` : ''}`) });
    if (c.trailing_slash) out.push({ area: 'Dominio', title: 'Barra finale', level: c.trailing_slash.behaviour === 'duplicato' ? 'attenzione' : c.trailing_slash.behaviour === 'non-verificato' ? 'non-verificato' : 'ok', text: `Provata ${c.trailing_slash.variant}: ${c.trailing_slash.note}.`, details: [] });
    out.push({ area: 'Dominio', title: 'Pagina 404', level: c.not_found.correct ? 'ok' : c.not_found.status === null ? 'non-verificato' : 'problema', text: `${c.not_found.note.charAt(0).toUpperCase()}${c.not_found.note.slice(1)}.`, details: [c.not_found.url] });
  } else {
    out.push({ area: 'Dominio', title: 'Versioni del dominio, barra finale, pagina 404', level: 'non-verificato', text: 'Controlli non eseguiti in questa scansione.', details: [] });
  }

  // --- robots.txt ---
  if (c) {
    const r = c.robots;
    out.push({ area: 'robots.txt', title: 'File e sintassi', level: !r.found ? (r.status !== null && r.status >= 500 ? 'problema' : 'info') : r.problems.length ? 'attenzione' : 'ok', text: !r.found ? `robots.txt non presente o non leggibile (risposta ${r.status ?? 'assente'}): nessuna regola per i crawler.` : r.problems.length ? `${n(r.problems.length, 'riga non riconosciuta', 'righe non riconosciute')} in robots.txt.` : `robots.txt letto, ${n(r.groups, 'gruppo di regole', 'gruppi di regole')}, sintassi corretta.`, details: r.problems.slice(0, 10).map((p) => `riga ${p.line}: ${p.problem} — ${p.text}`) });
    out.push({ area: 'robots.txt', title: 'Sitemap dichiarata', level: r.sitemaps.length ? 'ok' : r.found ? 'attenzione' : 'info', text: r.sitemaps.length ? `${n(r.sitemaps.length, 'sitemap dichiarata', 'sitemap dichiarate')} in robots.txt.` : 'Nessuna sitemap dichiarata in robots.txt.', details: r.sitemaps });
  }
  out.push({ area: 'robots.txt', title: 'Risorse bloccate', level: s.robots.blocked_assets.count ? 'problema' : 'ok', text: s.robots.blocked_assets.count ? `${n(s.robots.blocked_assets.count, 'foglio di stile o script usato dalle pagine è vietato', 'fogli di stile o script usati dalle pagine sono vietati')} a Googlebot: la pagina può essere resa in modo diverso da come la vede una persona.` : 'Nessun foglio di stile o script usato dalle pagine è vietato a Googlebot.', details: s.robots.blocked_assets.examples });
  const linked = s.robots.blocked_sections;
  out.push({ area: 'robots.txt', title: 'Sezioni bloccate', level: linked.some((x) => x.in_sitemap) ? 'problema' : linked.length ? 'info' : 'ok', text: linked.length ? `${n(linked.reduce((a, x) => a + x.pages, 0), 'pagina vietata', 'pagine vietate')} da robots.txt ma ${linked.reduce((a, x) => a + x.pages, 0) === 1 ? 'raggiunta' : 'raggiunte'} dai link del sito${linked.some((x) => x.in_sitemap) ? `, di cui ${linked.reduce((a, x) => a + x.in_sitemap, 0)} anche in sitemap` : ''}.` : 'Nessuna pagina linkata dal sito è vietata da robots.txt.', details: linked.slice(0, 10).map((x) => `${x.section}: ${n(x.pages, 'pagina', 'pagine')} (es. ${x.examples[0]})`) });

  // --- sitemap ---
  const sm = s.sitemap;
  const badFiles = sm.files.filter((f) => f.error);
  if (!sm.files.length) out.push({ area: 'Sitemap', title: 'Sitemap', level: 'attenzione', text: 'Nessuna sitemap trovata o letta.', details: [] });
  else {
    out.push({ area: 'Sitemap', title: 'Lettura', level: badFiles.length ? 'problema' : 'ok', text: `${n(sm.files.length, 'file letto', 'file letti')}, ${n(sm.entries, 'indirizzo', 'indirizzi')}${badFiles.length ? `; ${n(badFiles.length, 'file non leggibile', 'file non leggibili')}` : ''}.`, details: badFiles.map((f) => `${f.url}: ${f.error}`) });
    out.push({ area: 'Sitemap', title: 'Indirizzi non indicizzabili in sitemap', level: sm.non_indexable.count ? 'problema' : 'ok', text: sm.non_indexable.count ? `${n(sm.non_indexable.count, 'indirizzo in sitemap non è indicizzabile', 'indirizzi in sitemap non sono indicizzabili')}: ${Object.entries(sm.non_indexable.by_reason).map(([k, v]) => `${v} ${k}`).join(', ')}.` : 'Tutti gli indirizzi in sitemap visitati sono indicizzabili.', details: sm.non_indexable.examples.slice(0, 10).map((e) => `${e.url} — ${e.reason}`) });
    out.push({ area: 'Sitemap', title: 'Pagine indicizzabili assenti dalla sitemap', level: sm.indexable_missing.count ? 'attenzione' : 'ok', text: sm.indexable_missing.count ? `${n(sm.indexable_missing.count, 'pagina indicizzabile non è', 'pagine indicizzabili non sono')} in sitemap.` : 'Tutte le pagine indicizzabili trovate sono in sitemap.', details: sm.indexable_missing.examples.slice(0, 10) });
    out.push({ area: 'Sitemap', title: 'Date di modifica', level: sm.lastmod.invalid || sm.lastmod.future ? 'problema' : /stessa data|nessuna data/.test(sm.lastmod.note) ? 'attenzione' : 'ok', text: `${sm.lastmod.note.charAt(0).toUpperCase()}${sm.lastmod.note.slice(1)}.`, details: [] });
    if (sm.not_crawled.count) out.push({ area: 'Sitemap', title: 'Indirizzi in sitemap non visitati', level: 'non-verificato', text: `${n(sm.not_crawled.count, 'indirizzo in sitemap non è stato visitato', 'indirizzi in sitemap non sono stati visitati')} (fuori perimetro o oltre i limiti della scansione).`, details: sm.not_crawled.examples.slice(0, 10) });
  }

  // --- link ---
  const l = s.links;
  const tl = (t: { url: string; status: number | null; sources: number; example_source: string; error?: string | null }) => `${t.url} (${t.status ?? t.error ?? 'nessuna risposta'}) — linkata da ${n(t.sources, 'pagina', 'pagine')}, es. ${t.example_source}`;
  out.push({ area: 'Link', title: 'Link interni verso pagine in errore', level: l.internal_to_error.links ? 'problema' : 'ok', text: l.internal_to_error.links ? `${n(l.internal_to_error.links, 'link interno porta', 'link interni portano')} a ${n(l.internal_to_error.targets.length, 'indirizzo in errore', 'indirizzi in errore')}.` : 'Nessun link interno verso pagine o file in errore.', details: l.internal_to_error.targets.slice(0, 10).map(tl) });
  out.push({ area: 'Link', title: 'Link interni verso redirect', level: l.internal_to_redirect.links ? 'attenzione' : 'ok', text: l.internal_to_redirect.links ? `${n(l.internal_to_redirect.links, 'link interno passa', 'link interni passano')} da un redirect (${n(l.internal_to_redirect.targets.length, 'indirizzo', 'indirizzi')}).` : 'Nessun link interno passa da un redirect.', details: l.internal_to_redirect.targets.slice(0, 10).map(tl) });
  out.push({ area: 'Link', title: 'Link esterni rotti', level: l.external_broken.links ? 'attenzione' : l.external_checked ? 'ok' : 'non-verificato', text: !l.external_checked ? 'Link esterni non verificati in questa scansione.' : `${l.external_broken.links ? `${n(l.external_broken.links, 'link porta', 'link portano')} a ${n(l.external_broken.targets.length, 'indirizzo esterno che non risponde', 'indirizzi esterni che non rispondono')}` : 'Nessun link esterno rotto'} su ${n(l.external_checked, 'indirizzo esterno verificato', 'indirizzi esterni verificati')}${l.external_unverifiable ? `; ${n(l.external_unverifiable, 'sito rifiuta', 'siti rifiutano')} i crawler e non è verificabile` : ''}.`, details: l.external_broken.targets.slice(0, 10).map(tl) });
  out.push({ area: 'Link', title: 'Pagine orfane', level: !s.orphans.applicable ? 'non-verificato' : s.orphans.count ? 'attenzione' : 'ok', text: !s.orphans.applicable ? `${s.orphans.note.charAt(0).toUpperCase()}${s.orphans.note.slice(1)}.` : s.orphans.count ? `${n(s.orphans.count, 'pagina è nota', 'pagine sono note')} dalla sitemap o dall'elenco ma non ${s.orphans.count === 1 ? 'è raggiungibile' : 'sono raggiungibili'} seguendo i link.` : 'Tutte le pagine visitate sono raggiungibili seguendo i link.', details: s.orphans.examples.slice(0, 10) });

  // --- duplicati ---
  const d = s.duplicates;
  const g = (x: { value: string; count: number; urls: string[] }) => `"${x.value.slice(0, 80)}" — ${n(x.count, 'pagina', 'pagine')}: ${x.urls.slice(0, 3).join(', ')}`;
  out.push({ area: 'Duplicati', title: 'Title doppi', level: d.titles.length ? 'attenzione' : 'ok', text: d.titles.length ? `${n(d.titles.length, 'title è usato', 'title sono usati')} da più pagine indicizzabili (${d.titles.reduce((a, x) => a + x.count, 0)} pagine).` : 'Nessun title ripetuto tra le pagine indicizzabili.', details: d.titles.slice(0, 10).map(g) });
  out.push({ area: 'Duplicati', title: 'Description doppie', level: d.descriptions.length ? 'attenzione' : 'ok', text: d.descriptions.length ? `${n(d.descriptions.length, 'description è usata', 'description sono usate')} da più pagine indicizzabili.` : 'Nessuna description ripetuta tra le pagine indicizzabili.', details: d.descriptions.slice(0, 10).map(g) });
  out.push({ area: 'Duplicati', title: 'Contenuti duplicati', level: d.content.length ? 'problema' : d.near.length ? 'attenzione' : 'ok', text: d.content.length || d.near.length ? `${d.content.length ? `${n(d.content.length, 'gruppo di pagine con contenuto identico', 'gruppi di pagine con contenuto identico')}` : ''}${d.content.length && d.near.length ? '; ' : ''}${d.near.length ? `${n(d.near.length, 'gruppo di pagine quasi uguali', 'gruppi di pagine quasi uguali')}` : ''}.` : 'Nessun contenuto duplicato o quasi duplicato tra le pagine indicizzabili.', details: [...d.content.slice(0, 5).map((x) => `identiche: ${x.urls.slice(0, 4).join(', ')}`), ...d.near.slice(0, 5).map((x) => `quasi uguali: ${x.urls.slice(0, 4).join(', ')}`)] });
  const dupParams = s.parameters.filter((p) => p.duplicates);
  out.push({ area: 'Duplicati', title: 'Parametri di URL', level: dupParams.length ? 'attenzione' : s.parameters.length ? 'info' : 'ok', text: !s.parameters.length ? 'Nessun indirizzo con parametri tra quelli visitati.' : `${n(s.parameters.length, 'parametro trovato', 'parametri trovati')} negli indirizzi${dupParams.length ? `; ${dupParams.map((p) => p.name).join(', ')} ${dupParams.length === 1 ? 'genera' : 'generano'} copie della pagina senza parametro` : ', nessuno genera copie'}.`, details: s.parameters.slice(0, 10).map((p) => `${p.name}: ${n(p.urls, 'indirizzo', 'indirizzi')}, ${n(p.duplicates, 'copia', 'copie')} (es. ${p.examples[0]})`) });
  if (s.pagination.pages) out.push({ area: 'Duplicati', title: 'Paginazione', level: s.pagination.canonical_to_other ? 'attenzione' : 'info', text: `${n(s.pagination.pages, 'pagina di paginazione', 'pagine di paginazione')}${s.pagination.canonical_to_other ? `; ${s.pagination.canonical_to_other} con canonical verso un'altra pagina: il loro contenuto non viene indicizzato` : ''}${s.pagination.noindex ? `; ${s.pagination.noindex} in noindex` : ''}.`, details: s.pagination.examples.slice(0, 5) });

  // --- lingue ---
  const h = s.hreflang;
  out.push({ area: 'Lingue', title: 'Hreflang', level: !h.pages ? 'info' : h.not_reciprocal || h.invalid_codes.length ? 'problema' : 'ok', text: !h.pages ? 'Nessuna pagina dichiara versioni in altre lingue (hreflang).' : `${n(h.pages, 'pagina dichiara', 'pagine dichiarano')} versioni in lingua (${Object.keys(h.languages).join(', ')})${h.not_reciprocal ? `; ${n(h.not_reciprocal, 'pagina ha', 'pagine hanno')} riferimenti senza ritorno o verso pagine non indicizzabili` : '; riferimenti reciproci dove verificabili'}${h.invalid_codes.length ? `; codici non validi: ${h.invalid_codes.join(', ')}` : ''}.`, details: h.examples.slice(0, 10).map((e) => `${e.url} — ${e.issue}`) });

  // --- GEO ---
  if (c) {
    const ai = c.ai_crawlers.elenco;
    const blocked = ai.filter((x) => x.accesso === 'bloccato');
    const partial = ai.filter((x) => x.accesso === 'parziale' && x.regole_da === 'gruppo proprio');
    const searchBlocked = blocked.filter((x) => x.scopo === 'ricerca');
    out.push({ area: 'GEO', title: 'Crawler dei motori AI', level: searchBlocked.length ? 'problema' : blocked.length || partial.length ? 'info' : 'ok', text: blocked.length ? `robots.txt blocca ${blocked.map((x) => x.nome).join(', ')}${searchBlocked.length ? `: tra questi ${searchBlocked.map((x) => x.nome).join(', ')} ${searchBlocked.length === 1 ? 'serve' : 'servono'} alla ricerca con fonti, quindi il sito non può essere citato da quel motore` : ' (crawler di addestramento o interruttori d\'uso: è una scelta, non un errore)'}.` : `Nessun crawler AI è bloccato del tutto${partial.length ? `; regole specifiche per ${partial.map((x) => x.nome).join(', ')}` : ''}. Elenco verificato il ${c.ai_crawlers.verificato_il}.`, details: ai.map((x) => `${x.nome} (${x.azienda}, ${x.scopo}): ${x.accesso}${x.disallow.length && x.accesso !== 'bloccato' ? ` — vietato: ${x.disallow.slice(0, 5).join(', ')}` : ''}${x.rispetta === 'no' ? ' — il fornitore dichiara che può ignorare robots.txt' : ''}${x.verificato === 'no' ? ' — nome non verificato sulla documentazione' : ''}`) });
    const llms = c.llms_txt.filter((x) => x.found);
    out.push({ area: 'GEO', title: 'llms.txt', level: 'info', text: llms.length ? `Presente: ${llms.map((x) => `${new URL(x.url).pathname} (${x.bytes} byte)`).join(', ')}.` : 'llms.txt non presente.', details: c.llms_txt.map((x) => `${x.url} → ${x.status ?? 'nessuna risposta'}`) });
  }
  const js = s.geo.content_without_js;
  out.push({ area: 'GEO', title: 'Contenuto leggibile senza JavaScript', level: !js.rendered_pages ? 'non-verificato' : js.pages_below_half ? 'problema' : (js.average_ratio ?? 1) < 0.9 ? 'attenzione' : 'ok', text: !js.rendered_pages ? 'Non misurato: nessuna pagina renderizzata con il browser.' : `In media il ${Math.round((js.average_ratio ?? 0) * 100)}% del contenuto principale è già nell'HTML del server (${n(js.rendered_pages, 'pagina confrontata', 'pagine confrontate')})${js.pages_below_half ? `; in ${n(js.pages_below_half, 'pagina', 'pagine')} meno della metà: i crawler AI, che in genere non eseguono JavaScript, lì leggono poco o nulla` : ''}.`, details: js.by_template.filter((t) => t.average_ratio < 1).slice(0, 10).map((t) => `${t.template}: ${Math.round(t.average_ratio * 100)}% su ${n(t.pages, 'pagina', 'pagine')}`) });
  return out;
}
