import { describe, expect, it } from 'vitest';
import { Game, lineTiles } from '../src/game/sim/game';
import { createInitialState, type Force } from '../src/game/sim/state';
import { mulberry32, Tile } from '../src/game/world/terrain';
import { mixNumber, seasonMix } from '../src/game/data/calendar';
import { packBuildings } from '../src/net/match';

// Nei test le costruzioni sono immediate, salvo dove si provano i cantieri
Game.instantByDefault = true;

const F = (f: Partial<Force>): Force => ({ infantry: 0, archers: 0, cavalry: 0, rams: 0, trebuchets: 0, ...f });

function world(slot: 0 | 1 = 0, match = true) {
  const st = createInitialState(5, slot ? 'Sud' : 'Nord', match ? { preset: 'pianura', match: { id: 'm', slot } } : {});
  st.day = 200 * 360 + 100;
  st.nextRaidDay = 1e9;
  const g = new Game(st, mulberry32(7 + slot));
  g.terrain.tiles.fill(Tile.Grass);
  g.levelOverride = 5;
  Object.assign(g.state.resources, { wood: 1e5, stone: 1e5, lime: 1e5, coins: 1e5, grain: 5000 });
  g.storageCap = () => 1e9;
  return g;
}

function run(gs: Game[], days: number, until?: () => boolean) {
  for (let i = 0; i < days * 4; i++) {
    for (const g of gs) g.advance(0.25);
    if (until?.()) return;
  }
}

describe('reparti sul campo', () => {
  it('si formano dalla guarnigione, marciano dove si ordina e rientrano', () => {
    const g = world(0, false);
    const [x, z] = g.homeSite();
    g.place('keep_wood', x - 1, z - 1);
    Object.assign(g.state.army, { infantry: 20, archers: 6, cavalry: 0 });
    const c = g.formCompany(F({ infantry: 12, archers: 6 }))!;
    expect(c).not.toBeNull();
    expect(g.state.army.infantry).toBe(8);
    g.orderMove([c.id], x + 10.5, z + 0.5);
    run([g], 10, () => c.order === 'idle');
    expect(Math.hypot(c.x - (x + 10.5), c.z - (z + 0.5))).toBeLessThan(1.5);
    g.orderHome([c.id]);
    run([g], 10, () => !g.state.companies?.length);
    expect(g.state.companies).toHaveLength(0);
    expect(g.state.army.infantry).toBe(20);
  });

  it('il percorso passa dalla porta e attraversa il fiume solo sul ponte', () => {
    const g = world(0, false);
    const [x, z] = g.homeSite();
    // Fiume verticale con un solo ponte
    for (let zz = 0; zz < g.terrain.size; zz++) g.terrain.tiles[zz * g.terrain.size + x + 6] = Tile.River;
    g.place('bridge', x + 6, z + 8);
    g.place('keep_wood', x - 1, z - 1);
    // Cinta con una porta a ovest
    const r = 3;
    g.placeLine('palisade', lineTiles(x - r, z - r, x + r, z - r));
    g.placeLine('palisade', lineTiles(x - r, z + r, x + r, z + r));
    g.placeLine('palisade', lineTiles(x + r, z - r + 1, x + r, z + r - 1));
    g.place('gate_wood', x - r, z);
    g.placeLine('palisade', lineTiles(x - r, z - r + 1, x - r, z - 1));
    g.placeLine('palisade', lineTiles(x - r, z + 1, x - r, z + r - 1));
    g.state.army.infantry = 5;
    const c = g.formCompany(F({ infantry: 5 }))!;
    g.orderMove([c.id], x + 10.5, z + 0.5);
    const path = [...(c.path ?? [])];
    expect(path.some(([px, pz]) => px === x - r && pz === z)).toBe(true); // esce dalla porta
    expect(path.some(([px, pz]) => px === x + 6 && pz === z + 8)).toBe(true); // passa sul ponte
    expect(path.every(([px, pz]) => px !== x + 6 || pz === z + 8)).toBe(true); // mai nell'acqua
  });

  it('i reparti vicini al mastio difendono il castello', () => {
    const g = world(0, false);
    const [x, z] = g.homeSite();
    g.place('keep_wood', x - 1, z - 1);
    g.state.army.archers = 10;
    g.formCompany(F({ archers: 6 }));
    expect(g.defendingTroops().archers).toBe(10);
    const far = g.formCompany(F({ archers: 4 }))!;
    far.x += 20;
    expect(g.defendingTroops().archers).toBe(6);
  });

  it('assalto: i reparti raggiungono le mura nemiche, il difensore risolve, il bottino va nei carri', () => {
    const a = world(0);
    const b = world(1);
    const [bx, bz] = b.homeSite();
    b.place('keep_wood', bx - 1, bz - 1);
    b.state.resources.coins = 4000;
    a.setOthers(packBuildings(b.state.buildings));
    a.onAssault((att) => b.receiveAttack(att));
    b.onAttackResolved((r) => a.applyAttackResult(r));
    const [ax, az] = a.homeSite();
    a.place('keep_wood', ax - 1, az - 1);
    Object.assign(a.state.army, { infantry: 40, archers: 12, cavalry: 6 });
    const c1 = a.formCompany(F({ infantry: 25, archers: 12 }))!;
    const c2 = a.formCompany(F({ infantry: 15, cavalry: 6 }))!;
    expect(a.orderAttack([c1.id, c2.id], bx, bz).ok).toBe(true);
    run([a, b], 40, () => !!a.state.campaignLog?.length);
    expect(a.state.campaignLog?.[0].outcome).not.toBe('repelled');
    const cargo = (a.state.companies ?? []).reduce((s, c) => s + (c.cargo?.coins ?? 0), 0);
    expect(cargo).toBeGreaterThan(0);
    const coins = a.state.resources.coins;
    a.orderHome((a.state.companies ?? []).map((c) => c.id));
    run([a], 40, () => !a.state.companies?.length);
    expect(a.state.resources.coins).toBeGreaterThan(coins);
  });

  it('due reparti nemici che si incontrano combattono in campo aperto', () => {
    const a = world(0);
    const b = world(1);
    a.state.army.infantry = 30;
    b.state.army.infantry = 10;
    const ca = a.formCompany(F({ infantry: 30 }))!;
    const cb = b.formCompany(F({ infantry: 10 }))!;
    ca.x = 44;
    ca.z = 44;
    cb.x = 44.6;
    cb.z = 44.2;
    a.setEnemyCompanies(b.state.companies!);
    const res = a.fieldBattles();
    expect(res).toHaveLength(1);
    b.applyFieldLosses(res[0].enemyLosses, res[0].text);
    expect(cb.troops.infantry).toBeLessThan(10);
    expect(ca.troops.infantry).toBeGreaterThan(cb.troops.infantry);
    // Non si combatte di nuovo subito
    expect(a.fieldBattles()).toHaveLength(0);
  });
});

