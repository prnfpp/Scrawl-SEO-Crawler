import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Indirizzi di Google: modificabili solo dai test. */
export const ENDPOINTS = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  searchConsole: 'https://www.googleapis.com/webmasters/v3',
  analyticsData: 'https://analyticsdata.googleapis.com/v1beta',
  analyticsAdmin: 'https://analyticsadmin.googleapis.com/v1beta',
};

/** Sola lettura: lo strumento non può modificare nulla in Search Console o in Analytics. */
export const SCOPES = ['https://www.googleapis.com/auth/webmasters.readonly', 'https://www.googleapis.com/auth/analytics.readonly'];

export interface Credentials {
  client_id: string;
  client_secret: string;
}

interface Token {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope?: string;
}

export class GoogleError extends Error {}

const credFile = (dir: string) => join(dir, 'credenziali.json');
const tokenFile = (dir: string) => join(dir, 'token.json');

/** Legge il file scaricato da Google Cloud (credenziali OAuth di tipo "App desktop"). */
export function parseCredentials(text: string): Credentials {
  let data: { installed?: Partial<Credentials>; web?: Partial<Credentials> };
  try {
    data = JSON.parse(text);
  } catch {
    throw new GoogleError('Il file non è un JSON valido: serve il file di credenziali scaricato da Google Cloud.');
  }
  const c = data.installed ?? data.web;
  if (!c?.client_id || !c.client_secret) throw new GoogleError('Nel file mancano client_id e client_secret: serve un ID client OAuth di tipo "App desktop".');
  return { client_id: c.client_id, client_secret: c.client_secret };
}

export function saveCredentials(dir: string, text: string) {
  const c = parseCredentials(text);
  mkdirSync(dir, { recursive: true });
  writeFileSync(credFile(dir), JSON.stringify({ installed: c }, null, 2), { mode: 0o600 });
}

export function readCredentials(dir: string): Credentials | null {
  try {
    return parseCredentials(readFileSync(credFile(dir), 'utf8'));
  } catch {
    return null;
  }
}

function readToken(dir: string): Token | null {
  try {
    return JSON.parse(readFileSync(tokenFile(dir), 'utf8')) as Token;
  } catch {
    return null;
  }
}

export const googleStatus = (dir: string) => ({ credentials: !!readCredentials(dir), connected: !!readToken(dir)?.refresh_token });

export function disconnect(dir: string) {
  if (existsSync(tokenFile(dir))) rmSync(tokenFile(dir));
}

/** Coppia per PKCE: il codice di accesso vale solo per chi ha avviato la richiesta. */
export function pkce() {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function authUrl(c: Credentials, redirectUri: string, state: string, challenge: string): string {
  const q = new URLSearchParams({ client_id: c.client_id, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256' });
  return `${ENDPOINTS.auth}?${q}`;
}

async function tokenRequest(params: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in: number; scope?: string }> {
  let res: Response;
  try {
    res = await fetch(ENDPOINTS.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params), signal: AbortSignal.timeout(30000) });
  } catch {
    throw new GoogleError('Google non raggiungibile: controlla la connessione.');
  }
  const json = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string; access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
  if (!res.ok || !json.access_token) {
    if (json.error === 'invalid_grant') throw new GoogleError('Il collegamento con Google è scaduto o è stato revocato: va rifatto con "Collega Google".');
    throw new GoogleError(`Google ha rifiutato la richiesta: ${json.error_description ?? json.error ?? res.status}`);
  }
  return { access_token: json.access_token, refresh_token: json.refresh_token, expires_in: json.expires_in ?? 3600, scope: json.scope };
}

/** Scambia il codice ricevuto dopo l'accesso con i token, e li salva sul computer. */
export async function exchangeCode(dir: string, code: string, redirectUri: string, verifier: string) {
  const c = readCredentials(dir);
  if (!c) throw new GoogleError('Credenziali di Google non caricate.');
  const t = await tokenRequest({ client_id: c.client_id, client_secret: c.client_secret, code, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier });
  if (!t.refresh_token) throw new GoogleError('Google non ha concesso l\'accesso continuativo: ripeti il collegamento e conferma tutte le autorizzazioni.');
  const missing = SCOPES.filter((s) => t.scope && !t.scope.split(' ').includes(s));
  mkdirSync(dir, { recursive: true });
  writeFileSync(tokenFile(dir), JSON.stringify({ access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + t.expires_in * 1000, scope: t.scope } satisfies Token, null, 2), { mode: 0o600 });
  return { missingScopes: missing };
}

/** Token valido per le chiamate, rinnovato se scaduto. */
export async function accessToken(dir: string): Promise<string> {
  const c = readCredentials(dir);
  const t = readToken(dir);
  if (!c || !t?.refresh_token) throw new GoogleError('Google non è collegato.');
  if (t.expires_at > Date.now() + 60000) return t.access_token;
  const n = await tokenRequest({ client_id: c.client_id, client_secret: c.client_secret, refresh_token: t.refresh_token, grant_type: 'refresh_token' });
  writeFileSync(tokenFile(dir), JSON.stringify({ ...t, access_token: n.access_token, expires_at: Date.now() + n.expires_in * 1000 } satisfies Token, null, 2), { mode: 0o600 });
  return n.access_token;
}
