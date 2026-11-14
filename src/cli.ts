#!/usr/bin/env node
import { startUi } from './ui/server.js';

/** Avvio dell'interfaccia: `npm start` (o l'icona). Opzioni: --porta N, --cartella PERCORSO, --no-apri. */
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const port = Number(opt('--porta') ?? 4788);
const root = opt('--cartella') ?? process.cwd();

try {
  const ui = await startUi({ port, root, open: !args.includes('--no-apri') });
  console.log(`Scrawl è aperto su ${ui.url}\nLa pagina funziona solo su questo computer. Per chiudere: Ctrl+C.`);
  const stop = () => {
    console.log('\nChiusura: la scansione in corso si può riprendere al prossimo avvio.');
    void ui.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  console.error(err.code === 'EADDRINUSE' ? `La porta ${port} è occupata: forse Scrawl è già aperto su http://127.0.0.1:${port}` : err.message);
  process.exit(1);
}
