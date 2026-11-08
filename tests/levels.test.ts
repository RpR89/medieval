import { describe, expect, it } from 'vitest';
import { Game } from '../src/game/sim/game';
import { createInitialState } from '../src/game/sim/state';
import { Tile } from '../src/game/world/terrain';
import { getBuilding } from '../src/game/data/buildings';
import { isLevelable, levelName, levelUpCost, maxLevelFor } from '../src/game/data/levels';

Game.instantByDefault = true;

function game(year = 900) {
  const st = createInitialState(9);
  st.day = (year - 900) * 360 + 100;
  const g = new Game(st, () => 0.5);
  g.terrain.tiles.fill(Tile.Grass);
  Object.assign(g.state.resources, { wood: 1e4, stone: 1e4, lime: 1e4, coins: 1e4, grain: 0 });
  return g;
}

describe('livelli degli edifici civili', () => {
  it('quattro livelli per ogni epoca, fino a 20', () => {
    expect(maxLevelFor(900)).toBe(4);
    expect(maxLevelFor(1050)).toBe(8);
    expect(maxLevelFor(1150)).toBe(12);
    expect(maxLevelFor(1250)).toBe(16);
    expect(maxLevelFor(1399)).toBe(20);
    expect(levelName(6)).toMatch(/Mastio in pietra 2\/4/);
    expect(isLevelable(getBuilding('field_grain'))).toBe(true);
    expect(isLevelable(getBuilding('palisade'))).toBe(false);
  });

  it('migliorare costa materiali dell\'epoca e si ferma al massimo dell\'epoca', () => {
    const g = game(900);
    const hut = g.place('hut', 10, 10)!;
    for (let i = 0; i < 3; i++) expect(g.levelUp(hut)).toBe(true);
    expect(g.levelOf(hut)).toBe(4);
    expect(g.canLevelUp(hut).reason).toMatch(/dal 1050/);
    // Livelli dell'epoca della pietra: serve pietra, poi calce
    expect(levelUpCost(getBuilding('hut'), 4).stone).toBeGreaterThan(0);
    expect(levelUpCost(getBuilding('hut'), 8).lime).toBeGreaterThan(0);
    expect(levelUpCost(getBuilding('hut'), 1).stone).toBeUndefined();
  });

  it('un livello più alto rende di più: alloggi, raccolto, capi', () => {
    const g = game(1300);
    const h1 = g.place('hut', 10, 10)!;
    const housing = g.analysis().housing;
    g.levelUp(h1);
    g.levelUp(h1);
    expect(g.analysis().housing).toBeGreaterThan(housing);

    const harvest = (levels: number) => {
      const t = game(1300);
      const f = t.place('field_grain', 20, 20)!;
      for (let i = 0; i < levels; i++) t.levelUp(f);
      t.state.day = 400 * 360 + 100;
      t.state.population = 10;
      t.advance(5);
      return t.state.resources.grain;
    };
    expect(harvest(8)).toBeGreaterThan(harvest(0) * 1.4);

    const p = g.place('pasture_cattle', 30, 30)!;
    const cap = g.herdCapacity(p);
    g.levelUp(p);
    expect(g.herdCapacity(p)).toBeGreaterThan(cap);
  });

  it('il miglioramento richiede tempo ai costruttori', () => {
    const g = game(900);
    const hut = g.place('hut', 10, 10)!;
    g.instantBuild = false;
    expect(g.levelUp(hut)).toBe(true);
    expect(g.levelOf(hut)).toBe(1);
    expect(g.canLevelUp(hut).reason).toBe('Lavori già in corso');
    g.state.population = 40;
    g.advance(400);
    expect(g.levelOf(hut)).toBe(2);
  });
});
