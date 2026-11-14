/**
 * Lettura di robots.txt per singolo crawler (RFC 9309): gruppi di User-agent, Allow/Disallow con * e $,
 * regola più lunga vincente (a parità Allow), Sitemap e Crawl-delay. La versione di Scookie legge solo il
 * gruppo "*": qui serve sapere cosa vale per il nostro crawler e, dal passo 4, per quelli dei motori AI.
 */
export interface RobotsRule {
  allow: boolean;
  pattern: string;
  line: number;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelay: number | null;
}

export interface RobotsProblem {
  line: number;
  text: string;
  problem: string;
}

export interface Robots {
  groups: RobotsGroup[];
  sitemaps: string[];
  problems: RobotsProblem[];
}

const KNOWN = new Set(['user-agent', 'allow', 'disallow', 'sitemap', 'crawl-delay', 'host', 'clean-param', 'noindex', 'request-rate', 'visit-time']);

export function parseRobots(text: string): Robots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  const problems: RobotsProblem[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) return;
    const m = /^([^:]+?)\s*:\s*(.*)$/.exec(line);
    if (!m) {
      problems.push({ line: i + 1, text: raw.trim().slice(0, 200), problem: 'riga senza "campo: valore"' });
      return;
    }
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (!KNOWN.has(key)) {
      problems.push({ line: i + 1, text: raw.trim().slice(0, 200), problem: `campo sconosciuto "${m[1]}"` });
      return;
    }
    if (key === 'sitemap') {
      if (value) sitemaps.push(value);
      return;
    }
    if (key === 'user-agent') {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      return;
    }
    lastWasAgent = false;
    if (key === 'allow' || key === 'disallow') {
      if (!current) {
        problems.push({ line: i + 1, text: raw.trim().slice(0, 200), problem: 'regola prima di qualsiasi User-agent' });
        return;
      }
      // "Disallow:" vuoto non vieta nulla
      if (value) current.rules.push({ allow: key === 'allow', pattern: value, line: i + 1 });
    } else if (key === 'crawl-delay' && current) {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
      else problems.push({ line: i + 1, text: raw.trim().slice(0, 200), problem: 'Crawl-delay non numerico' });
    }
  });
  return { groups, sitemaps, problems };
}

const toRegExp = (pattern: string) => {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
};

/** Gruppi che valgono per un crawler: quelli che lo nominano (tutti insieme), altrimenti quelli di "*". */
export function groupsFor(robots: Robots, agent: string): RobotsGroup[] {
  const token = agent.toLowerCase();
  // Il nome nel file è un prefisso del nome del crawler: "googlebot" vale per "googlebot-image"
  const named = robots.groups.filter((g) => g.agents.some((a) => a !== '*' && token.startsWith(a)));
  return named.length ? named : robots.groups.filter((g) => g.agents.includes('*'));
}

export interface RobotsVerdict {
  allowed: boolean;
  /** Regola che ha deciso, se c'è. */
  rule: RobotsRule | null;
}

export function robotsCheck(robots: Robots, agent: string, pathWithQuery: string): RobotsVerdict {
  let best: RobotsRule | null = null;
  for (const g of groupsFor(robots, agent)) {
    for (const r of g.rules) {
      if (!toRegExp(r.pattern).test(pathWithQuery)) continue;
      if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow && !best.allow)) best = r;
    }
  }
  return { allowed: !best || best.allow, rule: best };
}

export function crawlDelayFor(robots: Robots, agent: string): number | null {
  const delays = groupsFor(robots, agent).map((g) => g.crawlDelay).filter((d): d is number => d !== null);
  return delays.length ? Math.max(...delays) : null;
}