describe('tasse e contento', () => {
  it('tasse più alte rendono di più ma scontentano', () => {
    const g = world(0, false);
    g.state.population = 60;
    g.setTaxLevel(2);
    const normal = g.taxPerDay();
    g.setTaxLevel(4);
    expect(g.taxPerDay()).toBeGreaterThan(normal * 2);
    expect(g.moodTarget().total).toBeLessThan(40);
    g.setTaxLevel(0);
    expect(g.taxPerDay()).toBe(0);
    expect(g.moodTarget().total).toBeGreaterThan(70);
  });

  it('il contento cambia gradualmente e con tasse esose la gente se ne va', () => {
    const g = world(0, false);
    g.state.population = 60;
    g.state.happiness = 60;
    g.setTaxLevel(4);
    g.advance(2);
    expect(g.happiness()).toBeLessThan(60);
    expect(g.happiness()).toBeGreaterThan(50); // non crolla di colpo
    g.advance(60);
    expect(g.happiness()).toBeLessThan(30);
    expect(g.state.population).toBeLessThan(60);
  });
});

describe('stagioni graduali', () => {
  it('a metà stagione non si sfuma, alla fine si passa con continuità alla successiva', () => {
    expect(seasonMix(30)).toEqual({ from: 'spring', to: 'summer', t: 0 });
    const a = seasonMix(80);
    expect(a.t).toBeGreaterThan(0);
    expect(a.t).toBeLessThan(1);
    expect(seasonMix(89.99).t).toBeGreaterThan(0.99);
    // Nessun salto, nemmeno al cambio di stagione: piccoli passi di tempo → piccoli cambiamenti del valore mostrato
    const table = { spring: 0, summer: 1, autumn: 3, winter: 6 };
    for (let d = 0; d < 720; d += 0.5) {
      expect(Math.abs(mixNumber(seasonMix(d + 0.5), table) - mixNumber(seasonMix(d), table))).toBeLessThan(0.3);
    }
    expect(seasonMix(359).to).toBe('spring');
  });
});

