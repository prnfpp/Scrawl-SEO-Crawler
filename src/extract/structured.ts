import { readFileSync } from 'node:fs';
import type { CheerioAPI } from 'cheerio';
import { parse } from 'yaml';

interface TypeRule {
  sottotipi?: string[];
  obbligatorie?: string[];
  almenoUna?: string[];
  consigliate?: string[];
}

let RULES: Map<string, { name: string; rule: TypeRule }> | null = null;
function rules() {
  if (!RULES) {
    const data = parse(readFileSync(new URL('../../../data/schema-types.yaml', import.meta.url), 'utf8')) as { tipi: Record<string, TypeRule> };
    RULES = new Map();
    for (const [name, rule] of Object.entries(data.tipi)) {
      RULES.set(name, { name, rule });
      for (const sub of rule.sottotipi ?? []) RULES.set(sub, { name, rule });
    }
  }
  return RULES;
}

export interface StructuredData {
  /** Tipi presenti, senza ripetizioni, nell'ordine in cui compaiono. */
  types: string[];
  /** jsonld, microdata, rdfa. */
  formats: string[];
  /** Blocchi JSON-LD non leggibili. */
  errors: string[];
  missing_required: string[];
  missing_recommended: string[];
  /** Valori dichiarati nei dati strutturati che non compaiono nel testo visibile. */
  content_mismatch: string[];
}

