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
| `pagine.jsonl`, `link.jsonl`, `frontiera.jsonl`, `sitemap.jsonl`, `stato.json`, `registro.log` | dati di lavoro per la ripresa | no: non usarli come input |

I CSV usano la virgola, UTF-8, prima riga con i nomi dei campi. Vuoto = dato assente. Booleani: `true` / `false`.

## pages (stato: passo 2)

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

Solo in `pages.json`: `headers` (intestazioni della risposta a questo indirizzo).

Campi previsti dai passi successivi (nomi già fissati nella proposta): indicizzabilità (`robots_meta`,
`x_robots_tag`, `canonical`, `canonical_type`, `indexable`, `indexability_reason`), contenuto, confronto
sorgente/renderizzato (`rendered`, `render_reason`, `raw_*`, `rendered_*`, `diff_fields`), dati strutturati,
immagini, prestazioni, incrocio con Search Console e GA4.

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
| `in_rendered` | booleano | Presente nel DOM dopo JavaScript. Vuoto finché il rendering non c'è (passo 3). |
| `target_status` | numero | Codice della destinazione, se è stata visitata. |
| `target_final_url` | testo | Se la destinazione è un redirect, dove porta. |

## manifest.json

`schema_version`, `tool_version`, `cliente`, `status`, `started_at`, `ended_at`, `user_agent`, `seeds`,
`counts`, `sitemaps`, `robots`, `sample`, `excluded` (link lasciati fuori, per motivo, con esempi),
`not_reached` (indirizzi scoperti e non visitati per i limiti), `not_verified` (frasi pronte per il report: cosa
non è stato verificato), `notes`.
