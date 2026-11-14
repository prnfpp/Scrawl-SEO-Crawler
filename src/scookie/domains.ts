// Copiato da Scookie (prnfpp/Scookie---Scanner-Cookier, versione 0.1.2, commit f5bcd4a). Vedi src/scookie/LEGGIMI.md.
import { getDomain, getHostname } from 'tldts';

/** Dominio registrabile (eTLD+1) di un host o URL; per host sconosciuti ritorna l'host stesso. */
export function registrableDomain(hostOrUrl: string): string {
  const host = hostOrUrl.includes('://') ? (getHostname(hostOrUrl) ?? hostOrUrl) : hostOrUrl;
  const clean = host.replace(/^\./, '').toLowerCase();
  return getDomain(clean, { allowPrivateDomains: true }) ?? clean;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** True se `host` coincide con `domain` o ne è un sottodominio. */
export function hostMatches(host: string, domain: string): boolean {
  const h = host.replace(/^\./, '').toLowerCase();
  const d = domain.replace(/^\./, '').toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}
