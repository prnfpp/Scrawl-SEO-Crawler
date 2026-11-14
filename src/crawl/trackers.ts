import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

interface Entry {
  dominio: string;
  categoria: string;
  percorsi?: string[];
  parametri?: string[];
}

/** Categorie dell'elenco di Scookie che registrano la visita: bloccate durante il rendering. */
const BLOCKED = new Set(['statistica', 'marketing', 'registrazione-sessioni']);

/**
 * Invii di dati riconoscibili dal percorso, anche sul dominio del cliente (tracciamento lato server, Matomo o
 * Plausible ospitati in proprio). Gli script che caricano i tag (gtm.js, gtag/js) NON sono bloccati: possono
 * scrivere contenuti o dati strutturati che un motore vede; senza l'invio dei dati non registrano nulla.
 */
const GENERIC = [/\/(?:g|j|r)\/collect(?:\?|$)/, /\/collect\?(?:.*&)?v=\d/, /\/(?:matomo|piwik)\.php(?:\?|$)/, /\/api\/event(?:\?|$)/, /\/ingest\/(?:e|batch|decide)\b/, /\/tr\/?\?(?:.*&)?id=\d/];

/**
 * Riconosce le richieste di tracciamento usando l'elenco di domini in data/trackers.yaml (aggiornabile lì, nato in Scookie)
 * più gli host indicati nella configurazione.
 */
export class TrackerBlocker {
  private readonly exact = new Map<string, Entry[]>();
  private readonly wild: { re: RegExp; entry: Entry }[] = [];
  private readonly extra: string[];

  constructor(extraHosts: string[] = []) {
    const data = parse(readFileSync(fileURLToPath(new URL('../../../data/trackers.yaml', import.meta.url)), 'utf8')) as { tracker: Entry[] };
    for (const e of data.tracker) {
      if (!BLOCKED.has(e.categoria)) continue;
      const d = e.dominio.toLowerCase();
      if (d === '*') continue; // strumenti ospitati sul sito: coperti dai percorsi generici
      if (d.includes('*')) this.wild.push({ re: new RegExp(`(^|\\.)${d.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]*')}$`), entry: e });
      else this.exact.set(d, [...(this.exact.get(d) ?? []), e]);
    }
    this.extra = extraHosts.map((h) => h.toLowerCase());
  }

  private matches(e: Entry, u: URL): boolean {
    if (e.percorsi?.length && !e.percorsi.some((p) => new RegExp(p).test(u.pathname))) return false;
    if (e.parametri?.length && !e.parametri.every((p) => new RegExp(p).test(u.search.slice(1)))) return false;
    return true;
  }

  blocks(url: string): boolean {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (this.extra.some((h) => host === h || host.endsWith(`.${h}`))) return true;
    // host e ogni suo dominio superiore: region1.google-analytics.com -> google-analytics.com
    const labels = host.split('.');
    for (let i = 0; i < labels.length - 1; i++) {
      for (const e of this.exact.get(labels.slice(i).join('.')) ?? []) if (this.matches(e, u)) return true;
    }
    for (const w of this.wild) if (w.re.test(host) && this.matches(w.entry, u)) return true;
    return GENERIC.some((re) => re.test(u.pathname + u.search));
  }
}
