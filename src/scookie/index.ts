/**
 * Parti del motore di navigazione di Scookie copiate in Scrawl. Chi le usa importa da qui.
 * Provenienza e criteri in LEGGIMI.md.
 */
export { launchOptions, resolveUserAgent, type LaunchConfig, type UserAgentConfig } from './launch.js';
export { scrollPage } from './scroll.js';
export { detectBotChallenge, type BotBlock } from './antibot.js';
export { pageType, sample, sectionsOf, type SampledPage } from './pages.js';
export { hostMatches, hostOf, registrableDomain } from './domains.js';
export { closeSafely, sha256, sha256File, sleep, slug, timestampForPath, withTimeout } from './misc.js';
export { detectSeparator, parseCsv, toCsv } from './csv.js';
export { keepAwake } from './awake.js';
export { CSS, esc, fmt } from './style.js';
export { heuristicBannerVisible, heuristicChoose, scan as scanBanner } from './banner/heuristic.js';
export type { Choice, ChoiceResult } from './banner/types.js';
