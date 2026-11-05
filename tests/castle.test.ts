import { describe, expect, it } from 'vitest';
import { Game, lineTiles } from '../src/game/sim/game';
import { createInitialState } from '../src/game/sim/state';
import { resolveSiege, type AttackerArmy } from '../src/game/sim/siege';
import { Tile } from '../src/game/world/terrain';
import { mulberry32 } from '../src/game/world/terrain';

/** Mondo tutto prato, risorse abbondanti, per costruire castelli di prova. */
function flatGame(year = 900) {
  const st = createInitialState(1);
  st.day = (year - 900) * 360 + 100;
  const g = new Game(st, mulberry32(42));
  g.terrain.tiles.fill(Tile.Grass);
  g.levelOverride = 5; // questi test riguardano le fortificazioni, non i livelli del castello
  Object.assign(g.state.resources, { wood: 1e5, stone: 1e5, coins: 1e5, charcoal: 1000 });
  g.storageCap = () => 1e9;
  return g;
}

/** Anello quadrato di `wall` attorno al centro, con una porta sul lato est. */
function ring(g: Game, wall: string, gate: string, c = 32, r = 5, tower?: string) {
  const tiles: Array<[number, number]> = [];
  for (let i = -r; i <= r; i++) tiles.push([c + i, c - r], [c + i, c + r]);
  for (let i = -r + 1; i <= r - 1; i++) tiles.push([c - r, c + i], [c + r, c + i]);
  for (const [x, z] of tiles) {
    if (x === c + r && z === c) g.place(gate, x, z);
    else g.place(wall, x, z);
  }
  if (tower) for (const [x, z] of [[c - r - 1, c - r - 1], [c + r, c - r - 1]]) g.place(tower, x, z);
}

const raiders = (infantry: number, archers = 0, cavalry = 0, extra: Partial<AttackerArmy> = {}): AttackerArmy => ({
  name: 'Nemici di prova',
  infantry,
  archers,
  cavalry,
  rams: 0,
  trebuchets: 0,
  morale: 0.6,
  ...extra,
});

describe('linee di costruzione', () => {
  it('traccia linee dritte e diagonali senza buchi', () => {
    expect(lineTiles(0, 0, 4, 0)).toHaveLength(5);
    const diag = lineTiles(0, 0, 3, 3);
    expect(diag).toEqual([[0, 0], [1, 1], [2, 2], [3, 3]]);
    const any = lineTiles(0, 0, 5, 2);
    for (let i = 1; i < any.length; i++) {
      expect(Math.max(Math.abs(any[i][0] - any[i - 1][0]), Math.abs(any[i][1] - any[i - 1][1]))).toBe(1);
    }
  });

  it('placeLine costruisce tutta la fila in una volta', () => {
    const g = flatGame();
    const v = g.structureVersion;
    const r = g.placeLine('palisade', lineTiles(10, 10, 16, 16));
    expect(r.placed).toBe(7);
    expect(g.structureVersion).toBe(v + 1);
  });
});

describe('cinta muraria', () => {
  it('è chiusa solo se circonda il mastio', () => {
    const g = flatGame();
    g.place('keep_wood', 31, 31);
    expect(g.analysis().closed).toBe(false);
    ring(g, 'palisade', 'gate_wood');
    expect(g.analysis().closed).toBe(true);
    // Una breccia (rovina) riapre la cinta
    const w = g.buildingAt(30, 27)!;
    w.hp = 0;
    g.structureVersion++;
    expect(g.analysis().closed).toBe(false);
  });

  it('funziona anche con mura diagonali', () => {
    const g = flatGame();
    g.place('keep_wood', 31, 31);
    // Rombo di palizzate diagonali attorno al mastio
    const c = 32;
    const r = 6;
    const pts: Array<[number, number]> = [[c, c - r], [c + r, c], [c, c + r], [c - r, c], [c, c - r]];
    for (let i = 0; i < 4; i++) g.placeLine('palisade', lineTiles(...pts[i], ...pts[i + 1]));
    expect(g.analysis().closed).toBe(true);
  });

  it('il mastio può far parte della cinta', () => {
    const g = flatGame(1100);
    g.place('keep_stone', 30, 26); // occupa 30-32 × 26-28: sul lato nord dell'anello
    for (const [x, z] of lineTiles(27, 27, 29, 27)) g.place('palisade', x, z);
    for (const [x, z] of lineTiles(33, 27, 35, 27)) g.place('palisade', x, z);
    g.placeLine('palisade', lineTiles(27, 28, 27, 35));
    g.placeLine('palisade', lineTiles(35, 28, 35, 35));
    g.placeLine('palisade', lineTiles(28, 35, 34, 35));
    expect(g.analysis().closed).toBe(true);
  });
});

