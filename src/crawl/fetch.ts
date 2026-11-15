import { gunzipSync } from 'node:zlib';

export interface Hop {
  url: string;
  status: number;
  /** Destinazione dichiarata (Location risolta), per le risposte di redirect. */
  location: string | null;
  headers: Record<string, string>;
  ms: number;
}

export type RedirectType = 'nessuno' | 'singolo' | 'catena' | 'loop' | 'troppi';

export interface FetchResult {
  /** Una voce per ogni risposta ricevuta, nell'ordine: l'ultima è quella finale. */
  hops: Hop[];
  redirectType: RedirectType;
  /** Corpo della risposta finale, solo se è testo (HTML, XML, testo semplice). */
  body: string | null;
  /** Byte del corpo finale (dopo la decompressione). */
  bytes: number | null;
  /** True se il corpo superava il limite ed è stato troncato. */
  truncated: boolean;
  error: string | null;
}

export interface FetchOptions {
  userAgent: string;
  timeoutMs: number;
  maxRedirects?: number;
  maxBytes?: number;
  acceptLanguage?: string;
  signal?: AbortSignal;
  /** Non legge il corpo della risposta: basta sapere se l'indirizzo risponde (verifica dei link). */
  headersOnly?: boolean;
  /** Chiamata prima di ogni richiesta, anche dei passaggi di un redirect: qui si applicano le pause per host. */
  beforeRequest?: (url: string) => Promise<void>;
}

const TEXTUAL = /^(?:text\/|application\/(?:xhtml\+xml|xml|rss\+xml|atom\+xml|json|x-gzip|gzip))/i;

/** Messaggio leggibile per gli errori di rete di Node (il motivo vero è in "cause"). */
function describeError(e: unknown): string {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  if (err.name === 'TimeoutError') return 'nessuna risposta entro il tempo massimo';
  if (err.name === 'AbortError') return 'richiesta interrotta';
  const code = err.cause?.code ?? '';
  const map: Record<string, string> = {
    ENOTFOUND: 'host non trovato (DNS)',
    EAI_AGAIN: 'host non risolto (DNS)',
    ECONNREFUSED: 'connessione rifiutata',
    ECONNRESET: 'connessione chiusa dal server',
    ETIMEDOUT: 'connessione scaduta',
    UND_ERR_CONNECT_TIMEOUT: 'connessione scaduta',
    UND_ERR_HEADERS_TIMEOUT: 'intestazioni non ricevute in tempo',
    UND_ERR_SOCKET: 'connessione chiusa dal server',
    CERT_HAS_EXPIRED: 'certificato HTTPS scaduto',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'certificato HTTPS autofirmato',
    SELF_SIGNED_CERT_IN_CHAIN: 'certificato HTTPS non attendibile',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'catena del certificato HTTPS incompleta',
    ERR_TLS_CERT_ALTNAME_INVALID: 'certificato HTTPS non valido per questo host',
  };
  if (/^ERR_SSL_|^ERR_TLS_|EPROTO/.test(code)) return 'HTTPS non disponibile (errore nel collegamento sicuro)';
  return map[code] ?? (code ? `${code}: ${err.cause?.message ?? err.message}` : err.message);
}

/**
 * Richiesta HTTP senza JavaScript, con i redirect seguiti a mano: di ogni passaggio restano codice, destinazione e
 * intestazioni. È l'HTML "ricevuto dal server", quello che legge un crawler che non esegue script.
 * I cookie ricevuti lungo la catena vengono rimandati ai passaggi successivi (alcuni siti rimandano a sé stessi
 * dopo aver scritto un cookie: senza, sembrerebbe un loop).
 */
export async function fetchChain(startUrl: string, opts: FetchOptions): Promise<FetchResult> {
  const maxRedirects = opts.maxRedirects ?? 10;
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  const hops: Hop[] = [];
  const seen = new Set<string>();
  const cookies = new Map<string, string>();
  let url = startUrl;
  const done = (redirectType: RedirectType, extra: Partial<FetchResult> = {}): FetchResult => ({ hops, redirectType, body: null, bytes: null, truncated: false, error: null, ...extra });
  const typeOf = (): RedirectType => (hops.length <= 1 ? 'nessuno' : hops.length === 2 ? 'singolo' : 'catena');

  for (;;) {
    if (seen.has(url)) return done('loop', { error: `redirect in loop: torna a ${url}` });
    seen.add(url);
    await opts.beforeRequest?.(url);
    const started = Date.now();
    let res: Response;
    try {
      const signals = [AbortSignal.timeout(opts.timeoutMs), ...(opts.signal ? [opts.signal] : [])];
      res = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.any(signals),
        headers: {
          'user-agent': opts.userAgent,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': opts.acceptLanguage ?? 'it-IT,it;q=0.9,en;q=0.6',
          ...(cookies.size ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        },
      });
    } catch (e) {
      return done(typeOf(), { error: describeError(e) });
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (k !== 'set-cookie') headers[k] = v;
    });
    for (const c of res.headers.getSetCookie()) {
      const m = /^([^=;\s]+)=([^;]*)/.exec(c);
      if (m) cookies.set(m[1], m[2]);
    }
    const loc = res.headers.get('location');
    const isRedirect = res.status >= 300 && res.status < 400 && !!loc;
    let location: string | null = null;
    if (isRedirect) {
      try {
        const next = new URL(loc!, url);
        next.hash = '';
        location = next.toString();
      } catch {
        location = null;
      }
    }
    hops.push({ url, status: res.status, location, headers, ms: Date.now() - started });

    if (isRedirect && location) {
      await res.body?.cancel().catch(() => {});
      if (hops.length > maxRedirects) return done('troppi', { error: `più di ${maxRedirects} redirect di seguito` });
      url = location;
      continue;
    }

    const type = headers['content-type'] ?? '';
    if (opts.headersOnly || (type && !TEXTUAL.test(type))) {
      await res.body?.cancel().catch(() => {});
      const len = Number(headers['content-length']);
      return done(typeOf(), { bytes: Number.isFinite(len) && headers['content-length'] ? len : null });
    }
    try {
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      let truncated = false;
      if (reader) {
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end) break;
          size += value.byteLength;
          chunks.push(value);
          if (size > maxBytes) {
            truncated = true;
            await reader.cancel().catch(() => {});
            break;
          }
        }
      }
      let buf: Buffer = Buffer.concat(chunks);
      // Sitemap compresse servite come file (.xml.gz): il server non le dichiara come codifica del trasporto
      if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b && !truncated) {
        try {
          buf = gunzipSync(buf);
        } catch {
          // non era gzip valido: si tiene com'è
        }
      }
      const charset = /charset=["']?([\w-]+)/i.exec(type)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 2048).toString('latin1'))?.[1] ?? 'utf-8';
      let body: string;
      try {
        body = new TextDecoder(charset).decode(buf);
      } catch {
        body = buf.toString('utf8');
      }
      return done(typeOf(), { body, bytes: buf.length, truncated });
    } catch (e) {
      return done(typeOf(), { error: `corpo della risposta non letto: ${describeError(e)}` });
    }
  }
}
