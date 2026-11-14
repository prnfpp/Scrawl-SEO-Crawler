// Copiato da Scookie (prnfpp/Scookie---Scanner-Cookier, versione 0.1.2, commit f5bcd4a). Vedi src/scookie/LEGGIMI.md.
import type { Browser, LaunchOptions } from 'playwright';
import { closeSafely } from './misc.js';

/** Impostazioni del browser che servono per avviarlo. */
export interface LaunchConfig {
  browser: {
    headless: boolean;
    /** Solo per i test: regole di risoluzione degli host. */
    hostResolverRules?: string;
    uaNormale: boolean;
    canale: 'chromium' | 'chrome' | 'msedge';
    executablePath?: string;
    proxy?: string;
  };
}

/** Impostazioni da cui si ricava lo user agent dichiarato. */
export interface UserAgentConfig {
  browser: { userAgent?: string; userAgentSuffix: string; uaNormale: boolean };
}

export function launchOptions(cfg: LaunchConfig, headless = cfg.browser.headless): LaunchOptions {
  const args: string[] = [];
  if (cfg.browser.hostResolverRules) {
    // Solo per i test: tutti gli host puntano a 127.0.0.1 e la protezione della rete locale di Chromium
    // bloccherebbe le letture di robots.txt e sitemap fatte dal documento fittizio (vedi discovery).
    // I contenuti incorporati di prova sono serviti anche in HTTPS con un certificato autofirmato (test/fixtures/tls).
    args.push(`--host-resolver-rules=${cfg.browser.hostResolverRules}`, '--disable-features=LocalNetworkAccessChecks', '--ignore-certificate-errors');
  }
  // Esecuzione di controllo: navigator.webdriver resta false, come in un browser comune
  if (cfg.browser.uaNormale) args.push('--disable-blink-features=AutomationControlled');
  return {
    headless,
    args,
    channel: cfg.browser.canale === 'chromium' ? undefined : cfg.browser.canale,
    executablePath: cfg.browser.executablePath,
    proxy: cfg.browser.proxy ? { server: cfg.browser.proxy } : undefined,
  };
}

export async function resolveUserAgent(browser: Browser, cfg: UserAgentConfig): Promise<string> {
  if (cfg.browser.userAgent) return cfg.browser.userAgent;
  const ctx = await browser.newContext();
  const ua = await (await ctx.newPage()).evaluate(() => navigator.userAgent);
  await closeSafely(ctx, 15000);
  // Esecuzione di controllo: lo user agent di un browser qualunque, senza dichiarazione dell'audit
  if (cfg.browser.uaNormale) return ua.replace('HeadlessChrome', 'Chrome');
  return cfg.browser.userAgentSuffix ? `${ua} ${cfg.browser.userAgentSuffix}` : ua;
}
