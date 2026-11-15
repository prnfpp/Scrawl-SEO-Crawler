# Scrawl – crawler SEO tecnico

Scrawl scansiona un sito e produce la base dati tecnica su cui lavora la skill di pre-analisi SEO e GEO: una riga
per indirizzo, i link, i problemi. Descrive fatti e cause; raccomandazioni e priorità strategiche le scrive la skill.

Riusa, copiandole, parti del motore di navigazione di [Scookie](https://github.com/prnfpp/Scookie---Scanner-Cookier)
(browser, anti-bot, banner, tipologie di pagina, stile dei rapporti).

> **Stato: passi 1-4 e 6 di 8.** Funzionano la scansione, l'analisi di ogni pagina, il confronto tra l'HTML del
> server e la pagina dopo JavaScript, i controlli a livello di sito, il grafo dei link, i duplicati e l'incrocio
> con Search Console e GA4. Mancano prestazioni e mobile (passo 5) e il rapporto per il cliente (passo 7).

## Installazione (una volta sola)

Servono [Node.js](https://nodejs.org) 22 o successivo e Git.

```sh
git clone <indirizzo del repository>
cd scrawl
npm install
npx playwright install chromium
```

Se sullo stesso computer c'è già Scookie con la stessa versione di Playwright, il browser è già presente e
l'ultimo comando non scarica nulla.

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

**A livello di sito**: versioni del dominio e relativi redirect, barra finale, codice della pagina 404, robots.txt
(sintassi, risorse e sezioni bloccate), sitemap (indirizzi non indicizzabili, pagine assenti, date), link verso
errori e redirect, link esterni rotti, pagine orfane, duplicati di title, description e contenuto, parametri che
generano copie, paginazione, reciprocità degli hreflang.

**GEO**: per ogni crawler dei motori AI, se robots.txt lo lascia passare (elenco in `data/ai-crawlers.yaml`, con
la fonte e la data di verifica di ogni nome: si aggiorna lì, senza toccare il codice); presenza di `llms.txt`;
quanta parte del contenuto principale si legge senza JavaScript.

**Quali pagine si renderizzano.** Fino a 500 pagine, tutte. Sopra: 20 pagine per tipologia, più quelle il cui
sorgente è sospetto (title assente, contenuto scarso, contenitore dell'applicazione vuoto, pochi link rispetto
alla tipologia); se in una tipologia almeno il 30% del campione cambia dopo JavaScript, tutte le sue pagine. Ogni
riga dice se è stata renderizzata e perché.

**Analytics del cliente.** Durante il rendering le richieste verso statistiche, pubblicità e registrazione delle
sessioni sono bloccate, anche quando passano dal dominio del cliente (`/g/collect`, `matomo.php`). Il banner di
consenso non viene mai accettato. Ogni riga riporta quante richieste sono state fermate. Limite: un tracciamento
fatto dal server sulla richiesta della pagina non si può bloccare; per quello si filtra lo user agent `ScrawlSEO`.

## Search Console e GA4 (facoltativo)

Con i dati di traffico Scrawl dice quali pagine ricevono impression o visite ma non sono indicizzabili, quali sono
indicizzabili ma senza impression, e visita anche gli indirizzi che Google conosce e nessun link raggiunge.

**Via API, una volta sola.** Nella sezione Progetti, riquadro "Search Console e GA4":

1. In Google Cloud, nel progetto dove sono attive *Search Console API* e *Google Analytics Data API*, creare un
   ID client OAuth di tipo **App desktop** (API e servizi › Credenziali) e scaricare il file JSON.
2. Caricare il file in Scrawl e premere **Collega Google**. Si apre la pagina di Google: l'accesso richiesto è in
   sola lettura.
3. Nel progetto, indicare la proprietà di Search Console e l'ID della proprietà GA4.

Se la schermata di consenso del progetto Google Cloud è in stato "Test", l'indirizzo con cui si accede deve essere
tra gli utenti di test. Per scegliere la proprietà GA4 da un elenco serve anche la *Google Analytics Admin API*;
senza, l'ID si scrive a mano. Credenziali e token restano in `google/`, sul computer, esclusi da git.

**Da file.** Senza collegamento, nei risultati di una scansione: **Importa Search Console (CSV)** con il file
`Pagine.csv` dell'esportazione del rapporto Rendimento, e **Importa GA4 (CSV)** con un export che abbia la pagina
di destinazione (o il percorso della pagina) e le sessioni.

## Passare i risultati alla skill o a Claude

Nei risultati di una scansione, **Scarica tutto (zip)**: contiene `pages.csv`, `pages.json`, `links.csv`,
`site.json`, `manifest.json`, la configurazione e il registro.

## Rispetto dei siti

Pausa tra le richieste allo stesso host (predefinita 500 ms), al massimo 2 richieste in parallelo, robots.txt
rispettato. Lo user agent si imposta nel progetto: quello predefinito è quello del browser più `ScrawlSEO` e, se
indicato, un contatto; si può cambiare il nome o scriverlo per intero. Il manifest riporta quello usato. Se il server risponde 429 o 503 lo strumento aspetta e
allunga la pausa. robots.txt si può ignorare solo in modo esplicito, per i siti dei clienti: il rapporto lo dichiara.

## File prodotti

`runs/<cliente>/<data>/`: `pages.csv`, `pages.json`, `links.csv`, `site.json`, `manifest.json`. Il dizionario dei campi è in
[docs/FORMATO.md](docs/FORMATO.md). Il formato è versionato (`schema_version`) e le colonne sono bloccate da un test.

## Rapporto con Scookie

Scrawl non dipende da Scookie. Le parti del suo motore che servono (avvio del browser, anti-bot, tipologie di
pagina, riconoscimento dei banner, elenco dei tracker, stile dei rapporti) sono copiate in `src/scookie/` e in
`data/trackers.yaml`; provenienza e modifiche sono in [src/scookie/LEGGIMI.md](src/scookie/LEGGIMI.md). I due
strumenti si aggiornano ognuno per conto proprio.

## Sviluppo

```sh
npm test
```
