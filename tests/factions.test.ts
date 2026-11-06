import { describe, expect, it } from 'vitest';
import { Game } from '../src/game/sim/game';
import { createInitialState } from '../src/game/sim/state';
import { getBuilding } from '../src/game/data/buildings';
import { Tile } from '../src/game/world/terrain';
import { FACTION_LIST, type FactionId } from '../src/game/data/factions';

Game.instantByDefault = true;

function game(faction?: FactionId, lords = 0) {
  const st = createInitialState(7, 'Rocca', { faction, lords });
  const g = new Game(st, () => 0.5);
  g.terrain.tiles.fill(Tile.Grass);
  g.levelOverride = 5;
  Object.assign(g.state.resources, { wood: 1e4, stone: 1e4, lime: 1e4, coins: 1e4 });
  return g;
}

describe('schieramenti', () => {
  it('ognuno ha bonus, malus e una mappa consigliata', () => {
    expect(FACTION_LIST.map((f) => f.id)).toEqual(['verona', 'padova', 'venezia', 'aquileia', 'cividale', 'gorizia']);
    for (const f of FACTION_LIST) {
      expect(f.bonus.length).toBeGreaterThan(0);
      expect(f.malus.length).toBeGreaterThan(0);
    }
  });

  it('Verona costruisce le fortificazioni in pietra a minor costo', () => {
    const wall = getBuilding('wall_stone');
    expect(game('verona').costOf(wall).stone).toBeLessThan(game().costOf(wall).stone!);
    expect(game('verona').costOf(getBuilding('palisade'))).toEqual(getBuilding('palisade').cost);
  });

  it('Padova raccoglie più grano', () => {
    const harvest = (f?: FactionId) => {
      const g = game(f);
      g.place('field_grain', 10, 10);
      g.state.resources.coins = 300;
      g.state.day = 100;
      g.state.resources.grain = 0;
      g.state.population = 10;
      g.advance(5);
      return g.state.resources.grain;
    };
    expect(harvest('padova')).toBeGreaterThan(harvest());
  });

  it('Venezia: fossati sempre allagati e prezzi migliori al mercato', () => {
    const v = game('venezia');
    const n = game();
    const m = v.place('moat', 20, 20)!;
    expect(v.moatFlooded(m)).toBe(true);
    expect(n.moatFlooded(n.place('moat', 20, 20)!)).toBe(false);
    expect(v.buyPrice('wood')).toBeLessThan(n.buyPrice('wood'));
    expect(v.sellPrice('wood')).toBeGreaterThan(n.sellPrice('wood'));
    expect(v.unitCost('cavalry').coins).toBeGreaterThan(n.unitCost('cavalry').coins!);
  });

  it('Aquileia parte con più pietra, Gorizia con meno monete ma rapporti migliori', () => {
    const base = createInitialState(7, 'X', { lords: 2 });
    const aq = createInitialState(7, 'X', { faction: 'aquileia', lords: 2 });
    const go = createInitialState(7, 'X', { faction: 'gorizia', lords: 2 });
    expect(aq.resources.stone).toBe(base.resources.stone + 150);
    expect(aq.nextRaidDay).toBeLessThan(base.nextRaidDay);
    expect(go.resources.coins).toBeLessThan(base.resources.coins);
    expect(go.lords![0].relation).toBe(base.lords![0].relation + 15);
  });

  it('i signori rivali prendono gli altri schieramenti', () => {
    const st = createInitialState(3, 'X', { faction: 'venezia', lords: 4 });
    const ids = st.lords!.map((l) => l.faction);
    expect(new Set(ids).size).toBe(4);
    expect(ids).not.toContain('venezia');
  });

  it('Cividale: mura più robuste', () => {
    const c = game('cividale');
    const n = game();
    c.state.day = n.state.day = 300 * 360;
    expect(c.maxHp(c.place('wall_stone', 5, 5)!)).toBeGreaterThan(n.maxHp(n.place('wall_stone', 5, 5)!));
  });
});
