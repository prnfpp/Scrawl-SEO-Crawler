# Scrawl – crawler SEO tecnico

Scrawl scansiona un sito e produce la base dati tecnica su cui lavora la skill di pre-analisi SEO e GEO: una riga
per indirizzo, i link, i problemi. Descrive fatti e cause; raccomandazioni e priorità strategiche le scrive la skill.

Riusa il motore di navigazione di [Scookie](https://github.com/prnfpp/Scookie---Scanner-Cookier) (browser,
anti-bot, banner, tipologie di pagina, stile dei rapporti).

> **Stato: passo 2 di 8.** Funzionano la scansione (coda, perimetro, pausa e ripresa, salvataggio) e l'interfaccia.
> L'analisi della pagina, il rendering con il browser, i controlli di sito, le prestazioni, l'incrocio con Search
> Console e GA4 e il rapporto arrivano nei passi successivi.

## Installazione (una volta sola)

Servono [Node.js](https://nodejs.org) 22 o successivo e Git.

```sh
git clone <indirizzo del repository>
cd scrawl
npm install
```

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

Per ogni indirizzo: codice di risposta, catena dei redirect (singolo, in catena, in loop), destinazione finale,
blocco da robots.txt, presenza in sitemap, profondità, tipologia di pagina, link in uscita con testo di
ancoraggio e nofollow.

Legge l'HTML ricevuto dal server, senza eseguire JavaScript: nessuna visita arriva agli analytics del cliente.

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
