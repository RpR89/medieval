import type { Cost, ResourceId } from './resources';
import type { UnitType } from './buildings';

export interface UnitDef {
  id: UnitType;
  name: string;
  icon: string;
  cost: Cost;
  /** Mantenimento giornaliero per soldato. */
  upkeep: Partial<Record<ResourceId, number>>;
  attack: number;
  defense: number;
  /** Bonus difensivo per ogni torre presente (solo arcieri). */
  towerBonus?: number;
}

export const UNITS: Record<UnitType, UnitDef> = {
  infantry: {
    id: 'infantry',
    name: 'Fanteria',
    icon: '🛡️',
    cost: { coins: 20, wood: 5 },
    upkeep: { coins: 0.15 },
    attack: 3,
    defense: 4,
  },
  archers: {
    id: 'archers',
    name: 'Arcieri',
    icon: '🏹',
    cost: { coins: 25, wood: 12 },
    upkeep: { coins: 0.2 },
    attack: 4,
    defense: 3,
    towerBonus: 0.15,
  },
  cavalry: {
    id: 'cavalry',
    name: 'Cavalleria',
    icon: '🐎',
    cost: { coins: 60, hay: 30 },
    upkeep: { coins: 0.4, hay: 0.3 },
    attack: 9,
    defense: 5,
  },
};

/** Cibo consumato al giorno da ogni soldato (come un abitante, un po' di più). */
export const SOLDIER_FOOD = 0.12;
