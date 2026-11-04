import type { Cost } from './resources';

/**
 * Miglioramenti delle fortificazioni. Ogni edificio può averne diversi;
 * alcuni ne richiedono altri. Gli effetti sono letti dalla simulazione dell'assedio.
 */
export interface UpgradeDef {
  id: string;
  name: string;
  icon: string;
  description: string;
  /** Edifici a cui si applica. */
  appliesTo: string[];
  cost: Cost;
  minYear: number;
  requires?: string;
  /** Moltiplicatore dei punti vita massimi. */
  hpMul?: number;
  /** Difesa aggiunta (valore statico mostrato nell'interfaccia). */
  defense?: number;
  /** Potenza di tiro aggiunta durante l'assedio, per turno. */
  fire?: number;
  /** Resistenza agli arieti/scalate (moltiplica i punti vita "efficaci" in breccia). */
  resist?: number;
  /** Serve un fossato adiacente (ponte levatoio). */
  needsMoat?: boolean;
}

const WALLS = ['wall_stone'];
const TOWERS = ['tower_square', 'tower_round'];
const STONE_GATES = ['gate_stone', 'gatehouse'];

export const UPGRADES: UpgradeDef[] = [
  // ───── Palizzata ─────
  {
    id: 'earthbank',
    name: 'Terrapieno',
    icon: '⛰️',
    description: 'Terra battuta alla base della palizzata: più difficile da abbattere.',
    appliesTo: ['palisade'],
    cost: { coins: 4 },
    minYear: 900,
    hpMul: 1.6,
    resist: 1.2,
  },
  {
    id: 'walkway_wood',
    name: 'Ballatoio di ronda',
    icon: '🪜',
    description: 'Piano di legno dietro la palizzata: gli arcieri tirano dall\'alto.',
    appliesTo: ['palisade'],
    cost: { wood: 4 },
    minYear: 900,
    defense: 1,
    fire: 0.15,
  },
  // ───── Mura in pietra ─────
  {
    id: 'walkway',
    name: 'Cammino di ronda',
    icon: '🚶',
    description: 'Camminamento merlato in cima alle mura: i difensori tirano al riparo dei merli.',
    appliesTo: WALLS,
    cost: { stone: 4, wood: 2 },
    minYear: 1150,
    defense: 2,
    fire: 0.35,
    resist: 1.15,
  },
  {
    id: 'hoarding_wall',
    name: 'Bertesche',
    icon: '🛖',
    description: 'Gallerie di legno sporgenti sul cammino di ronda: si colpisce chi scala o scava ai piedi del muro.',
    appliesTo: WALLS,
    requires: 'walkway',
    cost: { wood: 10 },
    minYear: 1150,
    defense: 2,
    fire: 0.4,
    resist: 1.1,
  },
  {
    id: 'hoarding',
    name: 'Bertesche',
    icon: '🛖',
    description: 'Galleria di legno sporgente in cima alla torre: tiro piombante sugli assalitori.',
    appliesTo: [...TOWERS, 'tower_wood'],
    cost: { wood: 25 },
    minYear: 1100,
    defense: 3,
    fire: 0.8,
    resist: 1.1,
  },
  {
    id: 'thicken',
    name: 'Mura ispessite',
    icon: '🧱',
    description: 'Raddoppia lo spessore della muratura: resiste a trabucchi e arieti.',
    appliesTo: [...WALLS, ...TOWERS, ...STONE_GATES, 'keep_stone'],
    cost: { stone: 14, coins: 4 },
    minYear: 1150,
    hpMul: 1.7,
    resist: 1.1,
  },
  {
    id: 'machicolation',
    name: 'Caditoie',
    icon: '🕳️',
    description: 'Aperture nel parapetto sporgente per colpire la base delle mura.',
    appliesTo: [...TOWERS, ...STONE_GATES, 'keep_stone'],
    cost: { stone: 24, wood: 6 },
    minYear: 1250,
    defense: 4,
    fire: 1.2,
  },
  {
    id: 'tower_roof',
    name: 'Copertura della torre',
    icon: '🏠',
    description: 'Tetto sulla piattaforma: protegge i difensori da frecce e pietre.',
    appliesTo: ['tower_square'],
    cost: { wood: 20, stone: 6 },
    minYear: 1150,
    hpMul: 1.2,
    fire: 0.4,
  },
  // ───── Porte ─────
  {
    id: 'portcullis',
    name: 'Saracinesca',
    icon: '🔱',
    description: 'Griglia di ferro e legno che cala davanti alla porta.',
    appliesTo: ['gate_stone'],
    cost: { wood: 20, coins: 30 },
    minYear: 1150,
    defense: 4,
    resist: 1.6,
  },
  {
    id: 'pitch',
    name: 'Calderone della pece',
    icon: '🔥',
    description: 'Pece bollente versata su chi assale la porta. In battaglia consuma 10 di carbone.',
    appliesTo: ['gate_wood', 'gate_stone', 'gatehouse'],
    cost: { coins: 40, charcoal: 20 },
    minYear: 1000,
    defense: 3,
    fire: 3,
  },
  {
    id: 'drawbridge',
    name: 'Ponte levatoio',
    icon: '🌉',
    description: 'Si solleva sul fossato: gli assalitori devono colmarlo prima di arrivare alla porta.',
    appliesTo: ['gate_wood', 'gate_stone', 'gatehouse'],
    cost: { wood: 40, coins: 30 },
    minYear: 1050,
    defense: 6,
    resist: 1.4,
    needsMoat: true,
  },
  // ───── Fossato ─────
  {
    id: 'deep1',
    name: 'Scavo più profondo',
    icon: '⛏️',
    description: 'Fossato più profondo e ripido: chi lo attraversa resta più a lungo sotto tiro.',
    appliesTo: ['moat'],
    cost: { coins: 8 },
    minYear: 900,
    defense: 1.5,
  },
  {
    id: 'deep2',
    name: 'Fossato profondo',
    icon: '🕳️',
    description: 'Un vero baratro alla base delle mura.',
    appliesTo: ['moat'],
    requires: 'deep1',
    cost: { coins: 16, stone: 2 },
    minYear: 1150,
    defense: 2,
  },
  {
    id: 'flood',
    name: 'Allagamento',
    icon: '💧',
    description: 'Canale e chiuse per riempirlo d\'acqua anche lontano dal fiume (vicino al fiume si allaga da solo).',
    appliesTo: ['moat'],
    cost: { coins: 10, wood: 2 },
    minYear: 1050,
  },
  {
    id: 'stakes',
    name: 'Pali appuntiti',
    icon: '🪵',
    description: 'Pali aguzzi sul fondo del fossato.',
    appliesTo: ['moat'],
    cost: { wood: 3 },
    minYear: 900,
    defense: 1.5,
  },
  // ───── Mastio ─────
  {
    id: 'cistern',
    name: 'Cisterna',
    icon: '🪣',
    description: 'Riserva d\'acqua: se il nemico entra, la gente resiste nel mastio (metà delle perdite).',
    appliesTo: ['keep_wood', 'keep_stone'],
    cost: { stone: 40, coins: 20 },
    minYear: 900,
  },
  {
    id: 'armory',
    name: 'Armeria',
    icon: '⚔️',
    description: 'Armi di scorta per la guarnigione: +20% alla forza dei difensori.',
    appliesTo: ['keep_wood', 'keep_stone'],
    cost: { coins: 100, wood: 40 },
    minYear: 900,
  },
];

export const UPGRADE_BY_ID: Record<string, UpgradeDef> = Object.fromEntries(UPGRADES.map((u) => [u.id, u]));

export function upgradesFor(defId: string): UpgradeDef[] {
  return UPGRADES.filter((u) => u.appliesTo.includes(defId));
}
