import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keepAwake, slug, timestampForPath } from '../scookie/index.js';
import { stringify } from 'yaml';
import { ConfigError, loadConfigText } from '../config/load.js';
import { Crawler, type Progress } from '../crawl/crawler.js';
import { RunStore, type RunState } from '../crawl/store.js';
import { siteSummary } from '../analyze/summary.js';
import { exportRun, loadPages, loadRun } from '../report/export.js';
import { parse as parseYaml } from 'yaml';
import { randomBytes } from 'node:crypto';
import { ga4Properties, gscSites } from '../google/api.js';
import { accessToken, authUrl, disconnect, exchangeCode, GoogleError, googleStatus, pkce, readCredentials, saveCredentials } from '../google/auth.js';
import { CsvError, fetchTraffic, parseGa4Csv, parseGscCsv, readTraffic, saveTraffic, type Traffic } from '../join/traffic.js';
import { zip } from '../util/zip.js';
import { TOOL_VERSION } from '../version.js';

export interface UiOptions {
  port: number;
  /** Cartella di lavoro: contiene clienti/ (configurazioni) e runs/ (risultati). */
  root: string;
  open?: boolean;
}

interface Active {
  id: string;
  dir: string;
  crawler: Crawler;
  progress: Progress | null;
  log: string[];
  release: () => void;
}

const UI_FILE = fileURLToPath(new URL('../../../ui/index.html', import.meta.url));

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 60_000_000) throw new HttpError(413, 'File troppo grande (oltre 60 MB)');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Dati non validi');
  }
}

/**
 * Interfaccia locale: una pagina servita solo su 127.0.0.1. Progetti (configurazioni dei clienti), scansione in
 * corso con avanzamento, pausa e ripresa, risultati consultabili. Una scansione alla volta.
 */
