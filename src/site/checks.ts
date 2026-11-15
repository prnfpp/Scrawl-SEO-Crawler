import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { FetchResult } from '../crawl/fetch.js';
import { groupsFor, robotsCheck, type Robots, type RobotsProblem } from '../crawl/robots.js';

export interface AiCrawler {
  nome: string;
  azienda: string;
  scopo: 'addestramento' | 'ricerca' | 'utente' | 'controllo';
  /** Ciò che il fornitore dichiara sul rispetto di robots.txt. */
  rispetta?: 'si' | 'no' | 'non dichiarato';
  fonte?: string;
  verificato?: string;
}

export function aiCrawlers(): { verificato_il: string; crawler: AiCrawler[] } {
  return parse(readFileSync(new URL('../../../data/ai-crawlers.yaml', import.meta.url), 'utf8')) as { verificato_il: string; crawler: AiCrawler[] };
}

export interface AiCrawlerAccess extends AiCrawler {
  /** consentito: nessuna regola lo ferma; bloccato: tutto il sito vietato; parziale: alcune sezioni vietate. */
  accesso: 'consentito' | 'bloccato' | 'parziale';
  /** Il file ha un gruppo scritto per questo crawler, oppure valgono le regole generali (*). */
  regole_da: 'gruppo proprio' | 'regole generali (*)' | 'nessuna regola';
  disallow: string[];
}

export interface VariantCheck {
  url: string;
  status: number | null;
  final_url: string | null;
  hops: number;
  error: string | null;
}

export interface SiteChecks {
  checked_at: string;
  origin: string;
  robots: { url: string; status: number | null; found: boolean; problems: RobotsProblem[]; sitemaps: string[]; groups: number };
  /** Le quattro versioni del dominio (http/https, con e senza www) e dove portano. */
  domain_variants: { variants: VariantCheck[]; destinations: string[]; consistent: boolean; https: boolean; note: string };
  /** Stessa pagina con e senza barra finale. */
  trailing_slash: { url: string; variant: string; status: number | null; final_url: string | null; behaviour: 'redirect' | 'duplicato' | 'errore' | 'non-verificato'; note: string } | null;
  not_found: { url: string; status: number | null; final_url: string | null; correct: boolean; note: string };
  llms_txt: { url: string; status: number | null; found: boolean; bytes: number | null }[];
  ai_crawlers: { verificato_il: string; elenco: AiCrawlerAccess[] };
}

export function aiAccess(robots: Robots | null): AiCrawlerAccess[] {
  return aiCrawlers().crawler.map((c) => {
    if (!robots) return { ...c, accesso: 'consentito' as const, regole_da: 'nessuna regola' as const, disallow: [] };
    const groups = groupsFor(robots, c.nome);
    const own = groups.some((g) => g.agents.some((a) => a !== '*'));
    const disallow = [...new Set(groups.flatMap((g) => g.rules.filter((r) => !r.allow).map((r) => r.pattern)))];
    const home = robotsCheck(robots, c.nome, '/').allowed;
    // "Disallow: /" con qualche Allow resta un blocco di fatto: lo si chiama parziale solo se la home passa
    const accesso = !disallow.length ? 'consentito' : !home || disallow.includes('/') || disallow.includes('/*') ? (home ? 'parziale' : 'bloccato') : 'parziale';
    return { ...c, accesso, regole_da: !groups.length ? 'nessuna regola' : own ? 'gruppo proprio' : 'regole generali (*)', disallow: disallow.slice(0, 30) };
  });
}

const last = (r: FetchResult) => r.hops.at(-1);
const bare = (h: string) => h.replace(/^www\./, '');

/**
 * Controlli che richiedono qualche richiesta in più, fatti una volta a fine scansione: versioni del dominio,
 * barra finale, pagina 404, llms.txt, accesso dei crawler AI. `get` usa le stesse pause del resto della scansione.
 */
