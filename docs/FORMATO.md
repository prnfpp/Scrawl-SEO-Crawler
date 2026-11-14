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
| `manifest.json` | versione del formato, perimetro, limiti, cosa non è stato verificato | sì |
| `config.yaml` | configurazione usata (copia: la ripresa usa questa) | sì |
| `pagine.jsonl`, `link.jsonl`, `render.jsonl`, `link-render.jsonl`, `frontiera.jsonl`, `sitemap.jsonl`, `stato.json`, `registro.log` | dati di lavoro per la ripresa | no: non usarli come input |

**CSV**: separatore `;`, UTF-8 con BOM (si aprono in Excel con impostazioni italiane), prima riga con i nomi dei
campi. Vuoto = dato assente. Booleani: `true` / `false`. Elenchi: valori separati da ` | `. Una cella che inizia
con `=`, `+`, `-` o `@` ha un apostrofo davanti, perché Excel non la legga come formula.

**JSON**: stessi campi, con i tipi veri (numeri, booleani, elenchi) e senza apostrofi. **Per le elaborazioni con
codice usare `pages.json`**; i CSV sono per la lettura in un foglio di calcolo.

**Sorgente e renderizzato.** I campi senza prefisso (`title`, `canonical`, `h1`, `word_count`…) sono il valore che
conta: quello del DOM dopo JavaScript se `rendered` è `true`, altrimenti quello dell'HTML del server. I campi
`raw_*` sono sempre l'HTML del server. `diff_fields` dice quali campi cambiano tra i due.

## pages (stato: passo 3)

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
| `depth` | numero | Clic dal punto di partenza. Vuoto: finora non raggiungibile dai link (nota solo da sitemap o elenco). Al passo 4 viene ricalcolata sul grafo dei link. |
| `source` | `partenza` `link` `sitemap` `elenco` `redirect` | Come è stato scoperto l'indirizzo. Se è in sitemap ma anche raggiunto da un link: `link`. |
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

Al passo 4 si aggiungono i controlli che richiedono altre pagine: canonical verso una pagina non indicizzabile,
conflitti con sitemap e hreflang.

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
| `hreflang`, `hreflang_count` | elenco, numero | CSV: `it=url \| en=url`. JSON: elenco di `{lang, href}`. La reciprocità arriva al passo 4. |
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

Solo in `pages.json`: `headers` (intestazioni della risposta), `headings` (titoli in ordine: `[livello, testo]`),
`images_heaviest` (le cinque immagini più pesanti), `rendered_url` (indirizzo dopo il rendering).

Campi previsti dai passi successivi: duplicati di title e contenuto, link in entrata e pagine orfane, reciprocità
hreflang, prestazioni, usabilità mobile, sicurezza, incrocio con Search Console e GA4.

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
| `target_status` | numero | Codice della destinazione, se è stata visitata. |
| `target_final_url` | testo | Se la destinazione è un redirect, dove porta. |
| `placement` | `main` `nav` `header` `footer` `aside` `body` | Parte della pagina in cui si trova il link. |

## manifest.json

`schema_version`, `tool_version`, `cliente`, `status`, `started_at`, `ended_at`, `user_agent`, `seeds`,
`counts`, `rendering` (criterio, pagine renderizzate, browser, richieste di tracciamento bloccate), `sitemaps`, `robots`, `sample`, `excluded` (link lasciati fuori, per motivo, con esempi),
`not_reached` (indirizzi scoperti e non visitati per i limiti), `not_verified` (frasi pronte per il report: cosa
non è stato verificato), `notes`.
