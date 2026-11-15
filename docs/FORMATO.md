# Formato dei file di dati

Questi file sono l'input della skill di pre-analisi SEO e GEO. I nomi dei campi sono stabili: ogni modifica
(aggiunta, rimozione, cambio di nome o di significato) va scritta nel `CHANGELOG.md` sotto **Formato**, e il test
`formato` in `test/unit.test.ts` la blocca finché non viene aggiornato insieme a questo documento.

`schema_version` (in `manifest.json`):

- **0** — formato in costruzione (passi 2-6 dello sviluppo). Le colonne possono solo aumentare.
- **1** — formato completo, dal passo 7. Da lì ogni rimozione o cambio di nome alza il numero.

## Cartella di una scansione

`runs/<cliente>/<data_ora>/`

| File | Contenuto | Stabile |
|---|---|---|
| `pages.csv`, `pages.json` | una riga per indirizzo | sì |
| `links.csv` | una riga per link trovato | sì |
| `site.json` | controlli a livello di sito e riepiloghi tra pagine | sì |
| `manifest.json` | versione del formato, perimetro, limiti, cosa non è stato verificato | sì |
| `config.yaml` | configurazione usata (copia: la ripresa usa questa) | sì |
| `pagine.jsonl`, `link.jsonl`, `render.jsonl`, `link-render.jsonl`, `controllo-link.jsonl`, `frontiera.jsonl`, `sitemap.jsonl`, `sito.json`, `robots.json`, `risorse.txt`, `stato.json`, `registro.log` | dati di lavoro per la ripresa | no: non usarli come input |

**CSV**: separatore `;`, UTF-8 con BOM (si aprono in Excel con impostazioni italiane), prima riga con i nomi dei
campi. Vuoto = dato assente. Booleani: `true` / `false`. Elenchi: valori separati da ` | `. Una cella che inizia
con `=`, `+`, `-` o `@` ha un apostrofo davanti, perché Excel non la legga come formula.

**JSON**: stessi campi, con i tipi veri (numeri, booleani, elenchi) e senza apostrofi. **Per le elaborazioni con
codice usare `pages.json`**; i CSV sono per la lettura in un foglio di calcolo.

**Sorgente e renderizzato.** I campi senza prefisso (`title`, `canonical`, `h1`, `word_count`…) sono il valore che
conta: quello del DOM dopo JavaScript se `rendered` è `true`, altrimenti quello dell'HTML del server. I campi
`raw_*` sono sempre l'HTML del server. `diff_fields` dice quali campi cambiano tra i due.

## pages (stato: passo 6; mancano i campi del passo 5)

### Risposta

| Campo | Tipo | Significato |
|---|---|---|
| `url` | testo | Indirizzo richiesto, in forma canonica: senza frammento e senza parametri di tracciamento. Barra finale, maiuscole e ordine dei parametri restano come trovati. |
| `status` | numero | Codice della risposta a questo indirizzo (non a quello finale). Vuoto: nessuna risposta, o pagina non richiesta. |
| `final_url` | testo | Indirizzo a cui si arriva seguendo i redirect. Uguale a `url` se non ci sono redirect. |
| `final_status` | numero | Codice della risposta finale. Vuoto se la catena non si chiude (loop, errore). |
| `redirect_type` | `nessuno` `singolo` `catena` `loop` `troppi` | `catena`: due o più redirect di seguito; `troppi`: più di 10. |
| `redirect_hops` | numero | Numero di redirect prima della risposta finale. |
| `redirect_chain` | testo / elenco | CSV: `301 url > 302 url > 200 url`. JSON: elenco di `{url, status}`. |
| `redirect_to` | testo | Destinazione dichiarata da questo indirizzo (primo passaggio). |
| `content_type` | testo | Intestazione Content-Type (vuota per i redirect). |
| `template` | testo | Modello di pagina, dalla struttura dell'indirizzo o dalle regole `campionamento.tipi`. |
| `depth` | numero | Clic dal punto di partenza: cammino più breve sul grafo dei link (un redirect non costa un clic). Vuoto: non raggiungibile dai link. |
| `source` | `partenza` `link` `sitemap` `elenco` `redirect` `search-console` | Come è stato scoperto l'indirizzo. Se è in sitemap o in Search Console ma anche raggiunto da un link: `link`. |
| `found_on` | testo | Pagina in cui è stato trovato per la prima volta. |
| `in_sitemap` | booleano | Presente in una delle sitemap lette. |
| `robots_txt_blocked` | booleano | Vietato da robots.txt per il crawler dello strumento. |
| `robots_txt_rule` | testo | Regola che lo vieta. |
| `fetched` | booleano | `false`: non richiesto perché vietato da robots.txt. |
| `fetch_ms` | numero | Tempo di risposta del server a questo indirizzo, in millisecondi (non è un dato di prestazioni della pagina). |
| `bytes` | numero | Peso dell'HTML ricevuto (dopo la decompressione). |
| `error` | testo | Errore di rete o della catena di redirect. |
| `fetched_at` | data ISO | Momento della richiesta. |

