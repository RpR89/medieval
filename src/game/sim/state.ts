import type { UnitType } from '../data/buildings';
import { emptyResources, type Resources } from '../data/resources';
import { DAYS_PER_YEAR } from '../data/calendar';
import type { PresetId } from '../world/presets';
import type { Cost } from '../data/resources';
import type { Behavior, Formation, Stance } from '../data/units';
import { createLords, type Lord } from './lords';

export interface PlacedBuilding {
  uid: number;
  defId: string;
  x: number;
  z: number;
  /** Capi di bestiame (solo recinti). Valore continuo, si mostra arrotondato. */
  herd?: number;
  /** Punti vita attuali (solo fortificazioni). */
  hp?: number;
  /** Miglioramenti costruiti (id di UPGRADES). */
  upgrades?: string[];
  /** Proprietario per gli edifici dei signori controllati dal gioco (indice del signore). */
  owner?: number;
}

/** Rapporto dell'ultimo assedio, per l'interfaccia. */
export interface SiegeReport {
  day: number;
  attacker: string;
  outcome: 'repelled' | 'held' | 'sacked';
  log: string[];
  attackerLosses: number;
  defenderLosses: number;
  loot: number;
}

/** Forze di una spedizione: soldati e macchine d'assedio. */
export interface Force {
  infantry: number;
  archers: number;
  cavalry: number;
  rams: number;
  trebuchets: number;
}

export type Outcome = 'repelled' | 'held' | 'sacked';

/** Esito di un attacco, calcolato dal difensore e inviato all'attaccante. */
export interface AttackResult {
  id: string;
  outcome: Outcome;
  survivors: Force;
  loot: Cost;
  log: string[];
  attackerLosses: number;
  defenderLosses: number;
}

/** Spedizione in partenza dal proprio castello. */
export interface Expedition {
  id: string;
  troops: Force;
  stance: Stance;
  departDay: number;
  arriveDay: number;
  status: 'marching' | 'returning';
  returnDay?: number;
  result?: AttackResult;
}

/** Reparto di truppe sul campo, comandato dal giocatore. */
export interface Company {
  id: string;
  troops: Force;
  /** Posizione continua sulla mappa (in caselle). */
  x: number;
  z: number;
  /** Ordine corrente. */
  order: 'idle' | 'move' | 'attack' | 'home';
  /** Caselle ancora da percorrere. */
  path?: Array<[number, number]>;
  /** Bersaglio dell'attacco (casella di un edificio nemico). */
  target?: [number, number];
  /** Bottino trasportato. */
  cargo?: Cost;
  /** Impegnato in un assalto (id dell'attacco). */
  engaged?: string;
  heading?: number;
  formation?: Formation;
  behavior?: Behavior;
  /** Velocità imposta quando si marcia in gruppo (quella del più lento). */
  groupSpeed?: number;
  /** Proprietario per i reparti dei signori controllati dal gioco (indice del signore). */
  owner?: number;
  /** Diplomatico in missione (nessun soldato). */
  envoy?: { lord: number; mission: DiploMission; gift?: Cost };
}

export type DiploMission = 'alliance' | 'pact' | 'peace' | 'gift' | 'tribute' | 'war';

/** Esercito nemico in marcia verso il proprio castello. */
export interface IncomingAttack {
  id: string;
  from: string;
  troops: Force;
  stance: Stance;
  departDay: number;
  arriveDay: number;
  resolved?: AttackResult;
  /** Effetto della formazione degli assalitori: frecce subite e forza in mischia. */
  tactics?: { arrows: number; melee: number };
}

export type EventKind = 'info' | 'good' | 'bad';

export interface GameEvent {
  day: number;
  text: string;
  kind: EventKind;
}

export interface GameState {
  version: 1;
  seed: number;
  castleName: string;
  /** Giorni trascorsi dall'inizio (con decimali). */
  day: number;
  resources: Resources;
  population: number;
  buildings: PlacedBuilding[];
  army: Record<UnitType, number>;
  nextUid: number;
  nextRaidDay: number;
  log: GameEvent[];
  lastSiege?: SiegeReport;
  /** Tipo di mappa (default: classica). */
  preset?: PresetId;
  /** Partita multigiocatore: id e posto (0 = chi l'ha creata, 1 = chi si è unito). */
  match?: { id: string; slot: 0 | 1 };
  /** Signori controllati dal gioco (solo in giocatore singolo). */
  lords?: Lord[];
  /** Livello di tassazione (indice di TAX_LEVELS, default 2 = normale). */
  taxLevel?: number;
  /** Contento della popolazione, 0-100. */
  happiness?: number;
  /** Macchine d'assedio in deposito. */
  engines?: { rams: number; trebuchets: number };
  expeditions?: Expedition[];
  /** Reparti sul campo. */
  companies?: Company[];
  incoming?: IncomingAttack[];
  /** Ultimi rapporti delle spedizioni concluse. */
  campaignLog?: Array<{ day: number; text: string; outcome: Outcome; log: string[] }>;
}

export interface StateOptions {
  preset?: PresetId;
  match?: { id: string; slot: 0 | 1 };
  /** Numero di signori rivali (0-4), solo in giocatore singolo. */
  lords?: number;
}

export const BASE_HOUSING = 10;
export const BASE_STORAGE = 500;
export const FOOD_PER_PERSON = 0.1;
export const TAX_PER_PERSON = 0.04;

export function createInitialState(seed: number, castleName = 'Castello senza nome', opts: StateOptions = {}): GameState {
  const resources = emptyResources();
  Object.assign(resources, {
    coins: 300,
    wood: 220,
    stone: 60,
    grain: 150,
    vegetables: 40,
    meat: 30,
    hay: 80,
  });
  return {
    version: 1,
    seed,
    castleName,
    day: 0,
    resources,
    population: 20,
    buildings: [],
    army: { infantry: 0, archers: 0, cavalry: 0 },
    nextUid: 1,
    nextRaidDay: DAYS_PER_YEAR * 2 + 120,
    preset: opts.preset,
    match: opts.match,
    lords: !opts.match && opts.lords ? createLords(Math.min(4, opts.lords), seed) : undefined,
    log: [
      {
        day: 0,
        kind: 'info',
        text: 'Anno 900. Il tuo signore ti affida queste terre: costruisci una motta e proteggi la gente.',
      },
    ],
  };
}

/** Rende compatibili salvataggi vecchi o incompleti. */
export function migrateState(raw: unknown): GameState {
  const s = raw as Partial<GameState>;
  if (!s || typeof s !== 'object' || typeof s.seed !== 'number') {
    throw new Error('Salvataggio non valido');
  }
  const base = createInitialState(s.seed, s.castleName);
  return {
    ...base,
    ...s,
    resources: { ...emptyResources(), ...s.resources },
    army: { ...base.army, ...s.army },
    buildings: s.buildings ?? [],
    log: s.log ?? [],
    version: 1,
  } as GameState;
}