describe('formazioni e comandi', () => {
  it('il quadrato regge la carica di cavalleria, la linea no', () => {
    const a = world(0);
    const mk = (form: 'line' | 'square') => {
      const g = world(1);
      g.state.army.infantry = 20;
      const c = g.formCompany(F({ infantry: 20 }))!;
      c.formation = form;
      return c;
    };
    a.state.army.cavalry = 8;
    const cav = a.formCompany(F({ cavalry: 8 }))!;
    cav.formation = 'wedge';
    const vsLine = a.fieldStrength([cav], [mk('line')]);
    const vsSquare = a.fieldStrength([cav], [mk('square')]);
    expect(vsSquare).toBeLessThan(vsLine * 0.6);
  });

  it('la colonna marcia più veloce, il quadrato più lento', () => {
    const g = world(0, false);
    g.state.army.infantry = 30;
    const c = g.formCompany(F({ infantry: 10 }))!;
    const base = g.companySpeed(c);
    c.formation = 'column';
    expect(g.companySpeed(c)).toBeGreaterThan(base);
    c.formation = 'square';
    expect(g.companySpeed(c)).toBeLessThan(base);
  });

  it('più reparti mossi insieme si schierano in fila e marciano alla velocità del più lento', () => {
    const g = world(0, false);
    Object.assign(g.state.army, { infantry: 20, cavalry: 10 });
    const inf = g.formCompany(F({ infantry: 20 }))!;
    const cav = g.formCompany(F({ cavalry: 10 }))!;
    const [x, z] = g.homeSite();
    g.orderMove([inf.id, cav.id], x + 12, z);
    expect(cav.groupSpeed).toBeCloseTo(g.companySpeed(inf));
    const endA = inf.path!.at(-1)!;
    const endB = cav.path!.at(-1)!;
    expect(endA).not.toEqual(endB); // destinazioni diverse, una accanto all'altra
    expect(Math.abs(endA[0] - endB[0])).toBeLessThanOrEqual(1); // fila perpendicolare alla marcia (asse x)
  });

  it('Maiusc aggiunge una tappa al percorso invece di sostituirlo', () => {
    const g = world(0, false);
    g.state.army.infantry = 5;
    const c = g.formCompany(F({ infantry: 5 }))!;
    const [x, z] = g.homeSite();
    g.orderMove([c.id], x + 8, z);
    const first = c.path!.length;
    g.orderMove([c.id], x + 8, z + 8, true);
    expect(c.path!.length).toBeGreaterThan(first);
    expect(c.path!.at(-1)).toEqual([x + 8, z + 8]);
  });

  it('i reparti aggressivi inseguono i nemici vicini, quelli difensivi no', () => {
    const g = world(0);
    g.state.army.infantry = 20;
    const agg = g.formCompany(F({ infantry: 10 }))!;
    const def = g.formCompany(F({ infantry: 10 }))!;
    agg.behavior = 'aggressive';
    g.setEnemyCompanies([{ id: 'e1', troops: F({ infantry: 5 }), x: agg.x + 4, z: agg.z, order: 'idle' }]);
    g.advance(0.25);
    expect(agg.order).toBe('move');
    expect(def.order).toBe('idle');
  });

  it('la testuggine riduce le perdite nell\'assalto alle mura', () => {
    const b = world(1);
    const [bx, bz] = b.homeSite();
    b.place('keep_wood', bx - 1, bz - 1);
    const r = 4;
    b.placeLine('palisade', lineTiles(bx - r, bz - r, bx + r, bz - r));
    b.placeLine('palisade', lineTiles(bx - r, bz + r, bx + r, bz + r));
    b.placeLine('palisade', lineTiles(bx - r, bz - r + 1, bx - r, bz + r - 1));
    b.placeLine('palisade', lineTiles(bx + r, bz - r + 1, bx + r, bz + r - 1));
    Object.assign(b.state.army, { infantry: 2, archers: 10 });
    const losses = (arrows: number) => {
      let sum = 0;
      for (let i = 0; i < 6; i++) {
        const st = JSON.parse(JSON.stringify(b.state));
        const g = new Game(st, mulberry32(i));
        g.terrain.tiles.fill(Tile.Grass);
        g.receiveAttack({ id: `x${i}`, from: 'N', troops: F({ infantry: 30 }), stance: 'resolute', departDay: g.state.day, arriveDay: g.state.day, tactics: { arrows, melee: 1 } });
        let res = 0;
        g.onAttackResolved((r) => (res = r.attackerLosses));
        g.advance(0.25);
        sum += res;
      }
      return sum;
    };
    expect(losses(0.5)).toBeLessThan(losses(1));
  });
});