type Node = Record<string, unknown>;
const isNode = (v: unknown): v is Node => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v: unknown): unknown[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const typesOf = (n: Node): string[] => list(n['@type'] ?? n.type).filter((t): t is string => typeof t === 'string').map((t) => t.replace(/^https?:\/\/schema\.org\//, ''));
const empty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** Tutti gli elementi con @type, anche annidati e dentro @graph. */
function collect(v: unknown, out: Node[], depth = 0) {
  if (depth > 12) return;
  if (Array.isArray(v)) for (const x of v) collect(x, out, depth + 1);
  else if (isNode(v)) {
    if (typesOf(v).length) out.push(v);
    for (const x of Object.values(v)) if (typeof x === 'object') collect(x, out, depth + 1);
  }
}

/** Valori di una proprietà anche annidata (offers.price), su ogni elemento se il valore è un elenco. */
function values(node: Node, path: string): { found: boolean; values: unknown[] } {
  let current: unknown[] = [node];
  for (const key of path.split('.')) {
    const next: unknown[] = [];
    for (const c of current) {
      if (!isNode(c)) continue;
      // ogni elemento dell'elenco deve avere la proprietà
      if (empty(c[key])) return { found: false, values: [] };
      next.push(...list(c[key]));
    }
    if (!next.length) return { found: false, values: [] };
    current = next;
  }
  return { found: true, values: current };
}

const norm = (s: string) => s.toLowerCase().replace(/&nbsp;/g, ' ').replace(/[\s ]+/g, ' ').replace(/[“”«»"']/g, '').trim();
const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : isNode(v) && typeof v.name === 'string' ? v.name : '');

function checkNode(node: Node, visible: string, sd: StructuredData) {
  for (const t of typesOf(node)) {
    const hit = rules().get(t);
    if (!hit) continue;
    const label = t === hit.name ? t : `${t} (${hit.name})`;
    for (const p of hit.rule.obbligatorie ?? []) if (!values(node, p).found) sd.missing_required.push(`${label}: ${p}`);
    const any = hit.rule.almenoUna ?? [];
    if (any.length && !any.some((p) => values(node, p).found)) sd.missing_required.push(`${label}: una tra ${any.join(', ')}`);
    for (const p of hit.rule.consigliate ?? []) {
      // proprietà annidata: si segnala solo se il genitore c'è (se manca è già segnalato lui)
      const parent = p.includes('.') ? p.slice(0, p.lastIndexOf('.')) : '';
      if (parent && !values(node, parent).found) continue;
      if (!values(node, p).found) sd.missing_recommended.push(`${label}: ${p}`);
    }
    // Coerenza con il contenuto visibile: ciò che si dichiara ai motori deve esserci anche per chi legge
    const seen = (s: string) => !s || norm(visible).includes(norm(s).slice(0, 120));
    const flag = (prop: string, value: string) => sd.content_mismatch.push(`${label}.${prop} non compare nel testo visibile: "${value.slice(0, 80)}"`);
    if (hit.name === 'Product' || hit.name === 'LocalBusiness') {
      const name = text(node.name);
      if (!seen(name)) flag('name', name);
    }
    if (hit.name === 'Article') {
      const h = text(node.headline);
      if (!seen(h)) flag('headline', h);
    }
    if (hit.name === 'Product') {
      for (const price of values(node, 'offers.price').values) {
        const p = text(price);
        if (!p) continue;
        // 1299.00 nella pagina può essere "1.299,00", "1299" o "1 299": si confrontano le cifre della parte intera
        const digits = p.replace(/[.,]\d{1,2}$/, '').replace(/\D/g, '');
        if (digits && !visible.replace(/[\s., ']/g, '').includes(digits)) flag('offers.price', p);
      }
    }
    if (hit.name === 'FAQPage') {
      for (const q of list(node.mainEntity)) {
        const name = isNode(q) ? text(q.name) : '';
        if (!seen(name)) flag('mainEntity.name', name);
      }
    }
  }
}

/** Dati strutturati di una pagina: JSON-LD (con controllo di sintassi e proprietà) e microdata (tipi e proprietà). */
export function structuredData($: CheerioAPI, visible: string): StructuredData {
  const sd: StructuredData = { types: [], formats: [], errors: [], missing_required: [], missing_recommended: [], content_mismatch: [] };
  const nodes: Node[] = [];
  const blocks = $('script[type="application/ld+json"]');
  blocks.each((i, el) => {
    const raw = ($(el).text() ?? '').trim();
    if (!raw) {
      sd.errors.push(`JSON-LD ${i + 1}: blocco vuoto`);
      return;
    }
    try {
      collect(JSON.parse(raw), nodes);
    } catch (e) {
      sd.errors.push(`JSON-LD ${i + 1}: ${(e as Error).message.replace(/\s+/g, ' ').slice(0, 140)}`);
    }
  });
  if (blocks.length) sd.formats.push('jsonld');

  // Microdata: un elemento per ogni itemscope con itemtype; le sue proprietà sono gli itemprop non dentro un altro itemscope
  const scopes = $('[itemscope][itemtype]');
  if (scopes.length) sd.formats.push('microdata');
  scopes.each((_, el) => {
    const node: Node = { '@type': ($(el).attr('itemtype') ?? '').split(/\s+/).filter(Boolean) };
    $(el)
      .find('[itemprop]')
      .each((__, p) => {
        if ($(p).parentsUntil(el, '[itemscope]').length) return;
        const value = $(p).is('[itemscope]') ? { '@type': ($(p).attr('itemtype') ?? '').split(/\s+/).filter(Boolean) } : ($(p).attr('content') ?? $(p).attr('href') ?? $(p).attr('src') ?? $(p).attr('datetime') ?? $(p).text().trim());
        for (const name of ($(p).attr('itemprop') ?? '').split(/\s+/).filter(Boolean)) {
          node[name] = node[name] === undefined ? value : [...list(node[name]), value];
        }
      });
    nodes.push(node);
  });
  if ($('[typeof][vocab], [vocab] [typeof]').length) sd.formats.push('rdfa');

  for (const n of nodes) {
    for (const t of typesOf(n)) if (!sd.types.includes(t)) sd.types.push(t);
    checkNode(n, visible, sd);
  }
  const uniq = (a: string[]) => [...new Set(a)];
  sd.missing_required = uniq(sd.missing_required);
  sd.missing_recommended = uniq(sd.missing_recommended);
  sd.content_mismatch = uniq(sd.content_mismatch);
  return sd;
}
