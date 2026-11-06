import type { PresetId } from '../world/presets';
import type { ResourceId } from './resources';

/** Schieramenti tra cui scegliere all'inizio: città e signorie del Veneto e del Friuli. */
export type FactionId = 'verona' | 'padova' | 'venezia' | 'aquileia' | 'cividale' | 'gorizia';

export interface FactionEffects {
  /** Moltiplicatori della produzione per risorsa. */
  produce?: Partial<Record<ResourceId, number>>;
  /** Costo delle fortificazioni in pietra (mura, torri, porte, mastio). */
  stoneFortCost?: number;
  /** Gettito delle tasse. */
  taxes?: number;
  /** Frequenza e forza degli assalti dei predoni. */
  raids?: number;
  /** Crescita della popolazione. */
  growth?: number;
  /** Velocità dei costruttori, dall'anno indicato. */
  builders?: { mul: number; from: number };
  /** Prezzi al mercato: acquisto e vendita. */
  buy?: number;
  sell?: number;
  /** Fossati sempre allagati. */
  floodedMoats?: boolean;
  /** Forza della guarnigione durante gli assedi. */
  siegeDefense?: number;
  /** Arcieri più efficaci in difesa. */
  archers?: number;
  /** Punti vita delle fortificazioni. */
  fortHp?: number;
  /** Difesa di torri e mastio. */
  towerDefense?: number;
  /** Costo della cavalleria. */
  cavalryCost?: number;
  /** Contento della popolazione (punti). */
  mood?: number;
  /** Sconto sui miglioramenti del mastio (sala grande, palazzo). */
  hallCost?: number;
  /** Rapporti iniziali con i signori ed efficacia dei diplomatici. */
  relations?: number;
  diplomacy?: number;
  /** Risorse di partenza in più o in meno. */
  start?: Partial<Record<ResourceId, number>>;
  /** Moltiplicatore delle monete di partenza. */
  startCoins?: number;
  /** Primo assalto anticipato (giorni). */
  earlyRaid?: number;
}

export interface FactionDef {
  id: FactionId;
  name: string;
  /** Stemma: due colori e un simbolo. */
  colors: [string, string];
  symbol: string;
  region: string;
  description: string;
  /** Mappa consigliata. */
  preset: PresetId;
  bonus: string[];
  malus: string[];
  effects: FactionEffects;
}

export const FACTIONS: Record<FactionId, FactionDef> = {
  verona: {
    id: 'verona',
    name: 'Verona',
    colors: ['#c8102e', '#f2c230'],
    symbol: '🪜',
    region: 'Sull\'Adige, porta del Brennero',
    description: 'Città romana di pietra e marmo rosso, crocevia delle strade tra la Germania e la pianura.',
    preset: 'valle',
    bonus: ['Cave di calcare e marmo: pietra +25%', 'Mura, torri e porte in pietra −15% di costo', 'Crocevia di strade: tasse +10%'],
    malus: ['Prima città sulla via delle invasioni da nord: assalti più frequenti e più forti (+20%)'],
    effects: { produce: { stone: 1.25 }, stoneFortCost: 0.85, taxes: 1.1, raids: 1.2 },
  },
  padova: {
    id: 'padova',
    name: 'Padova',
    colors: ['#b8102b', '#ffffff'],
    symbol: '✚',
    region: 'Pianura del Brenta e del Bacchiglione',
    description: 'Terre fertilissime e una città che crescerà fino a fondare, nel 1222, il suo celebre Studio.',
    preset: 'pianura',
    bonus: ['Terre fertili: campi, ortaggi e fieno +25%', 'La popolazione cresce più in fretta (+30%)', 'Dal 1222 lo Studio: costruttori +15% più rapidi'],
    malus: ['Niente roccia vicina: pietra −30%', 'Nessuna difesa naturale'],
    effects: { produce: { grain: 1.25, vegetables: 1.25, hay: 1.25, stone: 0.7 }, growth: 1.3, builders: { mul: 1.15, from: 1222 } },
  },
  venezia: {
    id: 'venezia',
    name: 'Venezia',
    colors: ['#a6192e', '#e8b730'],
    symbol: '🦁',
    region: 'Laguna veneta',
    description: 'Città di mercanti e marinai protetta dall\'acqua: ricca di commerci, povera di terra.',
    preset: 'costa',
    bonus: ['Commercio: si compra −15% e si vende +15% al mercato', 'Pesca +40%', 'Fossati sempre allagati e laguna: difesa negli assedi +15%'],
    malus: ['Poca terra: campi −20%, legna −30%, pietra −40%', 'Cavalleria più cara (+30%)'],
    effects: {
      produce: { fish: 1.4, grain: 0.8, vegetables: 0.8, hay: 0.8, wood: 0.7, stone: 0.6 },
      buy: 0.85,
      sell: 1.15,
      floodedMoats: true,
      siegeDefense: 1.15,
      cavalryCost: 1.3,
    },
  },
  aquileia: {
    id: 'aquileia',
    name: 'Aquileia',
    colors: ['#f2c230', '#1f3f8f'],
    symbol: '🦅',
    region: 'Patriarcato, foce dell\'Isonzo',
    description: 'Antica metropoli romana e sede del Patriarca: rovine da cui cavare pietra, paludi tutt\'intorno.',
    preset: 'costa',
    bonus: ['Rovine romane: +150 pietra all\'inizio', 'Sede del Patriarca: contento +10', 'Sala grande e palazzo −20% di costo'],
    malus: ['Paludi e malaria: popolazione −15% più lenta', 'Esposta agli Ungari: il primo assalto arriva prima'],
    effects: { start: { stone: 150 }, mood: 10, hallCost: 0.8, growth: 0.85, earlyRaid: 240 },
  },
  cividale: {
    id: 'cividale',
    name: 'Cividale',
    colors: ['#1f6f3f', '#f2e6c8'],
    symbol: '🗡️',
    region: 'Valle del Natisone',
    description: 'Antica sede del ducato longobardo, tra colline boscose e la forra del Natisone.',
    preset: 'valle',
    bonus: ['Colline boscose: legna +25%', 'Mura e torri su terreno alto: punti vita +15%', 'Arcieri +15% in difesa'],
    malus: ['Terra povera: campi −15%', 'Lontana dai commerci: mercato −10%'],
    effects: { produce: { wood: 1.25, grain: 0.85, vegetables: 0.85 }, fortHp: 1.15, archers: 1.15, buy: 1.1, sell: 0.9 },
  },
  gorizia: {
    id: 'gorizia',
    name: 'Gorizia',
    colors: ['#1f3f8f', '#f2f2f2'],
    symbol: '🦁',
    region: 'Contea di confine sull\'Isonzo',
    description: 'Castello sul colle e contea di frontiera tra l\'Impero, il Patriarcato e Venezia.',
    preset: 'montana',
    bonus: ['Castello sul colle: torri e mastio +20% di difesa', 'Terra di confine: rapporti +15 con i signori, diplomatici più efficaci', 'Cavalleria −20% di costo'],
    malus: ['Contea piccola e povera: monete di partenza −30%', 'Tasse −10%'],
    effects: { towerDefense: 1.2, relations: 15, diplomacy: 1.25, cavalryCost: 0.8, startCoins: 0.7, taxes: 0.9 },
  },
};

export const FACTION_LIST: FactionDef[] = Object.values(FACTIONS);

export function factionEffects(id: FactionId | undefined): FactionEffects {
  return id ? FACTIONS[id]?.effects ?? {} : {};
}
