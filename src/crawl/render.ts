import { chromium, type Browser } from 'playwright';
import { closeSafely, detectBotChallenge, launchOptions, resolveUserAgent, withTimeout } from 'scookie/engine';
import type { CrawlConfig } from '../config/schema.js';
import { TOOL_VERSION } from '../version.js';
import { TrackerBlocker } from './trackers.js';

export interface RenderedImage {
  url: string;
  bytes: number;
  type: string;
}

export interface RenderResult {
  /** Indirizzo nella barra dopo il caricamento (può cambiare per un redirect fatto da JavaScript). */
  final_url: string | null;
  status: number | null;
  /** DOM serializzato dopo l'esecuzione di JavaScript. */
  html: string | null;
  ms: number;
  error: string | null;
  /** Pagina di verifica anti-bot al posto del sito: il contenuto non è valido. */
  bot_block: string | null;
  /** Richieste di tracciamento fermate (prova che la visita non è arrivata agli analytics). */
  tracker_requests_blocked: number;
  images: RenderedImage[];
}

/**
 * Rendering con il browser di Scookie (stesso avvio e stesso user agent dichiarato). Ogni pagina si apre in un
 * profilo pulito, come una prima visita, con le richieste di tracciamento bloccate. Il banner di consenso non
 * viene mai accettato.
 */
export class Renderer {
  private constructor(
    private readonly browser: Browser,
    readonly userAgent: string,
    readonly browserVersion: string,
    private readonly cfg: CrawlConfig,
    private readonly blocker: TrackerBlocker | null,
  ) {}

  static async start(cfg: CrawlConfig): Promise<Renderer> {
    const browser = await chromium.launch(launchOptions({ browser: { headless: true, hostResolverRules: undefined, uaNormale: false, canale: cfg.rendering.canale, executablePath: undefined, proxy: undefined } }));
    const contact = cfg.cortesia.contatto ? ` (+${cfg.cortesia.contatto})` : '';
    const ua = await resolveUserAgent(browser, { browser: { userAgent: cfg.cortesia.userAgent, userAgentSuffix: `${cfg.cortesia.nomeCrawler}/${TOOL_VERSION}${contact}`, uaNormale: false } });
    // "HeadlessChrome" fa scattare molti filtri: lo strumento si dichiara già con il proprio nome in coda
    return new Renderer(browser, ua.replace('HeadlessChrome', 'Chrome'), browser.version(), cfg, cfg.rendering.bloccaTracker ? new TrackerBlocker(cfg.rendering.trackerExtra) : null);
  }

  async render(url: string): Promise<RenderResult> {
    const r = this.cfg.rendering;
    const started = Date.now();
    const out: RenderResult = { final_url: null, status: null, html: null, ms: 0, error: null, bot_block: null, tracker_requests_blocked: 0, images: [] };
    const context = await this.browser.newContext({ userAgent: this.userAgent, locale: 'it-IT', viewport: r.viewport, extraHTTPHeaders: { 'Accept-Language': 'it-IT,it;q=0.9,en;q=0.6' }, serviceWorkers: 'block' });
    const pending: Promise<void>[] = [];
    try {
      if (this.blocker) {
        await context.route('**/*', (route) => {
          if (this.blocker!.blocks(route.request().url())) {
            out.tracker_requests_blocked++;
            return route.abort('blockedbyclient');
          }
          return route.continue();
        });
      }
      const page = await context.newPage();
      page.on('requestfinished', (req) => {
        if (req.resourceType() !== 'image' || out.images.length >= 300) return;
        pending.push(
          (async () => {
            const [sizes, res] = await Promise.all([req.sizes(), req.response()]);
            if (res && res.status() < 400) out.images.push({ url: req.url(), bytes: sizes.responseBodySize, type: (res.headers()['content-type'] ?? '').split(';')[0].trim().toLowerCase() });
          })().catch(() => {}),
        );
      });
      let response;
      try {
        response = await page.goto(url, { waitUntil: 'load', timeout: r.timeoutMs });
      } catch (e) {
        const msg = (e as Error).message.split('\n')[0];
        // Tempo scaduto in attesa di "load" (una risorsa lenta): il documento c'è, si legge comunque
        if (!/Timeout/i.test(msg) || !(await page.content().catch(() => ''))) {
          out.error = msg.replace(/^page\.goto: /, '');
          return out;
        }
        out.error = 'caricamento non completato entro il tempo massimo: letto ciò che era presente';
        response = null;
      }
      out.status = response?.status() ?? null;
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(r.attesaMs);
      const block = await detectBotChallenge(page, response ?? null).catch(() => null);
      if (block) {
        out.bot_block = `${block.provider}: ${block.signal}`;
        out.error = `accesso bloccato da ${block.provider}`;
        return out;
      }
      out.final_url = page.url();
      out.html = await withTimeout(page.content(), 20000, 'lettura del DOM');
      await Promise.race([Promise.all(pending), new Promise((ok) => setTimeout(ok, 3000))]);
    } catch (e) {
      out.error = (e as Error).message.split('\n')[0];
    } finally {
      out.ms = Date.now() - started;
      await closeSafely(context, 15000);
    }
    return out;
  }

  async close() {
    await closeSafely(this.browser, 15000);
  }
}
