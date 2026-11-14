import { z } from 'zod';

const regexList = z.array(z.string().refine((s) => {
  try {
    new RegExp(s);
    return true;
  } catch {
    return false;
  }
}, 'espressione regolare non valida')).default([]);

const httpUrl = z.string().refine((s) => /^https?:\/\//i.test(s) && URL.canParse(s), 'serve un indirizzo completo, es. https://www.esempio.it/');

/**
 * Configurazione di una scansione. Tutto ciò che cambia da cliente a cliente sta qui: il codice non contiene
 * nulla di specifico per un sito.
 */
export const configSchema = z
  .object({
    cliente: z.string().min(1),
    /** Cartella dei risultati, relativa al file di configurazione. */
    output: z.string().default('../runs'),

    /** Punti di partenza: se ne può indicare più di uno. */
    partenza: z
      .object({
        /** Dominio (o indirizzo) da cui partire seguendo i link. */
        dominio: httpUrl.optional(),
        /** Una o più sitemap da leggere. */
        sitemap: z.array(httpUrl).default([]),
        /** Elenco di indirizzi da scansionare. */
        url: z.array(httpUrl).default([]),
        /** Sitemap dichiarate in robots.txt (o /sitemap.xml): lette in automatico quando c'è un dominio di partenza. */
        sitemapAutomatica: z.boolean().default(true),
      })
      .refine((p) => !!p.dominio || p.sitemap.length > 0 || p.url.length > 0, 'indicare almeno un punto di partenza: dominio, sitemap o elenco di indirizzi'),

    perimetro: z
      .object({
        /**
         * escludi: solo l'host di partenza (con e senza www); includi: tutti i sottodomini dello stesso dominio;
         * oppure un elenco di host ammessi oltre a quello di partenza.
         */
        sottodomini: z.union([z.enum(['escludi', 'includi']), z.array(z.string())]).default('escludi'),
        /** Se non vuoto, si scansionano solo i percorsi che corrispondono ad almeno una regola. */
        includi: regexList,
        /** Percorsi da non scansionare (regex sul percorso con la query). */
        escludi: regexList,
        maxPagine: z.number().int().min(1).max(50000).default(5000),
        /** Livelli di profondità dal punto di partenza (0 = solo le pagine di partenza). */
        maxProfondita: z.number().int().min(0).max(50).default(12),
        /** Segue i link trovati nelle pagine. Con false si scansionano solo sitemap ed elenco. */
        seguiLink: z.boolean().default(true),
        /** Parametri di URL tolti prima di accodare l'indirizzo (tracciamento): "*" finale ammesso. */
        parametriIgnorati: z.array(z.string()).default(['utm_*', 'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'mc_cid', 'mc_eid', '_ga', '_gl']),
      })
      .prefault({}),

    /** completa: tutte le pagine nel perimetro; campione: alcune pagine per tipologia. */
    modalita: z.enum(['completa', 'campione']).default('completa'),

    campionamento: z
      .object({
        perTipo: z.number().int().min(1).max(200).default(5),
        maxPagine: z.number().int().min(1).max(2000).default(60),
        /** nome del tipo -> regex sul percorso (facoltativo: altrimenti si usa la struttura degli indirizzi). */
        tipi: z.record(z.string(), z.string()).default({}),
      })
      .prefault({}),

    cortesia: z
      .object({
        /** Pausa minima tra due richieste allo stesso host. */
        pausaMs: z.number().int().min(0).max(60000).default(500),
        /** Richieste in parallelo. */
        paralleli: z.number().int().min(1).max(8).default(2),
        /** Rispetta robots.txt. false solo per i siti dei clienti, in modo esplicito: il report lo dichiara. */
        rispettaRobots: z.boolean().default(true),
        /** Rispetta Crawl-delay di robots.txt se più lungo della pausa, fino a questo tetto. */
        maxCrawlDelayMs: z.number().int().min(0).max(120000).default(10000),
        timeoutMs: z.number().int().min(1000).max(120000).default(30000),
        /** Nome con cui lo strumento si dichiara (anche per le regole di robots.txt). */
        nomeCrawler: z.string().regex(/^[A-Za-z][\w-]*$/).default('ScrawlSEO'),
        /** Contatto dichiarato nello user agent, es. mailto:seo@agenzia.it. */
        contatto: z.string().default(''),
        /** User agent completo (sostituisce quello predefinito). */
        userAgent: z.string().optional(),
      })
      .prefault({}),

    /**
     * Rendering con browser: confronto tra l'HTML del server e il DOM dopo JavaScript. Sotto la soglia si
     * renderizzano tutte le pagine; sopra, un campione per modello di pagina più le pagine il cui sorgente è sospetto.
     */
    rendering: z
      .object({
        attivo: z.boolean().default(true),
        soglia: z.number().int().min(0).default(500),
        perModello: z.number().int().min(1).default(20),
        /** Attesa dopo il caricamento, per gli script che scrivono la pagina in ritardo. */
        attesaMs: z.number().int().min(0).max(30000).default(1500),
        timeoutMs: z.number().int().min(5000).max(180000).default(45000),
        /** Blocca le richieste verso statistiche e pubblicità: le visite non arrivano agli analytics del cliente. */
        bloccaTracker: z.boolean().default(true),
        /** Altri host da bloccare (es. un endpoint di tracciamento sul dominio del cliente). */
        trackerExtra: z.array(z.string()).default([]),
        /** Browser: chromium (incluso), chrome o msedge (installati sul computer). */
        canale: z.enum(['chromium', 'chrome', 'msedge']).default('chromium'),
        viewport: z.object({ width: z.number().int(), height: z.number().int() }).default({ width: 1366, height: 900 }),
      })
      .prefault({}),
  })
  .strict();

export type CrawlConfig = z.infer<typeof configSchema>;
