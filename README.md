# Scrawl – crawler SEO tecnico

Scrawl scansiona un sito e produce la base dati tecnica su cui lavora la skill di pre-analisi SEO e GEO: una riga
per indirizzo, i link, i problemi. Descrive fatti e cause; raccomandazioni e priorità strategiche le scrive la skill.

Riusa il motore di navigazione di [Scookie](https://github.com/prnfpp/Scookie---Scanner-Cookier) (browser,
anti-bot, banner, tipologie di pagina, stile dei rapporti).

> **Stato: passo 3 di 8.** Funzionano la scansione, l'analisi di ogni pagina e il confronto tra l'HTML del server e
> la pagina dopo JavaScript. Controlli di sito, grafo dei link e duplicati, prestazioni, incrocio con Search Console
> e GA4 e rapporto per il cliente arrivano nei passi successivi.

## Installazione (una volta sola)

Servono [Node.js](https://nodejs.org) 22 o successivo e Git.

```sh
git clone <indirizzo del repository>
cd scrawl
npm install
npx playwright install chromium
```

Se Scookie è già installato sullo stesso computer, il browser è già presente e l'ultimo comando non scarica nulla.

## Uso

```sh
npm start
```

Si apre il browser su `http://127.0.0.1:4788`. La pagina funziona solo su questo computer; i dati dei clienti
restano in locale (`clienti/` e `runs/`, esclusi da git). Per chiudere: `Ctrl+C` nel Terminale.

- **Progetti** — un progetto per sito: da dove partire (dominio, sitemap o elenco di indirizzi), perimetro
  (sottodomini, cartelle, numero di pagine, profondità), modalità (completa o a campione), rispetto del sito.
- **Scansione** — avanzamento, pagine al minuto, tempo rimanente, ultimi indirizzi. **Metti in pausa** ferma la
  scansione; si può anche chiudere il programma: ciò che è stato scansionato resta e la scansione riprende da lì.
- **Risultati** — tutte le scansioni; per ognuna gli indirizzi filtrabili per esito, tipologia e testo, ciò che non
  è stato verificato, e i file di dati da scaricare.

## Cosa fa oggi

Ogni indirizzo viene letto due volte, e lo stesso estrattore gira su entrambe le letture:

1. **HTML del server**, senza eseguire JavaScript: codice di risposta, catena dei redirect, intestazioni.
2. **Pagina dopo JavaScript**, con il browser di Scookie.

Per ogni pagina: indicizzabilità con il motivo (robots.txt, noindex, canonical, redirect, errori), title e
description, H1 e gerarchia dei titoli, parole del contenuto principale, lingua e hreflang, immagini, link con testo
di ancoraggio e posizione, dati strutturati. E il confronto: cosa cambia dopo JavaScript e cosa esiste solo dopo.

**Quali pagine si renderizzano.** Fino a 500 pagine, tutte. Sopra: 20 pagine per tipologia, più quelle il cui
sorgente è sospetto (title assente, contenuto scarso, contenitore dell'applicazione vuoto, pochi link rispetto
alla tipologia); se in una tipologia almeno il 30% del campione cambia dopo JavaScript, tutte le sue pagine. Ogni
riga dice se è stata renderizzata e perché.

**Analytics del cliente.** Durante il rendering le richieste verso statistiche, pubblicità e registrazione delle
sessioni sono bloccate, anche quando passano dal dominio del cliente (`/g/collect`, `matomo.php`). Il banner di
consenso non viene mai accettato. Ogni riga riporta quante richieste sono state fermate. Limite: un tracciamento
fatto dal server sulla richiesta della pagina non si può bloccare; per quello si filtra lo user agent `ScrawlSEO`.

## Rispetto dei siti

Pausa tra le richieste allo stesso host (predefinita 500 ms), al massimo 2 richieste in parallelo, user agent che
dichiara lo strumento e un contatto, robots.txt rispettato. Se il server risponde 429 o 503 lo strumento aspetta e
allunga la pausa. robots.txt si può ignorare solo in modo esplicito, per i siti dei clienti: il rapporto lo dichiara.

## File prodotti

`runs/<cliente>/<data>/`: `pages.csv`, `pages.json`, `links.csv`, `manifest.json`. Il dizionario dei campi è in
[docs/FORMATO.md](docs/FORMATO.md). Il formato è versionato (`schema_version`) e le colonne sono bloccate da un test.

## Dipendenza da Scookie

`package.json` punta a un commit preciso di Scookie. Gli aggiornamenti di Scookie non toccano Scrawl finché non si
cambia quel riferimento: lo si alza apposta, dopo aver fatto girare i test.

## Sviluppo

```sh
npm test
```
