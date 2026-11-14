import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parse } from 'yaml';
import { configSchema, type CrawlConfig } from './schema.js';

export interface LoadedConfig {
  config: CrawlConfig;
  path: string;
  /** Testo del file, copiato nella cartella della scansione: la ripresa usa questa copia. */
  raw: string;
  outputDir: string;
}

export class ConfigError extends Error {}

export function loadConfigText(raw: string, path: string): LoadedConfig {
  let data: unknown;
  try {
    data = parse(raw);
  } catch (e) {
    throw new ConfigError(`Il file non è un YAML valido: ${(e as Error).message.split('\n')[0]}`);
  }
  const r = configSchema.safeParse(data);
  if (!r.success) {
    throw new ConfigError(r.error.issues.map((i) => `${i.path.join('.') || 'configurazione'}: ${i.message}`).join('; '));
  }
  const out = r.data.output;
  return { config: r.data, path, raw, outputDir: isAbsolute(out) ? out : resolve(dirname(path), out) };
}

export function loadConfig(path: string): LoadedConfig {
  return loadConfigText(readFileSync(path, 'utf8'), resolve(path));
}
