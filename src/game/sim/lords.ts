import { getBuilding } from '../data/buildings';
import { mulberry32, isBuildableLand, tileAt, type Terrain } from '../world/terrain';
import type { Company, PlacedBuilding } from './state';
import type { FactionId } from '../data/factions';

/** Signori controllati dal gioco, con il loro castello sulla mappa. */

export type Personality = 'aggressive' | 'greedy' | 'peaceful' | 'honorable';
export type LordStatus = 'neutral' | 'war' | 'pact' | 'alliance' | 'vassal';

export interface Lord {
  id: number; // indice del sito sulla mappa (1..4)
  name: string;
  castle: string;
  personality: Personality;
  relation: number; // -100..100
  status: LordStatus;
  army: { infantry: number; archers: number; cavalry: number };
  wealth: number;
  level: number; // livello del castello 0..5 (dipende dal mastio costruito)
  buildings: PlacedBuilding[];
  companies: Company[];
  nextAction: number;
  nextUid: number;
  /** Scorte del signore (le monete sono `wealth`). */
  res?: LordResources;
  /** Abitanti del suo feudo. */
  pop?: number;
  /** Cantieri e lavori in corso. */
  jobs?: LordJob[];
  /** Schieramento del signore. */
  faction?: FactionId;
}

export interface LordResources {
  food: number;
  wood: number;
  stone: number;
  lime: number;
}

/** Lavoro dei costruttori di un signore. */
export interface LordJob {
  kind: 'build' | 'upgrade' | 'evolve';
  /** Edificio (nuovo o esistente). */
  uid: number;
  defId: string;
  x: number;
  z: number;
  upId?: string;
  to?: string;
  work: number;
  done: number;
}

export const PERSONALITIES: Record<Personality, { name: string; base: number; army: number; description: string }> = {
  aggressive: { name: 'Bellicoso', base: -25, army: 1.35, description: 'Ama la guerra: attacca chi gli sembra debole.' },
  greedy: { name: 'Avido', base: -5, army: 1.0, description: 'Si lascia comprare con i doni, ma pretende tributi.' },
  peaceful: { name: 'Pacifico', base: 20, army: 0.8, description: 'Preferisce i patti alla spada.' },
  honorable: { name: 'Leale', base: 10, army: 1.1, description: 'Mantiene la parola: alleato prezioso, nemico tenace.' },
};

export const STATUS_NAMES: Record<LordStatus, string> = {
  neutral: 'Neutrale',
  war: 'In guerra',
  pact: 'Patto di non aggressione',
  alliance: 'Alleato',
  vassal: 'Vassallo (paga tributo)',
};

const NAMES = [
  ['Guglielmo', 'di Monferrato'],
  ['Ottone', 'il Rosso'],
  ['Adalberto', 'd\'Ivrea'],
  ['Matilde', 'di Canossa'],
  ['Arduino', 'il Fiero'],
  ['Berengario', 'del Friuli'],
  ['Ugo', 'di Tuscia'],
  ['Ermengarda', 'di Susa'],
];
const PLACES = ['Rocca Nera', 'Castel Ferro', 'Monteforte', 'Torre Alta', 'Valdirupe', 'Castel Sereno', 'Roccaguelfa', 'Poggio d\'Oro'];

export function createLords(count: number, seed: number): Lord[] {
  const rand = mulberry32(seed ^ 0x51ed);
  const pers: Personality[] = ['aggressive', 'greedy', 'peaceful', 'honorable'];
  const names = [...NAMES].sort(() => rand() - 0.5);
  const places = [...PLACES].sort(() => rand() - 0.5);
  const lords: Lord[] = [];
  for (let i = 0; i < count; i++) {
    const p = pers[(i + Math.floor(rand() * 4)) % 4];
    const [n, t] = names[i];
    lords.push({
      id: i + 1,
      name: `${n} ${t}`,
      castle: places[i],
      personality: p,
      relation: PERSONALITIES[p].base,
      status: 'neutral',
      army: { infantry: 2, archers: 1, cavalry: 0 },
      wealth: 300,
      level: 0,
      res: { food: 150, wood: 220, stone: 60, lime: 0 },
      pop: 20,
      jobs: [],
      buildings: [],
      companies: [],
      nextAction: 360 * 4 + Math.floor(rand() * 600),
      nextUid: 1,
    });
  }
  return lords;
}

