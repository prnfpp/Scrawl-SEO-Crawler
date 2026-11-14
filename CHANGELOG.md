# Changelog

Le modifiche al formato dei file di dati (input della skill SEO) hanno una voce **Formato**.

## 0.1.0 — passo 2: motore di scansione

- Coda degli indirizzi un livello alla volta, perimetro (sottodomini, cartelle incluse ed escluse, limiti di pagine
  e profondità), partenza da dominio, sitemap o elenco, modalità completa o a campione.
- Rispetto del sito: pausa per host, richieste in parallelo limitate, user agent dichiarato, robots.txt rispettato
  (ignorabile in modo esplicito), Crawl-delay, rallentamento su 429 e 503.
- Salvataggio riga per riga, pausa e ripresa anche dopo una chiusura improvvisa.
- Interfaccia locale: Progetti, Scansione, Risultati.
- **Formato** (`schema_version` 0): prime colonne di `pages` e `links`, `manifest.json`. Vedi `docs/FORMATO.md`.
