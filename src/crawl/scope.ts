import { hostMatches, registrableDomain } from '../scookie/index.js';
import type { CrawlConfig } from '../config/schema.js';

/** Risorse che non sono pagine: restano tra i link, ma non entrano nella coda. */
const NOT_A_PAGE = /\.(?:pdf|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|zip|rar|7z|gz|docx?|xlsx?|pptx?|csv|mp4|webm|mov|avi|mp3|wav|ogg|xml|txt|json|css|js|mjs|map|woff2?|ttf|eot|dmg|exe|apk|ics|vcf)$/i;

export type ScopeReason = 'altro-dominio' | 'sottodominio-escluso' | 'non-incluso' | 'escluso' | 'non-pagina' | 'protocollo';

export const SCOPE_LABEL: Record<ScopeReason, string> = {
  'altro-dominio': 'altro dominio',
  'sottodominio-escluso': 'sottodominio fuori perimetro',
  'non-incluso': 'fuori dalle cartelle incluse',
  escluso: 'cartella esclusa',
  'non-pagina': 'file che non è una pagina',
  protocollo: 'indirizzo non http(s)',
};

const bare = (h: string) => h.replace(/^www\./, '');

/**
 * Indirizzo in forma canonica per la coda: schema e host minuscoli, senza frammento, senza porta predefinita e senza
 * i parametri di tracciamento. Barra finale, maiuscole del percorso e ordine dei parametri restano come sono:
 * le varianti sono un dato da rilevare, non da nascondere.
 */
export function normalizeUrl(raw: string, base: string | undefined, ignoredParams: string[]): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim(), base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.username = '';
  u.password = '';
  if (u.search) {
    const exact = new Set<string>();
    const prefixes: string[] = [];
    for (const p of ignoredParams) (p.endsWith('*') ? prefixes.push(p.slice(0, -1).toLowerCase()) : exact.add(p.toLowerCase()));
    const kept = [...u.searchParams.entries()].filter(([k]) => {
      const key = k.toLowerCase();
      return !exact.has(key) && !prefixes.some((p) => key.startsWith(p));
    });
    if (kept.length !== [...u.searchParams.keys()].length) {
      u.search = kept.length ? `?${kept.map(([k, v]) => (v === '' ? encodeURIComponent(k) : `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)).join('&')}` : '';
    }
  }
  return u.toString();
}

export class Scope {
  /** Host di partenza (senza www) di ogni punto di partenza. */
  readonly hosts: Set<string>;
  private readonly domains: Set<string>;
  private readonly extraHosts: string[];
  private readonly include: RegExp[];
  private readonly exclude: RegExp[];

  constructor(
    private readonly cfg: CrawlConfig,
    seeds: string[],
  ) {
    this.hosts = new Set(seeds.map((s) => bare(new URL(s).hostname.toLowerCase())));
    this.domains = new Set([...this.hosts].map((h) => registrableDomain(h)));
    this.extraHosts = Array.isArray(cfg.perimetro.sottodomini) ? cfg.perimetro.sottodomini.map((h) => bare(h.toLowerCase())) : [];
    this.include = cfg.perimetro.includi.map((r) => new RegExp(r, 'i'));
    this.exclude = cfg.perimetro.escludi.map((r) => new RegExp(r, 'i'));
  }

  normalize(raw: string, base?: string): string | null {
    return normalizeUrl(raw, base, this.cfg.perimetro.parametriIgnorati);
  }

  /** True se l'host appartiene al sito in esame (per distinguere link interni ed esterni). */
  isInternalHost(hostname: string): boolean {
    return this.hostReason(hostname) === null;
  }

  private hostReason(hostname: string): ScopeReason | null {
    const h = bare(hostname.toLowerCase());
    if (this.hosts.has(h) || this.extraHosts.some((x) => hostMatches(h, x))) return null;
    if (!this.domains.has(registrableDomain(h))) return 'altro-dominio';
    return this.cfg.perimetro.sottodomini === 'includi' ? null : 'sottodominio-escluso';
  }

  /** Null se l'indirizzo va scansionato, altrimenti il motivo per cui resta fuori. */
  reason(url: string): ScopeReason | null {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return 'protocollo';
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'protocollo';
    const host = this.hostReason(u.hostname);
    if (host) return host;
    if (NOT_A_PAGE.test(u.pathname)) return 'non-pagina';
    const path = u.pathname + u.search;
    if (this.exclude.some((re) => re.test(path))) return 'escluso';
    if (this.include.length && !this.include.some((re) => re.test(path))) return 'non-incluso';
    return null;
  }
}