/** Livello del castello di un signore in base all'epoca (i bellicosi fortificano prima). */
export function lordLevel(year: number, p: Personality): number {
  const bonus = p === 'aggressive' || p === 'honorable' ? 20 : 0;
  const y = year + bonus;
  return y >= 1260 ? 5 : y >= 1160 ? 4 : y >= 1060 ? 3 : y >= 960 ? 2 : 1;
}

/**
 * Pianta del castello di un signore attorno al suo sito: mastio, anello di mura con due porte,
 * torri agli angoli dal livello 3, qualche casa dentro e campi fuori.
 */
export function lordCastle(terrain: Terrain, site: [number, number], level: number, seed: number): PlacedBuilding[] {
  const out: PlacedBuilding[] = [];
  const used = new Set<number>();
  const rand = mulberry32(seed);
  let uid = 1;
  const free = (x: number, z: number, w: number, d: number) => {
    for (let dz = 0; dz < d; dz++) for (let dx = 0; dx < w; dx++) {
      const t = tileAt(terrain, x + dx, z + dz);
      if (!isBuildableLand(t) || used.has((z + dz) * terrain.size + x + dx)) return false;
    }
    return true;
  };
  const put = (defId: string, x: number, z: number, upgrades: string[] = []) => {
    const [w, d] = getBuilding(defId).size;
    if (!free(x, z, w, d)) return;
    for (let dz = 0; dz < d; dz++) for (let dx = 0; dx < w; dx++) used.add((z + dz) * terrain.size + x + dx);
    const def = getBuilding(defId);
    out.push({ uid: uid++, defId, x, z, upgrades, ...(def.hp ? { hp: Math.round(def.hp * (upgrades.includes('thicken') ? 1.7 : 1)) } : {}) });
  };
  const [cx, cz] = site;
  const keepUps = level >= 5 ? ['great_hall', 'palace'] : level >= 4 ? ['great_hall'] : level === 2 ? ['bailey'] : [];
  put(level >= 3 ? 'keep_stone' : 'keep_wood', cx - 1, cz - 1, keepUps);
  const r = level >= 3 ? 6 : 5;
  if (level >= 3) {
    const tower = level >= 4 ? 'tower_round' : 'tower_square';
    for (const [x, z] of [[cx - r - 1, cz - r - 1], [cx + r, cz - r - 1], [cx - r - 1, cz + r], [cx + r, cz + r]]) put(tower, x, z, level >= 5 ? ['machicolation'] : []);
  }
  const wall = level >= 5 ? 'wall_curtain' : level >= 3 ? 'wall_stone' : level >= 2 ? 'palisade_double' : 'palisade';
  const wallUps = level >= 5 ? ['thicken'] : level >= 4 ? ['walkway', 'thicken'] : level >= 3 ? ['walkway'] : level >= 2 ? ['earthbank'] : [];
  const gate = level >= 4 ? 'gatehouse' : level >= 3 ? 'gate_stone' : level >= 2 ? 'gate_strong' : 'gate_wood';
  // Porte a est e a ovest (il corpo di guardia occupa due caselle)
  if (gate === 'gatehouse') {
    put(gate, cx + r - 1, cz - 1);
    put(gate, cx - r, cz - 1);
  } else {
    put(gate, cx + r, cz);
    put(gate, cx - r, cz);
  }
  for (let i = -r; i <= r; i++) {
    put(wall, cx + i, cz - r, wallUps);
    put(wall, cx + i, cz + r, wallUps);
    put(wall, cx - r, cz + i, wallUps);
    put(wall, cx + r, cz + i, wallUps);
  }
  // Case dentro la cinta
  const houses = 2 + level;
  for (let i = 0; i < houses * 3 && out.filter((b) => b.defId === 'hut' || b.defId === 'house').length < houses; i++) {
    const x = cx - r + 2 + Math.floor(rand() * (2 * r - 4));
    const z = cz - r + 2 + Math.floor(rand() * (2 * r - 4));
    if (Math.abs(x - cx) < 3 && Math.abs(z - cz) < 3) continue;
    put(level >= 3 && rand() < 0.5 ? 'house' : 'hut', x, z);
  }
  // Campi fuori dalle mura
  for (const [x, z] of [[cx - 3, cz + r + 2], [cx + 1, cz + r + 2], [cx - 3, cz - r - 5]]) put('field_grain', x, z);
  return out;
}