describe('punti vita e miglioramenti', () => {
  it('ispessire le mura aumenta i punti vita, la riparazione li ripristina', () => {
    const g = flatGame(1200);
    const w = g.place('wall_stone', 10, 10)!;
    expect(g.maxHp(w)).toBe(220);
    expect(g.upgrade(w, 'thicken')).toBe(true);
    expect(g.maxHp(w)).toBe(374);
    expect(w.hp).toBe(374);
    w.hp = 100;
    expect(g.hpState(w)).toBe('damaged');
    expect(g.repair(w)).toBe(true);
    expect(w.hp).toBe(374);
  });

  it('rispetta i requisiti: bertesche dopo il cammino di ronda, ponte levatoio con fossato', () => {
    const g = flatGame(1300);
    const w = g.place('wall_stone', 10, 10)!;
    expect(g.canUpgrade(w, 'hoarding_wall').reason).toMatch(/Cammino di ronda/);
    g.upgrade(w, 'walkway');
    expect(g.canUpgrade(w, 'hoarding_wall').ok).toBe(true);
    const gate = g.place('gate_stone', 20, 20)!;
    expect(g.canUpgrade(gate, 'drawbridge').ok).toBe(false);
    g.place('moat', 21, 20);
    expect(g.canUpgrade(gate, 'drawbridge').ok).toBe(true);
  });

  it('migliora tutte le mura dello stesso tipo in un colpo', () => {
    const g = flatGame(1200);
    g.placeLine('wall_stone', lineTiles(5, 5, 14, 5));
    expect(g.upgradeAll('wall_stone', 'walkway')).toBe(10);
  });
});

describe('fossati', () => {
  it('si allagano se toccano il fiume, o con l\'allagamento', () => {
    const g = flatGame(1100);
    for (let z = 0; z < g.terrain.size; z++) g.terrain.tiles[z * g.terrain.size + 5] = Tile.River;
    g.placeLine('moat', lineTiles(6, 10, 12, 10));
    const far = g.place('moat', 30, 30)!;
    expect(g.moatFlooded(g.buildingAt(12, 10)!)).toBe(true);
    expect(g.moatFlooded(far)).toBe(false);
    g.upgrade(far, 'flood');
    expect(g.moatFlooded(far)).toBe(true);
  });
});

describe('strade', () => {
  it('collegano gli edifici al mastio e aumentano la produzione', () => {
    const g = flatGame();
    g.place('keep_wood', 30, 30);
    const cutter = g.place('hut', 40, 31)!;
    expect(g.isConnected(cutter)).toBe(false);
    g.placeLine('road', lineTiles(33, 31, 39, 31));
    expect(g.isConnected(cutter)).toBe(true);
    expect(g.roadBonus(cutter)).toBeCloseTo(1.15);
  });

  it('i ponti attraversano il fiume', () => {
    const g = flatGame();
    for (let z = 0; z < g.terrain.size; z++) g.terrain.tiles[z * g.terrain.size + 20] = Tile.River;
    expect(g.canPlace('bridge', 20, 10).ok).toBe(true);
    expect(g.canPlace('bridge', 21, 10).ok).toBe(false);
    expect(g.canPlace('road', 20, 11).ok).toBe(false);
  });
});

