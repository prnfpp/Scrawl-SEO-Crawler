import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keepAwake, slug, timestampForPath } from 'scookie/engine';
import { stringify } from 'yaml';
import { ConfigError, loadConfigText } from '../config/load.js';
import { Crawler, type Progress } from '../crawl/crawler.js';
import { RunStore, type RunState } from '../crawl/store.js';
import { exportRun, loadPages } from '../report/export.js';
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
    if (size > 2_000_000) throw new HttpError(413, 'Richiesta troppo grande');
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
    return { id, project: id.split('/')[0], cliente: st.cliente, status, live, started_at: st.started_at, ended_at: st.ended_at, updated_at: st.updated_at, elapsed_s: st.elapsed_s, pages, not_reached: st.not_reached.count, limits: st.limits, notes: st.notes, sample: st.sample, exported: existsSync(join(dir, 'pages.csv')) };
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
    a.crawler = new Crawler(loaded, dir, {
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

    const m = /^\/api\/scansioni\/([^/]+\/[^/]+)\/(pausa|riprendi|pagine|esporta|file)$/.exec(decodeURIComponent(path));
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
      if (action === 'file' && method === 'GET') {
        const name = url.searchParams.get('nome') ?? '';
        if (!/^(pages\.csv|pages\.json|links\.csv|manifest\.json|config\.yaml|registro\.log)$/.test(name) || !existsSync(join(dir, name))) throw new HttpError(404, 'File non trovato');
        res.writeHead(200, { 'content-type': name.endsWith('.csv') ? 'text/csv; charset=utf-8' : name.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="${name}"` });
        createReadStream(join(dir, name)).pipe(res);
        return undefined;
      }
      if (action === 'pagine' && method === 'GET') {
        const q = (url.searchParams.get('q') ?? '').toLowerCase();
        const filter = url.searchParams.get('filtro') ?? '';
        const offset = Number(url.searchParams.get('da') ?? 0) || 0;
        const all = loadPages(dir);
        const klass = (p: (typeof all)[number]) => (!p.fetched ? 'bloccate' : p.status === null ? 'errore' : p.status >= 500 ? 'server' : p.status >= 400 ? 'client' : p.status >= 300 ? 'redirect' : 'ok');
        const counts: Record<string, number> = { ok: 0, redirect: 0, client: 0, server: 0, errore: 0, bloccate: 0 };
        const templates: Record<string, number> = {};
        for (const p of all) {
          counts[klass(p)]++;
          templates[p.template] = (templates[p.template] ?? 0) + 1;
        }
        const tpl = url.searchParams.get('modello') ?? '';
        const rows = all.filter((p) => (!filter || klass(p) === filter) && (!tpl || p.template === tpl) && (!q || p.url.toLowerCase().includes(q)));
        return {
          total: all.length,
          matching: rows.length,
          counts,
          templates,
          rows: rows.slice(offset, offset + 100).map(({ headers: _h, ...p }) => p),
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
