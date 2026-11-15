# Changelog

Le modifiche al formato dei file di dati (input della skill SEO) hanno una voce **Formato**.

## Non rilasciato — passo 4: controlli di sito, grafo dei link, duplicati

- Grafo dei link: link in entrata, profondità ricalcolata sul cammino più breve, pagine orfane, link verso
  redirect ed errori.
- Verifica dei link verso indirizzi non scansionati: file del sito (PDF, immagini) e siti esterni.
- Duplicati tra pagine indicizzabili: title, description, contenuto identico e quasi uguale (simhash).
- Canonical e hreflang tra pagine: canonical verso pagine non indicizzabili o in catena, conflitti con sitemap e
  hreflang, reciprocità degli hreflang, codici lingua non validi.
- Sitemap: indirizzi non indicizzabili, pagine indicizzabili assenti, plausibilità delle date.
- Parametri di URL che generano copie, paginazione.
- robots.txt: sintassi, risorse (CSS e JS) e sezioni bloccate, sitemap dichiarata.
- Dominio: versioni http/https e con/senza www, barra finale, codice della pagina 404.
- GEO: accesso dei crawler AI da `data/ai-crawlers.yaml` (25 nomi, 24 letti il 2026-11-15 sulle pagine ufficiali),
  `llms.txt`, quota del contenuto leggibile senza JavaScript.
- Interfaccia: riquadro "Controlli a livello di sito", filtri per orfane, duplicati, link rotti, canonical.
- **Formato** (`schema_version` 0): 18 colonne nuove in `pages`, nuovo file `site.json`. `depth` ora è la
  profondità sul grafo dei link (prima era quella vista durante la scansione). `target_status` in `links` vale
  anche per esterni e file.

## Passo 3: estrazione per pagina, sorgente contro renderizzato

- Per ogni pagina: title, description, canonical, direttive robots (meta e intestazione), H1 e gerarchia dei titoli,
  contenuto principale, lingua e hreflang, immagini, link con posizione nella pagina, dati strutturati (JSON-LD e
  microdata: sintassi, proprietà obbligatorie e consigliate da `data/schema-types.yaml`, coerenza con il testo).
- Esito di indicizzabilità per pagina, con il motivo.
- Rendering con il browser di Scookie e confronto campo per campo con l'HTML del server. I link che esistono solo
  dopo JavaScript entrano in coda. Sopra la soglia (500 pagine): campione per modello, pagine con sorgente
  sospetto, modelli con differenze.
- Analytics dei clienti: richieste di statistiche e pubblicità bloccate durante il rendering (elenco di Scookie più
  invii riconoscibili dal percorso), contate per pagina.
- Lo user agent è quello del browser reale, uguale per le due letture.
- Interfaccia: filtri "non indicizzabili", "cambiano dopo JavaScript", "dati strutturati con errori"; scheda della
  pagina con sorgente e renderizzato affiancati.
- **Nessuna dipendenza da Scookie.** Le parti del suo motore che servono sono copiate in `src/scookie/` e
  `data/trackers.yaml` (provenienza in `src/scookie/LEGGIMI.md`). Scookie non va modificato.
- **Formato** (`schema_version` 0): 54 colonne nuove in `pages` dopo le 21 esistenti, `placement` in `links`,
  `rendering` nel manifest. Corretto il documento: i CSV usano `;` con BOM, non la virgola (era già così).

## 0.1.0 — passo 2: motore di scansione

- Coda degli indirizzi un livello alla volta, perimetro (sottodomini, cartelle incluse ed escluse, limiti di pagine
  e profondità), partenza da dominio, sitemap o elenco, modalità completa o a campione.
- Rispetto del sito: pausa per host, richieste in parallelo limitate, user agent dichiarato, robots.txt rispettato
  (ignorabile in modo esplicito), Crawl-delay, rallentamento su 429 e 503.
- Salvataggio riga per riga, pausa e ripresa anche dopo una chiusura improvvisa.
- Interfaccia locale: Progetti, Scansione, Risultati.
- **Formato** (`schema_version` 0): prime colonne di `pages` e `links`, `manifest.json`. Vedi `docs/FORMATO.md`.
