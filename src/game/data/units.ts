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
    cost: { coins: 20, wood: 5, weapons: 1 },
    upkeep: { coins: 0.15 },
    attack: 3,
    defense: 4,
  },
  archers: {
    id: 'archers',
    name: 'Arcieri',
    icon: '🏹',
    cost: { coins: 25, wood: 12, weapons: 1 },
    upkeep: { coins: 0.2 },
    attack: 4,
    defense: 3,
    towerBonus: 0.15,
  },
  cavalry: {
    id: 'cavalry',
    name: 'Cavalleria',
    icon: '🐎',
    cost: { coins: 60, hay: 30, weapons: 2 },
    upkeep: { coins: 0.4, hay: 0.3 },
    attack: 9,
    defense: 5,
  },
};

/** Cibo consumato al giorno da ogni soldato (come un abitante, un po' di più). */
export const SOLDIER_FOOD = 0.12;

/** Carro delle salmerie: porta i viveri del castello dietro all'esercito (e lo rallenta un po'). */
export const WAGON = {
  name: 'Carro delle salmerie',
  icon: '🛒',
  cost: { wood: 40, coins: 25 },
  /** Unità di cibo trasportate. */
  capacity: 250,
  /** Caselle al giorno (prima della scala del tempo): poco più lento dei fanti. */
  speed: 1.0,
};

// ───────────── Macchine d'assedio e spedizioni ─────────────

export type EngineType = 'rams' | 'trebuchets';

export interface EngineDef {
  id: EngineType;
  name: string;
  icon: string;
  cost: Cost;
  upkeep: Partial<Record<ResourceId, number>>;
  minYear: number;
  /** Velocità di marcia in caselle al giorno (le macchine rallentano l'esercito). */
  speed: number;
  description: string;
}

export const ENGINES: Record<EngineType, EngineDef> = {
  rams: {
    id: 'rams',
    name: 'Ariete',
    icon: '🪵',
    cost: { wood: 60, coins: 40 },
    upkeep: { coins: 0.2 },
    minYear: 1000,
    speed: 0.9,
    description: 'Tronco ferrato sotto una tettoia: sfonda le porte.',
  },
  trebuchets: {
    id: 'trebuchets',
    name: 'Trabucco',
    icon: '🎯',
    cost: { wood: 150, stone: 30, coins: 120 },
    upkeep: { coins: 0.5 },
    minYear: 1200,
    speed: 0.6,
    description: 'Macchina a contrappeso: bombarda le mura prima dell\'assalto.',
  },
};

/** Velocità di marcia delle truppe (caselle al giorno). */
/** Caselle al giorno (prima della scala del tempo): marce lente, il terreno e le strade contano. */
export const MARCH_SPEED: Record<UnitType, number> = { infantry: 1.2, archers: 1.2, cavalry: 2.1 };

/** Bottino trasportabile per soldato sopravvissuto. */
export const CARRY: Record<UnitType, number> = { infantry: 12, archers: 10, cavalry: 25 };

/** Quanto l'esercito insiste prima di ritirarsi (quota di perdite accettata). */
export const STANCES = {
  cautious: { name: 'Prudente', morale: 0.3, description: 'Si ritira al 30% di perdite.' },
  resolute: { name: 'Deciso', morale: 0.5, description: 'Si ritira al 50% di perdite.' },
  allin: { name: 'All\'ultimo uomo', morale: 0.85, description: 'Combatte quasi fino alla fine.' },
} as const;

export type Stance = keyof typeof STANCES;

// ───────────── Formazioni e comportamenti dei reparti ─────────────

export type Formation = 'line' | 'column' | 'wedge' | 'square' | 'shields';

export interface FormationDef {
  id: Formation;
  name: string;
  icon: string;
  description: string;
  /** Moltiplicatore della velocità di marcia. */
  speed: number;
  /** Forza in attacco e tenuta in difesa (scontri in campo aperto). */
  attack: number;
  defense: number;
  /** Quota di perdite da frecce subite (1 = normali). */
  arrows: number;
  /** Bonus contro le cariche di cavalleria. */
  vsCavalry: number;
}

export const FORMATIONS: Record<Formation, FormationDef> = {
  line: { id: 'line', name: 'Linea', icon: '▬', description: 'Equilibrata: tutti gli arcieri possono tirare.', speed: 1, attack: 1, defense: 1, arrows: 1, vsCavalry: 1 },
  column: { id: 'column', name: 'Colonna', icon: '⋮', description: 'Marcia veloce sulle strade, ma debole se attaccata.', speed: 1.25, attack: 0.8, defense: 0.75, arrows: 1.15, vsCavalry: 0.8 },
  wedge: { id: 'wedge', name: 'Cuneo', icon: '▲', description: 'Punta d\'urto: sfonda le linee nemiche (ottimo con la cavalleria).', speed: 1, attack: 1.35, defense: 0.85, arrows: 1, vsCavalry: 0.9 },
  square: { id: 'square', name: 'Quadrato', icon: '■', description: 'Muro di picche: regge le cariche, ma è lento.', speed: 0.7, attack: 0.85, defense: 1.35, arrows: 1, vsCavalry: 1.8 },
  shields: { id: 'shields', name: 'Testuggine', icon: '🛡️', description: 'Scudi e pavesi: dimezza le perdite da frecce. Ideale per assaltare le mura.', speed: 0.75, attack: 0.85, defense: 1.1, arrows: 0.5, vsCavalry: 1.1 },
};

export type Behavior = 'aggressive' | 'defensive' | 'hold';

export const BEHAVIORS: Record<Behavior, { name: string; icon: string; description: string }> = {
  aggressive: { name: 'Aggressivo', icon: '⚔️', description: 'Insegue e attacca i nemici entro 6 caselle.' },
  defensive: { name: 'Difensivo', icon: '🛡️', description: 'Resta dove si trova e combatte meglio (+20%) se attaccato.' },
  hold: { name: 'Tieni la posizione', icon: '⚓', description: 'Non si muove mai da solo; +35% in difesa, nessun inseguimento.' },
};

/** Effetto del terreno sulla forza in campo aperto: fanti, arcieri, cavalieri. */
export const TERRAIN_BATTLE: Record<number, { name: string; inf: number; arch: number; cav: number }> = {
  0: { name: 'prato', inf: 1, arch: 1, cav: 1.15 },
  1: { name: 'bosco', inf: 1.15, arch: 1.1, cav: 0.6 },
  2: { name: 'altura rocciosa', inf: 1.1, arch: 1.3, cav: 0.7 },
  3: { name: 'altura rocciosa', inf: 1.1, arch: 1.3, cav: 0.7 },
  4: { name: 'guado', inf: 0.85, arch: 0.9, cav: 0.7 },
  5: { name: 'riva', inf: 0.85, arch: 0.9, cav: 0.7 },
  6: { name: 'sabbia', inf: 0.92, arch: 0.92, cav: 0.92 },
};

export const COMMANDER_NAMES = [
  'Ottone', 'Corrado', 'Aldrico', 'Berengario', 'Guarnerio', 'Ezzelino', 'Ugo', 'Rolando', 'Tancredi', 'Manfredo',
  'Gualtiero', 'Federico', 'Alberico', 'Landolfo', 'Odoardo', 'Bonifacio', 'Arrigo', 'Sigfrido', 'Teobaldo', 'Rainero',
];