export async function startUi(opts: UiOptions): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const googleDir = join(opts.root, 'google');
  /** Collegamento a Google in corso: stato atteso e codice di verifica. */
  let pendingAuth: { state: string; verifier: string; redirect: string } | null = null;
  const clientsDir = join(opts.root, 'clienti');
  const runsDir = join(opts.root, 'runs');
  mkdirSync(clientsDir, { recursive: true });
  mkdirSync(runsDir, { recursive: true });
  let active: Active | null = null;
  const streams = new Set<ServerResponse>();

  const send = (event: string, data: unknown) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const s of streams) s.write(msg);
  };

  const safeName = (v: unknown) => {
    const name = slug(String(v ?? ''));
    if (!name || name === 'x') throw new HttpError(400, 'Nome del progetto non valido');
    return name;
  };
  const projectPath = (name: string) => join(clientsDir, `${name}.yaml`);

  /** Cartella di una scansione dal suo identificativo "cliente/data": mai fuori da runs/. */
  const runDirOf = (id: string) => {
    const dir = resolve(runsDir, id);
    if (!dir.startsWith(resolve(runsDir) + '/') && !dir.startsWith(resolve(runsDir) + '\\')) throw new HttpError(400, 'Scansione non valida');
    if (!RunStore.exists(dir)) throw new HttpError(404, 'Scansione non trovata');
    return dir;
  };

  const runInfo = (id: string, dir: string) => {
    const st = RunStore.readState(dir) as RunState;
    const live = active?.id === id;
    // "in corso" su disco senza una scansione viva: il programma è stato chiuso a metà, si può riprendere
    const status = !live && st.status === 'in-corso' ? 'interrotta' : st.status;
    let pages = 0;
    try {
      pages = readFileSync(join(dir, 'pagine.jsonl'), 'utf8').split('\n').filter(Boolean).length;
    } catch {
      // nessuna pagina ancora
    }
    return { id, project: id.split('/')[0], cliente: st.cliente, rendering: st.rendering ?? null, status, live, started_at: st.started_at, ended_at: st.ended_at, updated_at: st.updated_at, elapsed_s: st.elapsed_s, pages, not_reached: st.not_reached.count, limits: st.limits, notes: st.notes, sample: st.sample, exported: existsSync(join(dir, 'pages.csv')) };
  };

  const listRuns = () => {
    const out: ReturnType<typeof runInfo>[] = [];
    for (const client of readdirSync(runsDir)) {
      const cdir = join(runsDir, client);
      if (!statSync(cdir).isDirectory()) continue;
      for (const run of readdirSync(cdir)) {
        const dir = join(cdir, run);
        if (RunStore.exists(dir)) out.push(runInfo(`${client}/${run}`, dir));
      }
    }
    return out.sort((a, b) => b.started_at.localeCompare(a.started_at));
  };

  const launch = (id: string, dir: string, raw: string) => {
    const loaded = loadConfigText(raw, join(dir, 'config.yaml'));
    const a: Active = { id, dir, crawler: null as unknown as Crawler, progress: null, log: [], release: () => {} };
    const t = loaded.config.traffico;
    a.crawler = new Crawler(loaded, dir, {
      // Dati di traffico all'avvio solo se il progetto li chiede e Google è collegato
      traffic: (t.gsc || t.ga4) && googleStatus(googleDir).connected ? () => fetchTraffic(googleDir, t) : undefined,
      onProgress: (p) => {
        a.progress = p;
        send('progress', { id, progress: p });
      },
      log: (m) => {
        a.log.push(m);
        if (a.log.length > 200) a.log.shift();
        send('log', { id, message: m });
      },
    });
    a.release = keepAwake();
    active = a;
    void a.crawler
      .run()
      .then((state) => {
        if (state.status === 'completata') exportRun(dir);
        send('end', { id, status: state.status });
      })
      .catch((e: Error) => send('end', { id, status: 'interrotta', error: e.message.split('\n')[0] }))
      .finally(() => {
        a.release();
        if (active === a) active = null;
      });
  };

  const routes = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<unknown> => {
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // ---------- Google ----------
    if (path === '/api/google' && method === 'GET') {
      const st = googleStatus(googleDir);
      if (!st.connected) return { ...st, sites: [], properties: null };
      try {
        const token = await accessToken(googleDir);
        const [sites, properties] = await Promise.all([gscSites(token), ga4Properties(token)]);
        return { ...st, sites: sites.map((x) => x.siteUrl), properties };
      } catch (e) {
        return { ...st, sites: [], properties: null, error: (e as Error).message };
      }
    }
    if (path === '/api/google/credenziali' && method === 'POST') {
      try {
        saveCredentials(googleDir, String((await body(req)).text ?? ''));
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      return googleStatus(googleDir);
    }
    if (path === '/api/google/collega' && method === 'POST') {
      const c = readCredentials(googleDir);
      if (!c) throw new HttpError(400, 'Carica prima il file di credenziali di Google Cloud.');
      const p = pkce();
      pendingAuth = { state: randomBytes(16).toString('hex'), verifier: p.verifier, redirect: `http://${req.headers.host}/api/google/callback` };
      return { url: authUrl(c, pendingAuth.redirect, pendingAuth.state, p.challenge) };
    }
    if (path === '/api/google/scollega' && method === 'POST') {
      disconnect(googleDir);
      return googleStatus(googleDir);
    }
    if (path === '/api/google/callback' && method === 'GET') {
      const page = (title: string, text: string) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>Scrawl</title><body style="font:16px system-ui;max-width:560px;margin:80px auto;padding:0 20px"><h1 style="font-size:22px">${title}</h1><p>${text}</p></body>`);
        return undefined;
      };
      const auth = pendingAuth;
      pendingAuth = null;
      if (url.searchParams.get('error')) return page('Collegamento annullato', 'Google non ha concesso l\'accesso. Puoi chiudere questa scheda e riprovare da Scrawl.');
      if (!auth || url.searchParams.get('state') !== auth.state) return page('Collegamento non valido', 'La richiesta non viene da questa sessione di Scrawl. Chiudi la scheda e ripeti "Collega Google".');
      try {
        const r = await exchangeCode(googleDir, url.searchParams.get('code') ?? '', auth.redirect, auth.verifier);
        send('google', googleStatus(googleDir));
        return page('Google è collegato', r.missingScopes.length ? 'Attenzione: non tutte le autorizzazioni sono state concesse. Per leggere sia Search Console sia Analytics ripeti il collegamento e spunta entrambe le voci.' : 'Scrawl può leggere Search Console e Analytics, in sola lettura. Puoi chiudere questa scheda e tornare a Scrawl.');
      } catch (e) {
        return page('Collegamento non riuscito', (e as Error).message.replace(/[<>&]/g, ''));
      }
    }
    if (path === '/api/stato') return { version: TOOL_VERSION, active: active ? { id: active.id, progress: active.progress, log: active.log.slice(-50) } : null };

    if (path === '/api/progetti' && method === 'GET') {
      const runs = listRuns();
      return readdirSync(clientsDir)
        .filter((f) => f.endsWith('.yaml'))
        .map((f) => {
          const name = basename(f, '.yaml');
          const raw = readFileSync(join(clientsDir, f), 'utf8');
          let config: unknown = null;
          let error: string | null = null;
          try {
            config = loadConfigText(raw, join(clientsDir, f)).config;
          } catch (e) {
            error = (e as Error).message;
          }
          return { name, config, error, lastRun: runs.find((r) => r.project === name) ?? null };
        });
    }

    if (path === '/api/progetti' && method === 'POST') {
      const b = await body(req);
      const name = safeName(b.name ?? (b.config as { cliente?: string })?.cliente);
      const raw = stringify(b.config);
      try {
        loadConfigText(raw, projectPath(name));
      } catch (e) {
        if (e instanceof ConfigError) throw new HttpError(400, e.message);
        throw e;
      }
      writeFileSync(projectPath(name), raw);
      return { name };
    }

    if (path === '/api/scansioni' && method === 'GET') return listRuns();

    if (path === '/api/scansioni' && method === 'POST') {
      if (active) throw new HttpError(409, 'C\'è già una scansione in corso: mettila in pausa o attendi la fine.');
      const b = await body(req);
      const name = safeName(b.project);
      if (!existsSync(projectPath(name))) throw new HttpError(404, 'Progetto non trovato');
      const raw = readFileSync(projectPath(name), 'utf8');
      const id = `${name}/${timestampForPath()}`;
      const dir = join(runsDir, id);
      try {
        launch(id, dir, raw);
      } catch (e) {
        if (e instanceof ConfigError) throw new HttpError(400, e.message);
        throw e;
      }
      return { id };
    }

    const m = /^\/api\/scansioni\/([^/]+\/[^/]+)\/(pausa|riprendi|pagine|sito|esporta|file|zip|traffico|importa)$/.exec(decodeURIComponent(path));
    if (m) {
      const [, id, action] = m;
      if (action === 'pausa' && method === 'POST') {
        if (active?.id !== id) throw new HttpError(409, 'Questa scansione non è in corso');
        active.crawler.pause();
        return { ok: true };
      }
      const dir = runDirOf(id);
      if (action === 'riprendi' && method === 'POST') {
        if (active) throw new HttpError(409, 'C\'è già una scansione in corso.');
        const raw = Crawler.savedConfig(dir);
        if (!raw) throw new HttpError(404, 'Configurazione della scansione non trovata');
        launch(id, dir, raw);
        return { id };
      }
      if (action === 'esporta' && method === 'POST') return { files: exportRun(dir) };
      if (action === 'zip' && method === 'GET') {
        exportRun(dir);
        const names = ['pages.csv', 'pages.json', 'links.csv', 'site.json', 'manifest.json', 'config.yaml', 'registro.log'].filter((n) => existsSync(join(dir, n)));
        const data = zip(names.map((n) => ({ name: n, data: readFileSync(join(dir, n)) })));
        res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="scrawl-${id.replace('/', '-')}.zip"`, 'content-length': data.length });
        res.end(data);
        return undefined;
      }
      // Dati di traffico aggiunti a scansione finita: dalle API, o da un file esportato
      if (action === 'traffico' && method === 'POST') {
        if (!googleStatus(googleDir).connected) throw new HttpError(400, 'Google non è collegato: collegalo dalla sezione Progetti, oppure importa i file esportati.');
        const b = await body(req);
        let saved: { gsc?: string; ga4?: string; giorni?: number } = {};
        try {
          saved = (parseYaml(Crawler.savedConfig(dir) ?? '') as { traffico?: typeof saved })?.traffico ?? {};
        } catch {
          // configurazione non leggibile: valgono i valori indicati ora
        }
        const gsc = String(b.gsc ?? saved.gsc ?? '').trim() || undefined;
        const ga4 = String(b.ga4 ?? saved.ga4 ?? '').trim() || undefined;
        if (!gsc && !ga4) throw new HttpError(400, 'Indica la proprietà di Search Console o l\'ID della proprietà GA4.');
        try {
          const fresh = await fetchTraffic(googleDir, { gsc, ga4, giorni: Number(b.giorni ?? saved.giorni ?? 90) || 90 });
          const old = readTraffic(dir);
          saveTraffic(dir, { ...fresh, gsc: fresh.gsc ?? old?.gsc ?? null, ga4: fresh.ga4 ?? old?.ga4 ?? null });
        } catch (e) {
          throw new HttpError(e instanceof GoogleError ? 400 : 500, (e as Error).message);
        }
        if (existsSync(join(dir, 'pages.csv'))) exportRun(dir);
        return { ok: true };
      }
      if (action === 'importa' && method === 'POST') {
        const b = await body(req);
        const old: Traffic = readTraffic(dir) ?? { fetched_at: new Date().toISOString(), period: null, gsc: null, ga4: null };
        try {
          if (b.tipo === 'gsc') old.gsc = { source: 'csv', property: null, rows: parseGscCsv(String(b.text ?? '')) };
          else if (b.tipo === 'ga4') old.ga4 = { source: 'csv', property: null, rows: parseGa4Csv(String(b.text ?? '')) };
          else throw new CsvError('Tipo di file non indicato.');
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
        // Un file importato non dice il periodo: se c'era quello delle API non vale più per questa fonte
        saveTraffic(dir, { ...old, fetched_at: new Date().toISOString(), period: old.gsc?.source === 'api' || old.ga4?.source === 'api' ? old.period : null });
        if (existsSync(join(dir, 'pages.csv'))) exportRun(dir);
        return { ok: true, rows: (b.tipo === 'gsc' ? old.gsc : old.ga4)?.rows.length ?? 0 };
      }
      if (action === 'file' && method === 'GET') {
        const name = url.searchParams.get('nome') ?? '';
        if (!/^(pages\.csv|pages\.json|links\.csv|site\.json|manifest\.json|config\.yaml|registro\.log)$/.test(name) || !existsSync(join(dir, name))) throw new HttpError(404, 'File non trovato');
        res.writeHead(200, { 'content-type': name.endsWith('.csv') ? 'text/csv; charset=utf-8' : name.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="${name}"` });
        createReadStream(join(dir, name)).pipe(res);
        return undefined;
      }
      if (action === 'sito' && method === 'GET') return { items: siteSummary(loadRun(dir).site) };
      if (action === 'pagine' && method === 'GET') {
        const q = (url.searchParams.get('q') ?? '').toLowerCase();
        const filter = url.searchParams.get('filtro') ?? '';
        const offset = Number(url.searchParams.get('da') ?? 0) || 0;
        const all = loadPages(dir);
        const klass = (p: (typeof all)[number]) => (!p.fetched ? 'bloccate' : p.status === null ? 'errore' : p.status >= 500 ? 'server' : p.status >= 400 ? 'client' : p.status >= 300 ? 'redirect' : 'ok');
        const counts: Record<string, number> = { ok: 0, redirect: 0, client: 0, server: 0, errore: 0, bloccate: 0 };
        const templates: Record<string, number> = {};
        // Filtri sull'analisi della pagina: si combinano con quello sull'esito della risposta
        const checks: Record<string, (p: (typeof all)[number]) => boolean> = {
          nonindex: (p) => p.status === 200 && p.indexable === false,
          jsdiff: (p) => p.diff_fields.length > 0,
          jsonly: (p) => p.js_only_fields.length > 0,
          schema: (p) => (p.schema_errors as string[]).length + (p.schema_missing_required as string[]).length > 0,
          orfane: (p) => p.orphan === true,
          duplicati: (p) => !!p.duplicate_group || Number(p.title_duplicates ?? 0) > 0,
          linkrotti: (p) => Number(p.outlinks_to_error ?? 0) + Number(p.outlinks_external_broken ?? 0) > 0,
          canonical: (p) => (p.canonical_issue as string[]).length > 0,
          trafficononindex: (p) => p.indexable === false && /^riceve/.test(String(p.traffic_issue ?? '')),
          senzaimpression: (p) => /senza impression/.test(String(p.traffic_issue ?? '')),
        };
        const extra: Record<string, number> = { nonindex: 0, jsdiff: 0, jsonly: 0, schema: 0, orfane: 0, duplicati: 0, linkrotti: 0, canonical: 0, trafficononindex: 0, senzaimpression: 0 };
        for (const p of all) {
          counts[klass(p)]++;
          templates[p.template] = (templates[p.template] ?? 0) + 1;
          for (const k of Object.keys(checks)) if (checks[k](p)) extra[k]++;
        }
        const tpl = url.searchParams.get('modello') ?? '';
        const rows = all.filter((p) => (!filter || (checks[filter] ? checks[filter](p) : klass(p) === filter)) && (!tpl || p.template === tpl) && (!q || p.url.toLowerCase().includes(q) || String(p.title ?? '').toLowerCase().includes(q)));
        return {
          total: all.length,
          matching: rows.length,
          counts,
          extra,
          rendered: all.filter((p) => p.rendered).length,
          templates,
          traffic: !!loadRun(dir).site.traffic?.available,
          rows: (url.searchParams.get('ordine') === 'clic' ? [...rows].sort((a, b) => Number(b.gsc_clicks ?? 0) - Number(a.gsc_clicks ?? 0) || Number(b.gsc_impressions ?? 0) - Number(a.gsc_impressions ?? 0)) : rows).slice(offset, offset + 100).map(({ headers: _h, headings: _o, ...p }) => p),
          run: runInfo(id, dir),
        };
      }
    }
    throw new HttpError(404, 'Non trovato');
  };

  const server = createServer(async (req, res) => {
    try {
      // Solo richieste dalla pagina stessa: un altro sito aperto nel browser non può comandare lo strumento
      const host = req.headers.host ?? '';
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) throw new HttpError(403, 'Accesso non consentito');
      const origin = req.headers.origin;
      if (origin && origin !== `http://${host}`) throw new HttpError(403, 'Accesso non consentito');
      const url = new URL(req.url ?? '/', `http://${host}`);
      if (url.pathname === '/' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(readFileSync(UI_FILE));
        return;
      }
      if (url.pathname === '/api/eventi') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': ok\n\n');
        streams.add(res);
        req.on('close', () => streams.delete(res));
        return;
      }
      const out = await routes(req, res, url);
      if (out === undefined) return;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(out));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: (e as Error).message.split('\n')[0] }));
    }
  });

  await new Promise<void>((ok, ko) => {
    server.once('error', ko);
    server.listen(opts.port, '127.0.0.1', () => ok());
  });
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : opts.port}`;
  if (opts.open) {
    const [cmd, args]: [string, string[]] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
    try {
      spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    } catch {
      // nessun browser da aprire: l'indirizzo è nel terminale
    }
  }
  return {
    server,
    url,
    close: async () => {
      active?.crawler.stopNow();
      for (const s of streams) s.end();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}