describe('assedio: difendere costa meno che attaccare', () => {
  it('una palizzata chiusa con pochi difensori respinge un\'incursione dell\'anno 900', () => {
    const g = flatGame();
    g.place('keep_wood', 31, 31);
    ring(g, 'palisade', 'gate_wood');
    Object.assign(g.state.army, { infantry: 3, archers: 4, cavalry: 0 });
    const r = resolveSiege(g.siegeSnapshot(), raiders(9, 2), mulberry32(1));
    expect(r.outcome).toBe('repelled');
  });

  it('senza mura la stessa guarnigione viene sopraffatta', () => {
    const g = flatGame();
    g.place('keep_wood', 31, 31);
    Object.assign(g.state.army, { infantry: 3, archers: 4, cavalry: 0 });
    const r = resolveSiege(g.siegeSnapshot(), raiders(9, 2), mulberry32(1));
    expect(r.outcome).not.toBe('repelled');
  });

  it('un castello in pietra ben costruito regge contro un esercito tre volte più grande', () => {
    const g = flatGame(1300);
    g.place('keep_stone', 31, 31);
    ring(g, 'wall_stone', 'gatehouse', 32, 6, 'tower_round');
    for (const b of g.state.buildings) {
      for (const u of ['walkway', 'thicken', 'machicolation', 'pitch']) if (g.canUpgrade(b, u).ok) g.upgrade(b, u);
    }
    const c = 32;
    const r = 7;
    for (let i = -r; i <= r; i++) for (const [x, z] of [[c + i, c - r], [c + i, c + r], [c - r, c + i], [c + r + 1, c + i]]) g.place('moat', x, z);
    Object.assign(g.state.army, { infantry: 6, archers: 10, cavalry: 0 });
    const enemy = raiders(30, 12, 6, { rams: 2, trebuchets: 1 });
    expect(enemy.infantry + enemy.archers + enemy.cavalry).toBeGreaterThan(3 * 16 - 1);
    const res = resolveSiege(g.siegeSnapshot(), enemy, mulberry32(3));
    expect(res.outcome).toBe('repelled');
    expect(res.attackerLosses.infantry + res.attackerLosses.archers).toBeGreaterThan(
      res.defenderLosses.infantry + res.defenderLosses.archers,
    );
  });

  it('la pece consuma carbone quando l\'assalto è alla porta', () => {
    const g = flatGame(1100);
    g.place('keep_wood', 31, 31);
    ring(g, 'palisade', 'gate_wood');
    for (const b of g.state.buildings) if (b.defId === 'palisade') g.upgrade(b, 'earthbank');
    const gate = g.buildingAt(37, 32)!;
    g.upgrade(gate, 'pitch');
    Object.assign(g.state.army, { infantry: 2, archers: 3, cavalry: 0 });
    const res = resolveSiege(g.siegeSnapshot(), raiders(12, 2, 0, { rams: 1 }), mulberry32(5));
    expect(res.charcoalUsed).toBe(10);
  });

  it('gli assedi danneggiano le fortificazioni e si salva il rapporto', () => {
    const g = flatGame();
    g.place('keep_wood', 31, 31);
    ring(g, 'palisade', 'gate_wood');
    Object.assign(g.state.army, { infantry: 2, archers: 2, cavalry: 0 });
    g.besiege(raiders(14, 3));
    expect(g.state.lastSiege?.log.length).toBeGreaterThan(1);
    expect(g.state.buildings.some((b) => b.hp !== undefined && b.hp < g.maxHp(b))).toBe(true);
  });
});

describe('livelli del castello', () => {
  it('si sale dal livello 1 al 5: cortile, mastio, sala grande, palazzo', () => {
    const st = createInitialState(1);
    st.day = 100;
    const g = new Game(st, mulberry32(1));
    g.terrain.tiles.fill(Tile.Grass);
    Object.assign(g.state.resources, { wood: 1e5, stone: 1e5, coins: 1e5, gold: 100 });
    g.storageCap = () => 1e9;
    expect(g.castleLevel()).toBe(0);
    expect(g.canPlace('market', 10, 10).reason).toMatch(/livello 2/);
    const k = g.place('keep_wood', 30, 30)!;
    expect(g.castleLevel()).toBe(1);
    g.state.population = 30;
    expect(g.upgrade(k, 'bailey')).toBe(true);
    expect(g.castleLevel()).toBe(2);
    expect(g.canPlace('market', 10, 10).ok).toBe(true);
    // Il mastio in pietra si ottiene trasformando la motta, non costruendone un secondo
    expect(g.canPlace('keep_stone', 10, 10).ok).toBe(false);
    expect(g.canEvolveKeep().reason).toMatch(/1050/);
    g.state.day = 160 * 360;
    g.state.population = 40;
    expect(g.canEvolveKeep().reason).toMatch(/50 abitanti/);
    g.state.population = 60;
    const housing2 = g.analysis().housing;
    expect(g.evolveKeep()).toBe(true);
    expect(g.ownKeep()!.defId).toBe('keep_stone');
    expect(g.ownKeep()!.uid).toBe(k.uid);
    expect(g.castleLevel()).toBe(3);
    expect(g.analysis().housing).toBeGreaterThan(housing2);
    g.state.day = 300 * 360;
    g.state.population = 80;
    expect(g.upgrade(g.ownKeep()!, 'great_hall')).toBe(true);
    expect(g.castleLevel()).toBe(4);
    g.state.day = 360 * 360;
    g.state.population = 120;
    expect(g.upgrade(g.ownKeep()!, 'palace')).toBe(true);
    expect(g.castleLevel()).toBe(5);
    expect(g.analysis().taxMul).toBeGreaterThan(1.35);
  });
});
