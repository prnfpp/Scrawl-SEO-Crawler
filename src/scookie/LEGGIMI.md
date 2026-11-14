# Codice copiato da Scookie

Questi file vengono da [Scookie](https://github.com/prnfpp/Scookie---Scanner-Cookier), versione 0.1.2 (commit
`f5bcd4a` del ramo `main`), stesso titolare. Scrawl non dipende da Scookie: è una copia, e i due strumenti si
aggiornano ognuno per conto proprio.

| File qui | Origine in Scookie | Modifiche |
|---|---|---|
| `launch.ts` | `src/run.ts` (`launchOptions`, `resolveUserAgent`) | tipi delle impostazioni scritti qui, senza la configurazione dell'audit |
| `scroll.ts` | `src/browser/session.ts` (`scrollPage`) | esportata, secondo argomento facoltativo |
| `antibot.ts` | `src/browser/antibot.ts` | nessuna |
| `pages.ts` | `src/discovery/discover.ts` (`pageType`, `sectionsOf`, `sample`, `normalize`) | solo queste funzioni |
| `domains.ts` | `src/util/domains.ts` | tolta la distinzione prima/terza parte |
| `misc.ts`, `csv.ts` | `src/util/` | nessuna |
| `awake.ts` | `src/util/awake.ts` | testi dei messaggi |
| `style.ts` | `src/report/html.ts` (`CSS`, `esc`, `fmt`) | tolta la priorità dei rilievi |
| `banner/` | `src/cmp/` (`heuristic`, `dom`, `visibility`, `containers`) | tipi ridotti in `banner/types.ts` |
| `../../data/trackers.yaml` | `data/trackers.yaml` | nessuna |

**Non copiato**: gli adattatori dei singoli gestori del consenso, la personalizzazione, la revoca, l'analisi del
banner e la lettura dei cookie dichiarati. Sono costruiti intorno all'audit dei cookie (scenari, classificatore,
elenchi dichiarati). A Scrawl il banner serve solo per chiuderlo prima di uno screenshot: basta il riconoscimento
generico (`banner/heuristic.ts`), che copre i gestori più diffusi senza adattatori.

**Per riportare qui un miglioramento di Scookie** (un nuovo dominio in `trackers.yaml`, un nuovo sistema anti-bot):
ricopiare il file e aggiornare versione e commit in questa pagina.