### Indicizzabilità

| Campo | Tipo | Significato |
|---|---|---|
| `robots_meta` | elenco | Direttive di `meta robots` e `meta googlebot`, minuscole. |
| `x_robots_tag` | elenco | Direttive dell'intestazione X-Robots-Tag valide per tutti i crawler o per Googlebot. |
| `canonical` | testo | Canonical dichiarato (tag nella `<head>` o intestazione HTTP `Link`), in forma canonica. |
| `canonical_type` | `assente` `autoreferenziale` `altra-pagina` `in-conflitto` `non-valido` | `in-conflitto`: più canonical diversi tra loro. |
| `canonical_count` | numero | Quanti canonical dichiarati (tag più intestazione). |
| `indexable` | booleano | Esito per la singola pagina. Vuoto: non è una pagina HTML. |
| `indexability_reason` | testo | Perché non è indicizzabile: redirect, errore, robots.txt, noindex (meta, intestazione, aggiunto da JavaScript), canonical verso un'altra pagina. |

I controlli che richiedono altre pagine sono in `canonical_issue`, `hreflang_issues` e `sitemap_issue`.

### Contenuto

| Campo | Tipo | Significato |
|---|---|---|
| `title`, `title_length`, `title_count` | testo, numeri | `title_count` > 1: più `<title>` nel documento. |
| `description`, `description_length` | testo, numero | Meta description. |
| `h1`, `h1_count` | elenco, numero | Tutti gli H1 della pagina. |
| `heading_issues` | elenco | Problemi nella gerarchia: H1 assente o multiplo, primo titolo non H1, salti di livello. |
| `word_count` | numero | Parole del contenuto principale: `<main>`, oppure l'`<article>` prevalente, oppure il body senza testata, menu, piè di pagina, barre laterali e banner di consenso. |
| `content_hash` | testo | Uguale tra due pagine solo se il contenuto principale è identico. |
| `content_simhash` | testo | Impronta a 64 bit per i quasi duplicati (pochi bit di differenza = testi quasi uguali). Vuota sotto le 20 parole. |
| `lang` | testo | Attributo `lang` di `<html>`. |
| `hreflang`, `hreflang_count` | elenco, numero | CSV: `it=url \| en=url`. JSON: elenco di `{lang, href}`. Reciprocità in `hreflang_reciprocal`. |
| `viewport` | testo | Meta viewport. |

### Link e immagini

