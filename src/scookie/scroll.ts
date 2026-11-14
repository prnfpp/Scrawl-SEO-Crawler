// Copiato da Scookie (prnfpp/Scookie---Scanner-Cookier, versione 0.1.2, commit f5bcd4a). Vedi src/scookie/LEGGIMI.md.
import type { Page } from 'playwright';

/**
 * Scorre la pagina a passi come un visitatore: movimento del mouse e rotella reali (eventi mousemove e wheel),
 * non solo lo scroll via script, che genera solo l'evento scroll. Alcuni siti caricano gli script alla prima
 * interazione e li attivano anche con la rotella (es. plugin di ottimizzazione che ritardano gli script). Se la rotella non
 * sposta la pagina (cursore su un riquadro scorrevole, scroll bloccato) si scorre via script. Alla fine torna in cima.
 */
export async function scrollPage(page: Page, onFirstInteraction: () => void = () => {}) {
  const vp = page.viewportSize() ?? { width: 1366, height: 900 };
  try {
    // Nella parte alta del contenuto, lontano dal fondo dove stanno di solito i banner; il mouse non clicca nulla.
    // Il primo movimento porta il cursore sopra la pagina, come per un visitatore qualsiasi: non è un'interazione e
    // ciò che ne deriva resta "al caricamento". L'interazione inizia con il movimento successivo e la rotella.
    await page.mouse.move(vp.width * 0.3, vp.height * 0.3);
    await page.waitForTimeout(250);
    onFirstInteraction();
    await page.mouse.move(vp.width * 0.6, vp.height * 0.4, { steps: 8 });
    const step = Math.max(200, Math.floor(vp.height * 0.8));
    for (let i = 0; i < 12; i++) {
      const before = await page.evaluate(() => window.scrollY);
      await page.mouse.wheel(0, step);
      await page.waitForTimeout(300);
      const atBottom = await page.evaluate(
        ([prev, s]) => {
          if (window.scrollY === prev) window.scrollBy(0, s);
          return window.innerHeight + window.scrollY >= document.body.scrollHeight - 5;
        },
        [before, step] as const,
      );
      if (atBottom) break;
    }
    await page.evaluate(() => window.scrollTo(0, 0));
  } catch {
    // pagina cambiata o chiusa durante lo scroll: si prosegue con quanto raccolto
  }
}