export async function runSiteChecks(opts: {
  startUrl: string;
  robots: Robots | null;
  robotsStatus: number | null;
  /** Una pagina interna con risposta 200, per la prova della barra finale. */
  samplePage: string | null;
  get: (url: string, headersOnly?: boolean) => Promise<FetchResult>;
}): Promise<SiteChecks> {
  const start = new URL(opts.startUrl);
  const host = bare(start.hostname);
  const port = start.port ? `:${start.port}` : '';

  // --- versioni del dominio ---
  const urls = [...new Set([`http://${host}${port}/`, `http://www.${host}${port}/`, `https://${host}${port}/`, `https://www.${host}${port}/`])];
  // Host che non è un dominio (indirizzo IP, localhost): la versione www non esiste
  const candidates = /^(?:\d+\.){3}\d+$|^localhost$/.test(host) ? urls.filter((u) => !u.includes('//www.')) : urls;
  const variants: VariantCheck[] = [];
  for (const u of candidates) {
    const r = await opts.get(u, true);
    const l = last(r);
    variants.push({ url: u, status: l && !l.location ? l.status : null, final_url: l ? (l.location ?? l.url) : null, hops: Math.max(0, r.hops.length - 1), error: r.error });
  }
  const reachable = variants.filter((v) => v.status !== null && v.status < 400);
  const destinations = [...new Set(reachable.map((v) => v.final_url!))];
  const https = destinations.length > 0 && destinations.every((d) => d.startsWith('https://'));
  const unreachable = variants.filter((v) => v.status === null || v.status >= 400);
  const note = !reachable.length
    ? 'nessuna versione del dominio risponde'
    : destinations.length > 1
      ? `le versioni del dominio portano a ${destinations.length} indirizzi diversi: il sito è raggiungibile in più copie`
      : `${unreachable.length ? `${unreachable.length === 1 ? 'una versione non risponde' : `${unreachable.length} versioni non rispondono`}; le altre portano` : 'tutte le versioni portano'} a ${destinations[0]}${https ? '' : ' (non in HTTPS)'}${reachable.some((v) => v.hops > 1) ? ', alcune con più di un redirect' : ''}`;

  // --- barra finale ---
  let trailing: SiteChecks['trailing_slash'] = null;
  if (opts.samplePage) {
    const u = new URL(opts.samplePage);
    if (u.pathname.length > 1 && !u.search && !/\.[a-z0-9]{2,5}$/i.test(u.pathname)) {
      const v = new URL(u);
      v.pathname = u.pathname.endsWith('/') ? u.pathname.slice(0, -1) : `${u.pathname}/`;
      const r = await opts.get(v.toString(), true);
      const l = last(r);
      const status = l && !l.location ? l.status : null;
      const final = l ? (l.location ?? l.url) : null;
      const behaviour = status === null ? 'non-verificato' : r.hops.length > 1 && final === u.toString() ? 'redirect' : status >= 400 ? 'errore' : r.hops.length === 1 ? 'duplicato' : 'redirect';
      trailing = {
        url: u.toString(),
        variant: v.toString(),
        status,
        final_url: final,
        behaviour,
        note:
          behaviour === 'redirect'
            ? 'la variante rimanda alla versione corretta'
            : behaviour === 'duplicato'
              ? 'la variante risponde con una pagina propria: stessa pagina a due indirizzi (da verificare con il canonical)'
              : behaviour === 'errore'
                ? `la variante risponde ${status}: esiste una sola forma dell'indirizzo`
                : 'la variante non ha risposto',
      };
    }
  }

  // --- pagina 404 ---
  const missing = `${start.origin}/scrawl-pagina-inesistente-${Date.now().toString(36)}`;
  const nf = await opts.get(missing, true);
  const nl = last(nf);
  const nfStatus = nl && !nl.location ? nl.status : null;
  const nfFinal = nl ? (nl.location ?? nl.url) : null;
  const correct = nfStatus === 404 || nfStatus === 410;
  const not_found = {
    url: missing,
    status: nfStatus,
    final_url: nfFinal,
    correct,
    note: correct
      ? nf.hops.length > 1
        ? `risponde ${nfStatus}, ma dopo un redirect a ${nfFinal}`
        : `un indirizzo inesistente risponde ${nfStatus}`
      : nfStatus === null
        ? 'nessuna risposta alla prova'
        : nfStatus < 300
          ? `un indirizzo inesistente risponde ${nfStatus}${nf.hops.length > 1 ? ` dopo un redirect a ${nfFinal}` : ''}: le pagine che non esistono sembrano valide (soft 404)`
          : `un indirizzo inesistente risponde ${nfStatus}`,
  };

  // --- llms.txt ---
  const llms_txt: SiteChecks['llms_txt'] = [];
  for (const path of ['/llms.txt', '/llms-full.txt']) {
    const r = await opts.get(`${start.origin}${path}`);
    const l = last(r);
    const status = l && !l.location ? l.status : null;
    // Un sito che risponde 200 con la pagina HTML a qualsiasi indirizzo non ha un llms.txt
    const found = status === 200 && !!r.body && !/^\s*<(?:!doctype|html)/i.test(r.body) && !/html/i.test(l?.headers['content-type'] ?? '');
    llms_txt.push({ url: `${start.origin}${path}`, status, found, bytes: found ? r.bytes : null });
  }

  return {
    checked_at: new Date().toISOString(),
    origin: start.origin,
    robots: { url: `${start.origin}/robots.txt`, status: opts.robotsStatus, found: !!opts.robots, problems: opts.robots?.problems ?? [], sitemaps: opts.robots?.sitemaps ?? [], groups: opts.robots?.groups.length ?? 0 },
    domain_variants: { variants, destinations, consistent: destinations.length <= 1, https, note },
    trailing_slash: trailing,
    not_found,
    llms_txt,
    ai_crawlers: { verificato_il: aiCrawlers().verificato_il, elenco: aiAccess(opts.robots) },
  };
}
