import type { UnitType } from '../data/buildings';
import { emptyResources, type Resources } from '../data/resources';
import { DAYS_PER_YEAR } from '../data/calendar';

export interface PlacedBuilding {
  uid: number;
  defId: string;
  x: number;
  z: number;
  /** Capi di bestiame (solo recinti). Valore continuo, si mostra arrotondato. */
  herd?: number;
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
}

export const BASE_HOUSING = 10;
export const BASE_STORAGE = 500;
export const FOOD_PER_PERSON = 0.1;
export const TAX_PER_PERSON = 0.04;

export function createInitialState(seed: number, castleName = 'Castello senza nome'): GameState {
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
