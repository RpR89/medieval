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

describe('cittadini', () => {
  function town(pop = 60) {
    const st = createInitialState(1);
    st.day = (1120 - 900) * 360 + 95;
    st.population = pop;
    st.nextRaidDay = 1e9;
    const g = new Game(st, () => 0.5);
    g.instantBuild = true;
    g.levelOverride = 3;
    g.terrain.tiles.fill(Tile.Grass);
    g.storageCap = () => 1e9;
    Object.assign(g.state.resources, { wood: 1e4, stone: 1e4, coins: 1e4, grain: 1e4, beer: 500, wine: 100 });
    return g;
  }
  const mood = (g: Game, re: RegExp) => g.moodTarget().parts.find(([n]) => re.test(n))?.[1] ?? 0;

  it('locanda, piazza e cerusico alzano il contento; la locanda consuma birra e senza rende meno', () => {
    const g = town();
    const base = g.moodTarget().total;
    g.place('tavern', 10, 10);
    g.place('square', 16, 10);
    g.place('barber', 22, 10);
    g.advance(2);
    expect(g.moodTarget().total).toBeGreaterThan(base + 8);
    const beer = g.state.resources.beer;
    g.advance(10);
    expect(g.state.resources.beer).toBeLessThan(beer);
    const withDrink = mood(g, /Locanda/);
    g.state.resources.beer = 0;
    g.state.resources.wine = 0;
    g.advance(3);
    expect(mood(g, /Locanda/)).toBeLessThan(withDrink);
  });

  it('vizi e locali fanno salire la criminalità; tribunale e prigione la abbassano; il furto costa monete', () => {
    const g = town();
    g.place('tavern', 10, 10);
    g.place('brothel', 14, 10);
    g.place('tavern', 18, 10);
    g.place('brothel', 22, 10);
    g.advance(60);
    const high = g.crime();
    expect(high).toBeGreaterThan(30);
    expect(g.crimeTarget().parts.some(([n]) => /Casa di piacere/.test(n))).toBe(true);
    g.place('court', 10, 16);
    g.place('prison', 14, 16);
    g.advance(80);
    expect(g.crime()).toBeLessThan(high - 10);
    // Le tasse in più dei locali compensano: servono comunque le monete
    expect(g.taxPerDay()).toBeGreaterThan(60 * 0.06);
  });

  it('il cerusico attutisce le epidemie e la filiera di vino e birra funziona', () => {
    const g = town();
    expect(g.healthIndex()).toBe(0);
    g.place('barber', 10, 10);
    g.place('barber', 14, 10);
    expect(g.healthIndex()).toBeGreaterThan(0.9);
    g.state.resources.grain = 1000;
    g.state.resources.beer = 0;
    g.state.resources.wine = 0;
    g.place('brewery', 20, 10);
    g.place('vineyard', 26, 10);
    g.state.day += 130; // autunno: vendemmia
    g.advance(40);
    expect(g.state.resources.beer).toBeGreaterThan(0);
    expect(g.state.resources.wine).toBeGreaterThan(0);
  });
});

describe('boschi', () => {
  function woods() {
    const st = createInitialState(1);
    st.day = (1000 - 900) * 360 + 5; // primavera
    st.population = 40;
    st.nextRaidDay = 1e9;
    const g = new Game(st, () => 0.5);
    g.instantBuild = true;
    g.terrain.tiles.fill(Tile.Grass);
    g.storageCap = () => 1e9;
    Object.assign(g.state.resources, { wood: 500, coins: 500, grain: 5000 });
    return g;
  }
  const idx = (g: Game, x: number, z: number) => z * g.terrain.size + x;

  it('il taglialegna abbatte davvero il bosco più vicino e rende meno se è lontano', () => {
    const g = woods();
    const n = g.terrain.size;
    // Un bosco di quattro caselle
    for (const [x, z] of [[20, 20], [21, 20], [20, 21], [21, 21]]) g.terrain.tiles[idx(g, x, z)] = Tile.Forest;
    (g as unknown as { forestStock: null }).forestStock = null;
    const near = g.place('woodcutter', 22, 20)!;
    const far = g.place('woodcutter', 32, 20)!;
    expect(g.woodReach(near)!.eff).toBe(1);
    expect(g.woodReach(far)!.eff).toBeLessThan(0.6);
    expect(g.woodReach(far)!.eff).toBeGreaterThan(0.25);
    const total = () => [[20, 20], [21, 20], [20, 21], [21, 21]].reduce((s, [x, z]) => s + g.forest()[idx(g, x, z)], 0);
    const before = total();
    g.advance(90);
    expect(total()).toBeLessThan(before - 15);
    // Nessun bosco raggiungibile: il taglialegna resta fermo
    const lone = g.place('woodcutter', n - 10, n - 10)!;
    expect(g.woodReach(lone)).toBeNull();
  });

  it('il bosco tagliato ricresce in qualche anno e sui ceppi si costruisce recuperando la legna', () => {
    const g = woods();
    const i = idx(g, 30, 30);
    g.terrain.tiles[i] = Tile.Forest;
    (g as unknown as { forestStock: null }).forestStock = null;
    expect(g.canPlace('hut', 30, 30).ok).toBe(false);
    g.forest()[i] = 2;
    g.advance(360);
    // Due stagioni di ricrescita all'anno
    expect(g.forest()[i]).toBeCloseTo(2 + 2 * Game.FOREST_REGROW);
    expect(g.forestLevel(i)).toBeLessThan(0.5);
    g.forest()[i] = 8;
    const wood = g.state.resources.wood;
    expect(g.canPlace('hut', 30, 30).ok).toBe(true);
    g.place('hut', 30, 30);
    expect(g.forest()[i]).toBe(0);
    expect(g.state.resources.wood).toBeGreaterThan(wood - 15 + 7);
  });

  it('i boschi tagliati restano tali dopo un salvataggio', () => {
    const g = new Game(createInitialState(4), () => 0.5);
    const i = g.terrain.tiles.findIndex((t) => t === Tile.Forest);
    expect(i).toBeGreaterThan(-1);
    g.forest()[i] = 5;
    (g as unknown as { saveForest(): void }).saveForest();
    const g2 = new Game(JSON.parse(JSON.stringify(g.state)), () => 0.5);
    expect(g2.forest()[i]).toBe(5);
    expect(g2.forestDirty.has(i)).toBe(true);
    expect(g2.forestLevel(g2.terrain.tiles.findIndex((t, k) => t === Tile.Forest && k !== i))).toBe(1);
  });
});
