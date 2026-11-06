import type { BuildingDef } from './buildings';
import { ERAS } from './eras';
import type { Cost, ResourceId } from './resources';

/**
 * Livelli degli edifici civili (case, campi, recinti, botteghe, cave, mercato, caserme).
 * Ogni epoca apre 4 nuovi livelli: 4 nel 900, 8 dal 1050… fino a 20 nel Tardo Medioevo.
 * Ogni livello migliora la resa e cambia l'aspetto dell'edificio.
 */
export const LEVELS_PER_ERA = 4;

const LEVELABLE = new Set(['housing', 'farming', 'animals', 'gathering', 'industry', 'trade', 'military']);

export function isLevelable(def: BuildingDef): boolean {
  return LEVELABLE.has(def.category) && !def.fort && !def.road && !def.vision;
}

/** Indice dell'epoca (0-4) per un anno. */
export function eraIndex(year: number): number {
  let i = 0;
  ERAS.forEach((e, k) => {
    if (year >= e.fromYear) i = k;
  });
  return i;
}

/** Livello massimo raggiungibile in un anno. */
export function maxLevelFor(year: number): number {
  return LEVELS_PER_ERA * (eraIndex(year) + 1);
}

/** Epoca a cui appartiene un livello (0 per 1-4, 1 per 5-8…). */
export function levelTier(level: number): number {
  return Math.min(ERAS.length - 1, Math.floor((Math.max(1, level) - 1) / LEVELS_PER_ERA));
}

/** Nome leggibile del livello. */
export function levelName(level: number): string {
  const t = levelTier(level);
  return `Livello ${level} · ${ERAS[t].name} ${((level - 1) % LEVELS_PER_ERA) + 1}/${LEVELS_PER_ERA}`;
}

/** Effetti del livello: moltiplicatori di produzione, alloggi, magazzini, capi e lavoratori. */
export function levelEffects(level: number) {
  const l = Math.max(1, level) - 1;
  return {
    production: 1 + 0.08 * l,
    housing: 1 + 0.1 * l,
    storage: 1 + 0.1 * l,
    herd: 1 + 0.08 * l,
    workers: 1 + 0.04 * l,
  };
}

/**
 * Costo per salire dal livello `level` al successivo: una parte del costo dell'edificio,
 * più i materiali della nuova epoca (pietra, calce, monete).
 */
export function levelUpCost(def: BuildingDef, level: number): Cost {
  const next = level + 1;
  const t = levelTier(next);
  const out: Cost = {};
  const add = (id: ResourceId, n: number) => {
    if (n > 0) out[id] = Math.ceil((out[id] ?? 0) + n);
  };
  const f = 0.3 + 0.08 * level;
  for (const [id, n] of Object.entries(def.cost)) add(id as ResourceId, (n ?? 0) * f);
  add('wood', 4 + level * 1.5);
  add('coins', 3 + level * 2);
  if (t >= 1) add('stone', 3 + level * 1.5);
  if (t >= 2) add('lime', 1 + level * 0.5);
  if (t >= 3) add('coins', level * 3);
  if (t >= 4) add('stone', level);
  return out;
}