| Campo | Tipo | Significato |
|---|---|---|
| `outlinks_internal`, `outlinks_external`, `outlinks_nofollow` | numeri | Link in uscita (occorrenze). |
| `images_count` | numero | Elementi `<img>`. |
| `images_missing_alt` | numero | Senza attributo `alt` (un `alt` vuoto non conta: è un'immagine decorativa dichiarata). |
| `images_missing_dimensions` | numero | Senza `width` e `height`. |
| `images_bytes`, `images_heavy`, `images_legacy_format` | numeri | Peso scaricato, immagini oltre 200 KB, immagini in JPEG/PNG/GIF. **Solo per le pagine renderizzate.** |

### Dati strutturati

| Campo | Tipo | Significato |
|---|---|---|
| `schema_types` | elenco | Tipi presenti (JSON-LD e microdata). |
| `schema_formats` | elenco | `jsonld`, `microdata`, `rdfa`. |
| `schema_errors` | elenco | Blocchi JSON-LD non leggibili. |
| `schema_missing_required`, `schema_missing_recommended` | elenchi | `Tipo: proprietà`, secondo `data/schema-types.yaml`. |
| `schema_content_mismatch` | elenco | Valori dichiarati (nome, titolo, prezzo, domande) che non compaiono nel testo visibile. |

### Sorgente contro renderizzato

| Campo | Tipo | Significato |
|---|---|---|
| `rendered` | booleano | La pagina è stata renderizzata con il browser e letta. |
| `render_reason` | testo | Perché è stata renderizzata (sito sotto la soglia, campione del modello, sorgente sospetto, modello con differenze) o perché no. |
| `render_error` | testo | Errore del rendering, compresa la verifica anti-bot. |
| `raw_title`, `raw_description`, `raw_canonical`, `raw_robots_meta`, `raw_h1`, `raw_word_count`, `raw_schema_types`, `raw_outlinks_internal` | | Valori nell'HTML del server. |
| `diff_fields` | elenco | Campi diversi tra sorgente e renderizzato: `url`, `title`, `description`, `canonical`, `robots_meta`, `h1`, `lang`, `hreflang`, `schema_types`, `content`, `links`. `content` scatta oltre il 10% e 30 parole di differenza. |
| `js_only_fields` | elenco | Campi assenti nel sorgente e presenti solo dopo JavaScript. |
| `content_raw_ratio` | numero 0-1 | Parole del contenuto principale nel sorgente in rapporto al renderizzato: quanta parte si legge senza JavaScript. |
| `links_only_rendered`, `links_only_raw` | numeri | Link interni presenti solo dopo JavaScript, o solo nel sorgente. |
| `tracker_requests_blocked` | numero | Richieste di statistiche e pubblicità fermate durante il rendering. |

### Analisi tra pagine

| Campo | Tipo | Significato |
|---|---|---|
| `inlinks` | numero | Pagine del sito che la linkano (pagine distinte, esclusa sé stessa). |
| `orphan` | booleano | Pagina con risposta 200 non raggiungibile seguendo i link dal punto di partenza (nota da sitemap o elenco). Vuoto se i link non sono stati seguiti. |
| `outlinks_to_redirect`, `outlinks_to_error` | numeri | Destinazioni interne distinte che sono redirect, o in errore (pagine e file). |
| `outlinks_external_broken` | numero | Destinazioni esterne distinte che non rispondono (404, 410, 5xx, host inesistente). |
| `title_duplicates`, `description_duplicates` | numeri | Altre pagine **indicizzabili** con lo stesso valore. Vuoto se la pagina non è indicizzabile. |
| `content_duplicates` | numero | Altre pagine indicizzabili con contenuto principale identico (almeno 30 parole). |
| `near_duplicates` | numero | Altre pagine indicizzabili quasi uguali (simhash a 3 bit o meno, almeno 50 parole). |
| `duplicate_group` | testo | Indirizzo che rappresenta il gruppo di duplicati (il meno profondo, poi il più corto). Vuoto se la pagina è unica. |
| `canonical_issue` | elenco | Canonical verso redirect, errore, pagina non indicizzabile, pagina non scansionata, in catena; pagina in sitemap o indicata da hreflang ma con canonical altrove; canonical multipli o non validi. |
| `hreflang_reciprocal` | booleano | `false`: almeno un riferimento senza ritorno o verso una pagina non indicizzabile. Vuoto: nessun hreflang, o destinazioni non scansionate. |
| `hreflang_issues` | elenco | Ritorni mancanti, destinazioni non indicizzabili, codici lingua non validi, riferimento a sé stessa mancante. |
| `sitemap_issue` | testo | In sitemap ma non indicizzabile (con il motivo), oppure indicizzabile ma assente dalla sitemap. |
| `sitemap_lastmod` | testo | Data di modifica dichiarata in sitemap. |
| `url_params` | elenco | Nomi dei parametri nell'indirizzo. |
| `pagination` | testo | `pagina N` se l'indirizzo è una pagina di paginazione (`?page=N`, `/page/N`). |
| `param_duplicate_of` | testo | Indirizzo senza parametri di cui questa pagina è una copia (stesso contenuto o stesso title). |

### Incrocio con Search Console e GA4

Vuoti se la fonte non è stata fornita. Se è stata fornita, una pagina assente dai dati ha `0`.

| Campo | Tipo | Significato |
|---|---|---|
| `gsc_clicks`, `gsc_impressions` | numeri | Clic e impression della pagina nel periodo (ricerca web, tutti i paesi). Gli indirizzi con frammento (`#sezione`) sono sommati alla pagina. |
| `gsc_ctr` | numero 0-1 | Clic diviso impression. |
| `gsc_position` | numero | Posizione media, pesata sulle impression. |
| `ga4_sessions` | numero | Sessioni iniziate su questa pagina (pagina di destinazione), tutti i canali. |
| `ga4_organic_sessions` | numero | Di cui dalla ricerca organica (gruppo di canali "Organic Search"). |
| `ga4_key_events` | numero | Eventi chiave delle sessioni organiche iniziate su questa pagina. |
| `ga4_views` | numero | Visualizzazioni della pagina. |
| `traffic_issue` | testo | `riceve N impression e M clic ma non è indicizzabile: <motivo>`, oppure `indicizzabile ma senza impression nel periodo`. |

Il periodo e le proprietà usate sono in `manifest.json` (`traffic`) e in `site.json` (`traffic`). I dati di
Search Console per pagina sono completi (non sono soggetti all'anonimizzazione delle query).

Solo in `pages.json`: `headers` (intestazioni della risposta), `headings` (titoli in ordine: `[livello, testo]`),
`images_heaviest` (le cinque immagini più pesanti), `rendered_url` (indirizzo dopo il rendering).

Campi previsti dal passo 5: prestazioni, usabilità mobile, sicurezza.

## links

| Campo | Tipo | Significato |
|---|---|---|
| `source_url` | testo | Pagina che contiene il link (indirizzo finale, dopo i redirect). |
| `target_url` | testo | Destinazione, in forma canonica. |
| `anchor` | testo | Testo di ancoraggio; per un link fatto da un'immagine, il suo testo alternativo. |
| `rel` | testo | Attributo rel. |
| `nofollow` | booleano | |
| `is_internal` | booleano | Destinazione sul sito in esame. |
| `in_raw` | booleano | Presente nell'HTML del server. |
| `in_rendered` | booleano | Presente nel DOM dopo JavaScript. Vuoto se la pagina non è stata renderizzata. |
| `target_status` | numero | Codice della destinazione: dalla scansione, oppure dalla verifica dei link per siti esterni e file. |
| `target_final_url` | testo | Se la destinazione è un redirect, dove porta. |
| `placement` | `main` `nav` `header` `footer` `aside` `body` | Parte della pagina in cui si trova il link. |

## site.json

| Chiave | Contenuto |
|---|---|
| `traffic` | Incrocio con Search Console e GA4: `available`, `period`, `gsc` e `ga4` (fonte, proprietà, totali, quanta parte corrisponde a pagine visitate), `with_traffic_not_indexable` (pagine, clic, impression, per motivo, esempi in ordine di clic), `indexable_without_impressions`, `in_gsc_not_crawled`. |
| `checks` | Controlli con richieste dedicate: `robots` (stato, righe non riconosciute, sitemap dichiarate), `domain_variants` (le versioni http/https e con/senza www, e dove portano), `trailing_slash`, `not_found` (codice di un indirizzo inesistente), `llms_txt`, `ai_crawlers` (per ogni crawler di `data/ai-crawlers.yaml`: `accesso` consentito/bloccato/parziale, da quali regole, cosa è vietato). `null` se non eseguiti. |
| `robots` | `blocked_assets` (fogli di stile e script vietati a Googlebot), `blocked_sections` (sezioni con pagine vietate ma linkate o in sitemap). |
| `sitemap` | `files`, `entries`, `not_crawled`, `non_indexable` (per motivo), `indexable_missing`, `lastmod` (con data, non valide, nel futuro, valore più frequente, nota). |
| `links` | `internal_to_error`, `internal_to_redirect`, `external_broken` (ognuno: numero di link e destinazioni con quante pagine le linkano), `external_checked`, `external_unverifiable`. |
| `orphans` | `applicable`, `count`, `examples`. |
| `duplicates` | `titles`, `descriptions`, `content`, `near`: gruppi con valore, numero di pagine, indirizzi. |
| `parameters` | Per parametro: indirizzi, copie generate, esempi. |
| `pagination` | Pagine di paginazione, quante con canonical altrove, quante in noindex. |
| `hreflang` | Pagine con hreflang, lingue, non reciproche, codici non validi, esempi. |
| `geo.content_without_js` | Quota del contenuto principale già nell'HTML del server: media, pagine sotto la metà, per modello. |

## manifest.json

`schema_version`, `tool_version`, `cliente`, `status`, `started_at`, `ended_at`, `user_agent`, `seeds`,
`counts`, `traffic` (periodo, proprietà e totali dei dati di traffico; `null` se non forniti), `rendering` (criterio, pagine renderizzate, browser, richieste di tracciamento bloccate), `sitemaps`, `robots`, `sample`, `excluded` (link lasciati fuori, per motivo, con esempi),
`not_reached` (indirizzi scoperti e non visitati per i limiti), `not_verified` (frasi pronte per il report: cosa
non è stato verificato), `notes`.
