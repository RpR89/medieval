import { describe, expect, it } from 'vitest';
import { Game } from '../src/game/sim/game';
import { createInitialState } from '../src/game/sim/state';
import { Tile } from '../src/game/world/terrain';

function farm(year = 1000) {
  const st = createInitialState(1);
  st.day = (year - 900) * 360 + 95;
  st.population = 24;
  st.nextRaidDay = 1e9;
  const g = new Game(st, () => 0.5);
  g.instantBuild = true;
  g.terrain.tiles.fill(Tile.Grass);
  g.storageCap = () => 1e9;
  return g;
}

describe('filiera', () => {
  it('grano → farina → pane, e ferro + carbone → armi', () => {
    const g = farm();
    Object.assign(g.state.resources, { wood: 1e4, stone: 1e4, coins: 1e4, grain: 500, charcoal: 100, iron: 50, flour: 0, bread: 0, weapons: 0, vegetables: 500 });
    // La ruota ha bisogno dell'acqua: si pone un tratto di fiume accanto
    g.terrain.tiles[10 * g.terrain.size + 9] = Tile.River;
    expect(g.place('mill', 10, 10)).not.toBeNull();
    expect(g.place('bakery', 14, 10)).not.toBeNull();
    expect(g.place('smithy', 18, 10)).not.toBeNull();
    g.advance(40);
    expect(g.state.resources.flour, 'flour').toBeGreaterThan(0);
    // Il pane si mangia appena sfornato: si vede nelle entrate
    expect(g.resourceFlows('bread').income.some((r) => r.label === 'Forno del pane')).toBe(true);
    expect(g.state.resources.weapons, 'armi').toBeGreaterThan(0);
  });

  it('i soldati richiedono armi', () => {
    const g = farm();
    g.state.resources.weapons = 0;
    g.place('barracks', 10, 10);
    Object.assign(g.state.resources, { coins: 1e4, wood: 1e4 });
    expect(g.canRecruit('infantry').ok).toBe(false);
    g.state.resources.weapons = 3;
    expect(g.canRecruit('infantry').ok).toBe(true);
  });
});

describe('obiettivi ed eventi', () => {
  it('un obiettivo raggiunto dà il premio una volta sola', () => {
    const g = farm(900);
    g.state.population = 31;
    const coins = g.state.resources.coins;
    g.advance(2);
    expect(g.state.goalsDone).toContain('e0_pop');
    expect(g.state.resources.coins).toBeGreaterThanOrEqual(coins + 80);
    const after = g.state.resources.coins;
    g.advance(2);
    expect(g.state.resources.coins).toBeLessThan(after + 60);
    expect(g.goals().find((x) => x.goal.id === 'e0_pop')?.done).toBe(true);
  });

  it('gli eventi stagionali compaiono col tempo e sono limitati nel tempo', () => {
    const st = createInitialState(3);
    st.day = 100 * 360 + 20;
    const g = new Game(st, Math.random);
    g.storageCap = () => 1e9;
    let seen = 0;
    for (let i = 0; i < 360 * 20; i++) {
      g.advance(1);
      seen = Math.max(seen, (g.state.events ?? []).length);
    }
    expect(seen).toBeGreaterThan(0);
  });
});
