import type { ResourceId } from './resources';
import type { SeasonalCurve, Species } from './buildings';

export interface AnimalDef {
  species: Species;
  /** Prodotti giornalieri per capo (moltiplicati per la curva stagionale). */
  daily: Partial<Record<ResourceId, number>>;
  dailySeasonal: SeasonalCurve;
  /** Foraggio consumato per capo al giorno in inverno (nelle altre stagioni pascolano). */
  winterFeed: Partial<Record<ResourceId, number>>;
  /** Crescita del branco per stagione (frazione), per stagione [pri, est, aut, inv]. */
  birthRate: SeasonalCurve;
  /** Resa della macellazione per capo. */
  slaughter: Partial<Record<ResourceId, number>>;
  /** Frazione del branco macellata all'inizio dell'inverno (tradizione). */
  winterCull: number;
}

export const ANIMALS: Record<Species, AnimalDef> = {
  cattle: {
    species: 'cattle',
    daily: { milk: 0.5 },
    dailySeasonal: [1.1, 1, 0.8, 0.4],
    winterFeed: { hay: 0.25 },
    birthRate: [0.3, 0.05, 0, 0],
    slaughter: { meat: 40, hides: 2 },
    winterCull: 0.1,
  },
  pigs: {
    species: 'pigs',
    daily: {},
    dailySeasonal: [1, 1, 1, 1],
    winterFeed: { grain: 0.05 },
    birthRate: [0.6, 0.4, 0, 0],
    slaughter: { meat: 25, hides: 1 },
    winterCull: 0.45,
  },
  goats: {
    species: 'goats',
    daily: { milk: 0.15, wool: 0.03 },
    dailySeasonal: [1.2, 1, 0.8, 0.5],
    winterFeed: { hay: 0.06 },
    birthRate: [0.5, 0.1, 0, 0],
    slaughter: { meat: 8, hides: 1 },
    winterCull: 0.15,
  },
};
