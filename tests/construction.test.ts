import { describe, expect, it } from 'vitest';
import { Game } from '../src/game/sim/game';
import { createInitialState } from '../src/game/sim/state';
import { Tile } from '../src/game/world/terrain';

/** Mappa tutta prato, risorse abbondanti, costruzioni a tempo (non immediate). */
function site(year = 900) {
  const st = createInitialState(1);
  st.day = (year - 900) * 360 + 95; // estate: niente rallentamenti invernali
  st.population = 60;
  const g = new Game(st, () => 0.5);
  g.instantBuild = false;
  g.terrain.tiles.fill(Tile.Grass);
  Object.assign(g.state.resources, { wood: 1e4, stone: 1e4, lime: 1e4, coins: 1e4, grain: 1e4 });
  return g;
}

describe('cantieri', () => {
  it('un edificio non è pronto subito: i costruttori ci lavorano per giorni', () => {
    const g = site();
    const [x, z] = g.homeSite();
    const b = g.place('keep_wood', x - 1, z - 1)!;
    expect(b).not.toBeNull();
    expect(g.ownKeep()).toBeUndefined(); // ancora un cantiere
    expect(g.siteAt(x, z)?.uid).toBe(b.uid);
    expect(g.canPlace('hut', x, z).ok).toBe(false); // il terreno è occupato
    expect(g.canPlace('keep_wood', 5, 5).reason).toBe('Ne puoi avere uno solo');
    const work = g.jobFor(b.uid)!.work;
    expect(work).toBeGreaterThan(20);
    g.advance(2);
    expect(g.progressOf(b.uid)).toBeGreaterThan(0);
    expect(g.progressOf(b.uid)).toBeLessThan(1);
    g.advance(60);
    expect(g.ownKeep()?.uid).toBe(b.uid);
    expect(g.castleLevel()).toBe(1);
    expect(g.sites()).toHaveLength(0);
  });

  it('i costruttori lasciano i campi: con la loggia dei muratori sono di più e più rapidi', () => {
    const a = site();
    const b = site();
    b.instantBuild = true;
    b.place('mason_lodge', 4, 4);
    b.place('mason_lodge', 8, 4);
    b.instantBuild = false;
    expect(b.builderCap()).toBe(a.builderCap() + 12);
    for (const g of [a, b]) for (let z = 20; z < 23; z++) for (let x = 10; x < 30; x++) g.place('palisade', x, z);
    a.advance(3);
    b.advance(3);
    const left = (g: Game) => g.jobs().reduce((s, j) => s + j.work - j.done, 0);
    expect(left(b)).toBeLessThan(left(a) * 0.75);
    expect(b.lastBuilders).toBeGreaterThan(a.lastBuilders);
    // Pagati e sfamati: compaiono nel registro delle risorse
    expect(a.resourceFlows('coins').expense.some((r) => r.label === 'Paga dei costruttori')).toBe(true);
  });

  it('in inverno i lavori in pietra quasi si fermano', () => {
    const g = site(1200);
    expect(g.builderRate(true).rate).toBeGreaterThan(0.8);
    g.state.day += 180; // inverno
    g.advance(0.3);
    expect(g.builderRate(true).rate).toBeLessThan(g.builderRate(false).rate);
    expect(g.builderRate(true).parts.some(([n]) => /malta/.test(n))).toBe(true);
  });

  it('annullare un cantiere libera il terreno e rimborsa i materiali', () => {
    const g = site();
    const wood = g.state.resources.wood;
    const b = g.place('tower_wood', 10, 10)!;
    expect(g.state.resources.wood).toBe(wood - 45);
    expect(g.demolish(b.uid)).toBe(true);
    expect(g.state.resources.wood).toBe(wood);
    expect(g.siteAt(10, 10)).toBeUndefined();
    expect(g.canPlace('tower_wood', 10, 10).ok).toBe(true);
  });

  it('la priorità decide quale cantiere avanza per primo', () => {
    const g = site();
    g.setBuilders(4);
    const t1 = g.place('tower_wood', 10, 10)!;
    const t2 = g.place('tower_wood', 14, 10)!;
    g.prioritizeJob(g.jobFor(t2.uid)!.id);
    g.advance(2);
    expect(g.progressOf(t2.uid)).toBeGreaterThan(0);
    expect(g.progressOf(t1.uid)).toBe(0);
  });
});

describe('evoluzione delle mura', () => {
  it('palizzata → doppia palizzata → pietrame → pietra → cortina → bastionate', () => {
    const g = site(1360);
    g.levelOverride = 5;
    g.instantBuild = true;
    const w = g.place('palisade', 10, 10)!;
    const chain = ['palisade_double', 'wall_rubble', 'wall_stone', 'wall_curtain', 'wall_bastion'];
    let hp = g.maxHp(w);
    for (const id of chain) {
      expect(g.canEvolve(w), id).toMatchObject({ ok: true });
      expect(g.evolve(w)).toBe(true);
      expect(w.defId).toBe(id);
      expect(g.maxHp(w)).toBeGreaterThan(hp);
      hp = g.maxHp(w);
    }
    expect(g.canEvolve(w).ok).toBe(false);
  });

  it('richiede epoca, livello del castello e materiali; i lavori richiedono tempo', () => {
    const g = site(1100);
    g.instantBuild = true;
    g.levelOverride = 2;
    const w = g.place('wall_rubble', 10, 10)!;
    expect(g.canEvolve(w).reason).toBe('Disponibile dal 1150');
    g.state.day += 60 * 360;
    expect(g.canEvolve(w).reason).toMatch(/livello 3/);
    g.levelOverride = 3;
    g.state.resources.lime = 0;
    expect(g.canEvolve(w).reason).toBe('Risorse insufficienti');
    g.state.resources.lime = 100;
    g.instantBuild = false;
    expect(g.evolve(w)).toBe(true);
    expect(w.defId).toBe('wall_rubble'); // ancora in lavorazione: resta com'era
    expect(g.canUpgrade(w, 'walkway').reason).toBe('Lavori già in corso');
    g.advance(40);
    expect(w.defId).toBe('wall_stone');
    expect(w.hp).toBe(g.maxHp(w));
  });

  it('evolve tutto un tratto di mura in un colpo, finché bastano le risorse', () => {
    const g = site(1200);
    g.levelOverride = 3;
    g.instantBuild = true;
    for (let x = 10; x < 20; x++) g.place('wall_rubble', x, 10);
    g.instantBuild = false;
    const cost = g.evolveCost(g.buildingAt(10, 10)!);
    g.state.resources.lime = (cost.lime ?? 0) * 4;
    expect(g.evolveAll('wall_rubble')).toBe(4);
    expect(g.jobs()).toHaveLength(4);
  });

  it('i miglioramenti già compresi nella struttura non si ricostruiscono', () => {
    const g = site(1260);
    g.levelOverride = 4;
    g.instantBuild = true;
    const w = g.place('wall_curtain', 10, 10)!;
    expect(g.upgradeOptions(w).some((u) => u.id === 'walkway')).toBe(false);
    expect(g.canUpgrade(w, 'hoarding_wall').ok).toBe(true);
  });
});
