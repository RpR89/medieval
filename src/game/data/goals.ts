import type { Game } from '../sim/game';
import type { Cost } from './resources';

/**
 * Obiettivi per epoca: danno una direzione alla partita e un premio quando si raggiungono.
 * `have` dice a che punto si è, `need` quanto serve.
 */
export interface Goal {
  id: string;
  /** Indice dell'epoca da cui diventa visibile. */
  era: number;
  icon: string;
  text: string;
  need: number;
  have: (g: Game) => number;
  reward: Cost;
}

const fields = (g: Game) => g.count('field_grain') + g.count('field_vegetables') + g.count('hay_meadow');
const towers = (g: Game) => g.state.buildings.filter((b) => b.defId.startsWith('tower_') || b.defId === 'gatehouse').length;
const walls = (g: Game, ...ids: string[]) => g.state.buildings.filter((b) => ids.includes(b.defId)).length;

export const GOALS: Goal[] = [
  // ── 900: la motta
  { id: 'e0_keep', era: 0, icon: '🏯', text: 'Erigi la motta con la torre lignea', need: 1, have: (g) => (g.castleLevel() >= 1 ? 1 : 0), reward: { coins: 60, wood: 60 } },
  { id: 'e0_fields', era: 0, icon: '🌾', text: 'Coltiva 4 campi o prati', need: 4, have: fields, reward: { coins: 60, wood: 40 } },
  { id: 'e0_pop', era: 0, icon: '👪', text: 'Raggiungi 30 abitanti', need: 30, have: (g) => Math.floor(g.state.population), reward: { coins: 80 } },
  { id: 'e0_smithy', era: 0, icon: '🗡️', text: 'Costruisci una fucina per le armi', need: 1, have: (g) => g.count('smithy'), reward: { coins: 80, stone: 30 } },
  { id: 'e0_bailey', era: 0, icon: '🏰', text: 'Cingi la motta con un recinto (livello 2)', need: 2, have: (g) => g.castleLevel(), reward: { coins: 150, wood: 100 } },
  // ── 1050: il mastio
  { id: 'e1_keep', era: 1, icon: '🏰', text: 'Trasforma la motta in mastio di pietra', need: 3, have: (g) => g.castleLevel(), reward: { coins: 200, stone: 80 } },
  { id: 'e1_bread', era: 1, icon: '🍞', text: 'Macina e cuoci: un mulino e un forno', need: 2, have: (g) => Math.min(1, g.count('mill')) + Math.min(1, g.count('bakery')), reward: { coins: 120, wood: 80 } },
  { id: 'e1_pop', era: 1, icon: '👪', text: 'Raggiungi 45 abitanti', need: 45, have: (g) => Math.floor(g.state.population), reward: { coins: 150 } },
  { id: 'e1_iron', era: 1, icon: '⛓️', text: 'Produci 40 di ferro', need: 40, have: (g) => Math.floor(g.state.resources.iron), reward: { coins: 150, charcoal: 20 } },
  { id: 'e1_ring', era: 1, icon: '🧱', text: 'Chiudi la cinta muraria attorno al mastio', need: 1, have: (g) => (g.defenseBreakdown().closed ? 1 : 0), reward: { coins: 250, stone: 100 } },
  // ── 1150: le cinte
  { id: 'e2_level', era: 2, icon: '🏛️', text: 'Costruisci il palazzo del signore (livello 4)', need: 4, have: (g) => g.castleLevel(), reward: { coins: 300, stone: 100 } },
  { id: 'e2_towers', era: 2, icon: '🗼', text: 'Erigi 6 torri o porte fortificate', need: 6, have: towers, reward: { coins: 250, stone: 120 } },
  { id: 'e2_cloth', era: 2, icon: '🧵', text: 'Produci 30 di stoffa', need: 30, have: (g) => Math.floor(g.state.resources.cloth), reward: { coins: 200 } },
  { id: 'e2_stone', era: 2, icon: '🧱', text: '30 tratti di mura in pietra', need: 30, have: (g) => walls(g, 'wall_stone', 'wall_curtain', 'wall_bastion'), reward: { coins: 300, lime: 60 } },
  { id: 'e2_pop', era: 2, icon: '👪', text: 'Raggiungi 70 abitanti', need: 70, have: (g) => Math.floor(g.state.population), reward: { coins: 250 } },
  // ── 1250: il castello concentrico
  { id: 'e3_level', era: 3, icon: '👑', text: 'Porta il castello al livello 5', need: 5, have: (g) => g.castleLevel(), reward: { coins: 500, gold: 10 } },
  { id: 'e3_round', era: 3, icon: '🗼', text: 'Erigi 4 torri circolari', need: 4, have: (g) => g.count('tower_round'), reward: { coins: 350, stone: 150 } },
  { id: 'e3_moat', era: 3, icon: '💧', text: 'Scava 20 tratti di fossato', need: 20, have: (g) => g.count('moat'), reward: { coins: 300 } },
  { id: 'e3_army', era: 3, icon: '⚔️', text: 'Mantieni 60 soldati', need: 60, have: (g) => Math.floor(g.soldiers()), reward: { coins: 400, weapons: 20 } },
  // ── 1350: il tardo Medioevo
  { id: 'e4_siege', era: 4, icon: '🛡️', text: 'Respingi un assedio', need: 1, have: (g) => (g.state.lastSiege?.outcome === 'repelled' ? 1 : 0), reward: { coins: 600 } },
  { id: 'e4_bastion', era: 4, icon: '🧱', text: '12 tratti di bastionata', need: 12, have: (g) => walls(g, 'wall_bastion', 'tower_bastion'), reward: { coins: 600, stone: 200 } },
  { id: 'e4_pop', era: 4, icon: '👪', text: 'Raggiungi 110 abitanti', need: 110, have: (g) => Math.floor(g.state.population), reward: { coins: 500 } },
  { id: 'e4_rich', era: 4, icon: '🪙', text: 'Accumula 5000 monete', need: 5000, have: (g) => Math.floor(g.state.resources.coins), reward: { gold: 30 } },
];
