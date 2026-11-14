// Copiato da Scookie (prnfpp/Scookie---Scanner-Cookier, versione 0.1.2, commit f5bcd4a). Vedi src/scookie/LEGGIMI.md.

export type ChoiceLayer = 'primo-livello' | 'secondo-livello' | 'chiusura-x';

export type Choice = 'rifiuta' | 'accetta';

export interface ChoiceResult {
  ok: boolean;
  layer: ChoiceLayer | null;
  via: 'click' | 'api' | null;
  detail: string;
  /** Elementi cliccati, in ordine, con la loro descrizione. */
  clicked?: string[];
}
