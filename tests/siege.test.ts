import { describe, expect, it } from 'vitest';
import { Game } from '../src/game/sim/game';
import { createInitialState } from '../src/game/sim/state';
import { Tile } from '../src/game/world/terrain';
import { getBuilding } from '../src/game/data/buildings';

Game.instantByDefault = true;

function castle(year = 1200) {
  const st = createInitialState(1);
  st.day = (year - 900) * 360 + 100;
  st.nextRaidDay = 1e9;
  st.population = 80;
  const g = new Game(st, () => 0.5);
  g.terrain.tiles.fill(Tile.Grass);
  g.levelOverride = 5;
  Object.assign(g.state.resources, { wood: 1e4, stone: 1e4, lime: 1e4, coins: 1e4, charcoal: 300 });
  return g;
}

function square(g: Game, wall: string, c: number, r: number, gate = 'gate_stone') {
  for (let i = -r; i <= r; i++) for (const [x, z] of [[c + i, c - r], [c + i, c + r], [c - r, c + i], [c + r, c + i]]) {
    if (x === c + r && z === c) g.place(gate, x, z);
    else g.place(wall, x, z);
  }
}

describe('giri di mura e granai', () => {
  it('conta i giri e sa cosa è dentro e cosa è fuori', () => {
    const g = castle();
    g.place('keep_stone', 31, 31);
    square(g, 'wall_stone', 32, 4);
    square(g, 'wall_stone', 32, 9);
    expect(g.rings()).toBe(2);
    const inner = g.place('granary', 34, 34)!; // dentro il giro interno
    const between = g.place('granary', 25, 25)!; // tra i due giri
    const outside = g.place('granary', 50, 50)!; // fuori da tutto
    expect(g.depthOf(inner)).toBe(2);
    expect(g.depthOf(between)).toBe(1);
    expect(g.depthOf(outside)).toBe(0);
  });

  it('durante l\'assedio i granai esterni sono isolati: si resiste con quelli dentro', () => {
    const g = castle();
    g.place('keep_stone', 31, 31);
    square(g, 'wall_stone', 32, 5);
    g.place('granary', 33, 33); // dentro
    g.place('granary', 50, 50); // fuori
    g.place('granary', 54, 50); // fuori
    const capNormal = g.storageCap();
    g.state.resources.grain = capNormal;
    g.startSiege('Prova', { infantry: 40, archers: 10, cavalry: 0, rams: 0, trebuchets: 0 }, [60, 32], 0.6);
    const capSiege = g.storageCap();
    expect(capSiege).toBeLessThan(capNormal - 700);
    expect(g.state.resources.grain).toBeLessThanOrEqual(capSiege);
    expect(g.state.siege!.isolated.grain).toBeGreaterThan(700);
    // Un campo fuori dalle mura non produce durante l'assedio
    const f = g.place('field_grain', 45, 32)!;
    expect(g.isCutOff(f)).toBe(true);
  });
});

describe('assedio a fasi', () => {
  it('i predoni si accampano, preparano, assaltano; un castello ben difeso resiste e torna il grano isolato', () => {
    const g = castle(1100);
    g.place('keep_stone', 31, 31);
    square(g, 'wall_stone', 32, 5);
    g.state.army = { infantry: 20, archers: 25, cavalry: 0 };
    g.place('granary', 50, 50);
    g.state.resources.grain = 1500;
    g.state.nextRaidDay = g.state.day;
    g.advance(0.3);
    expect(g.state.siege).toBeTruthy();
    expect(g.state.siege!.phase).toBe('prepare');
    for (let i = 0; i < 400 && g.state.siege; i++) g.advance(0.5);
    expect(g.state.siege).toBeUndefined();
    expect(g.state.lastSiege?.log.join(' ')).toMatch(/accampa/);
    expect(['repelled']).toContain(g.state.lastSiege?.outcome);
    expect(g.state.nextRaidDay).toBeGreaterThan(g.state.day);
  });

  it('con due giri di mura il primo cade e l\'assedio prosegue dietro il secondo', () => {
    const g = castle(1250);
    g.place('keep_stone', 31, 31);
    square(g, 'wall_stone', 32, 4);
    square(g, 'palisade', 32, 8, 'gate_wood');
    g.state.army = { infantry: 10, archers: 6, cavalry: 0 };
    g.startSiege('Esercito enorme', { infantry: 140, archers: 40, cavalry: 20, rams: 3, trebuchets: 2 }, [60, 32], 0.9);
    for (let i = 0; i < 200 && g.state.siege && g.state.siege.breached === 0; i++) g.advance(0.5);
    expect(g.state.siege?.breached ?? 1).toBe(1);
  });

  it('sortita e riscatto', () => {
    const g = castle();
    g.place('keep_stone', 31, 31);
    square(g, 'wall_stone', 32, 5);
    g.state.army = { infantry: 30, archers: 10, cavalry: 15 };
    g.startSiege('Prova', { infantry: 30, archers: 10, cavalry: 0, rams: 0, trebuchets: 0 }, [60, 32], 0.6);
    const before = g.state.siege!.troops.infantry;
    expect(g.sortie()).not.toBe('');
    expect(g.state.siege!.troops.infantry).toBeLessThan(before);
    expect(g.canSortie().ok).toBe(false);
    const coins = g.state.resources.coins;
    const cost = g.ransomCost();
    expect(g.payRansom()).toBe(true);
    expect(g.state.siege).toBeUndefined();
    expect(g.state.resources.coins).toBe(coins - cost);
  });

  it('se finisce il cibo dentro le mura, il castello si arrende', () => {
    const g = castle();
    g.place('keep_stone', 31, 31);
    square(g, 'wall_stone', 32, 5);
    g.state.army = { infantry: 40, archers: 40, cavalry: 0 };
    for (const id of ['grain', 'vegetables', 'meat', 'fish', 'cheese', 'milk'] as const) g.state.resources[id] = 0;
    g.startSiege('Assedianti pazienti', { infantry: 60, archers: 10, cavalry: 0, rams: 0, trebuchets: 0 }, [60, 32], 0.95);
    g.state.siege!.nextDay = 1e9; // non assaltano: aspettano la fame
    for (let i = 0; i < 200 && g.state.siege; i++) g.advance(0.5);
    expect(g.state.siege).toBeUndefined();
    expect(g.state.lastSiege?.outcome).toBe('sacked');
  });
});

describe('rifornimenti dei reparti', () => {
  it('partono con i viveri, li consumano fuori dal territorio e senza disertano', () => {
    const st = createInitialState(21, 'Rocca', { preset: 'pianura', lords: 1 });
    st.nextRaidDay = 1e9;
    const g = new Game(st, () => 0.5);
    const [x, z] = g.homeSite();
    g.place('keep_wood', x - 1, z - 1);
    g.state.resources.grain = 5000;
    g.state.army.infantry = 20;
    const c = g.formCompany({ infantry: 20, archers: 0, cavalry: 0, rams: 0, trebuchets: 0 })!;
    expect(g.supplyDays(c)).toBeCloseTo(Game.SUPPLY_DAYS, 0);
    // Portato fuori dal territorio
    const [kx, kz] = g.lordKeep(g.lords()[0]);
    c.x = kx + 0.5;
    c.z = kz + 12.5;
    c.order = 'idle';
    c.path = [];
    g.advance(20);
    expect(g.supplyDays(c)).toBeLessThan(Game.SUPPLY_DAYS - 15);
    g.advance(200);
    expect(c.troops.infantry).toBeLessThan(20);
  });

  it('i carri delle salmerie portano i viveri del castello e rallentano la marcia', () => {
    const st = createInitialState(21, 'Rocca', { preset: 'pianura', lords: 1 });
    st.nextRaidDay = 1e9;
    const g = new Game(st, () => 0.5);
    const [x, z] = g.homeSite();
    g.place('keep_wood', x - 1, z - 1);
    Object.assign(g.state.resources, { grain: 5000, wood: 500, coins: 500 });
    g.storageCap = () => 1e9;
    g.state.army.infantry = 40;
    expect(g.buildWagon()).toBe(true);
    expect(g.buildWagon()).toBe(true);
    expect(g.state.wagons).toBe(2);
    const F = { infantry: 20, archers: 0, cavalry: 0, rams: 0, trebuchets: 0 };
    const bare = g.formCompany(F)!;
    const c = g.formCompany(F, 2)!;
    expect(g.state.wagons).toBe(0);
    expect(c.wagons).toBe(2);
    expect(g.supplyDays(c)).toBeGreaterThan(g.supplyDays(bare) * 5);
    expect(g.companySpeed(c)).toBeLessThan(g.companySpeed(bare));
    // Tornati a casa, i carri rientrano e i viveri avanzati finiscono nei granai
    const grain = g.state.resources.grain;
    (g as unknown as { mergeHome(c: unknown): void }).mergeHome(c);
    expect(g.state.wagons).toBe(2);
    expect(g.state.resources.grain).toBeGreaterThan(grain);
  });
});

describe('il nostro assedio a un signore', () => {
  function war() {
    const st = createInitialState(21, 'Rocca', { preset: 'pianura', lords: 1 });
    st.day = 220 * 360 + 100;
    st.nextRaidDay = 1e9;
    const g = new Game(st, () => 0.5);
    Object.assign(g.state.resources, { wood: 1e5, stone: 1e5, lime: 1e5, coins: 1e5, grain: 5e3 });
    g.storageCap = () => 1e9;
    const [x, z] = g.homeSite();
    g.place('keep_stone', x - 1, z - 1);
    g.buildLordCastlesNow();
    const l = g.lords()[0];
    l.army = { infantry: 10, archers: 6, cavalry: 0 };
    g.state.army = { infantry: 60, archers: 20, cavalry: 10 };
    return { g, l };
  }
  function arrive(g: Game, l: ReturnType<typeof war>['l']) {
    const c = g.formCompany({ infantry: 60, archers: 20, cavalry: 10, rams: 0, trebuchets: 0 })!;
    const [kx, kz] = g.lordKeep(l);
    c.x = kx + 0.5;
    c.z = kz + 9.5;
    expect(g.orderAttack([c.id], kx, kz).ok).toBe(true);
    for (let i = 0; i < 400 && !g.state.offense; i++) g.advance(0.25);
    return c;
  }

  it('davanti a una cinta chiusa ci si accampa invece di assaltare subito', () => {
    const { g, l } = war();
    expect(g.lordRingClosed(l)).toBe(true);
    const c = arrive(g, l);
    expect(g.state.offense?.lord).toBe(l.id);
    expect(c.order).toBe('siege');
    expect(l.status).toBe('war');
    // Le macchine (dal 1100) bombardano il bersaglio scelto
    g.setOffenseAim('gate');
    g.advance(20);
    expect(g.state.offense!.ladders).toBeGreaterThan(5);
    const tb = l.buildings.find((b) => b.uid === g.state.offense!.target);
    expect(tb && getBuildingFort(tb.defId)).toBe('gate');
  });

  it('l\'assalto si ordina quando si vuole; il castello cade e diventa vassallo', () => {
    const { g, l } = war();
    arrive(g, l);
    g.advance(15);
    expect(g.offenseAssault()).toBe(true);
    // Con forze molto superiori il castello cade
    expect(l.status).toBe('vassal');
    expect(g.state.offense).toBeUndefined();
  });

  it('il blocco affama il signore che alla fine si arrende; si può anche togliere l\'assedio', () => {
    const { g, l } = war();
    arrive(g, l);
    l.res!.food = 0;
    g.state.offense!.sallyDay = 1e9;
    for (let i = 0; i < 200 && g.state.offense; i++) g.advance(0.5);
    expect(l.status).toBe('vassal');

    const w = war();
    arrive(w.g, w.l);
    w.g.liftOffense();
    expect(w.g.state.offense).toBeUndefined();
    expect(w.g.companies().every((c) => c.order === 'home')).toBe(true);
  });
});

function getBuildingFort(id: string) {
  return getBuilding(id).fort;
}

describe('tecniche d\'assedio e comandanti', () => {
  const snap = (extra: Partial<import('../src/game/sim/siege').DefenderSnapshot> = {}, upgrades: string[] = []) => ({
    segments: [
      { uid: 1, defId: 'wall_stone', role: 'wall' as const, hp: 300, maxHp: 300, upgrades: [], defense: 5 },
      { uid: 2, defId: 'tower_wood', role: 'tower' as const, hp: 150, maxHp: 150, upgrades: [], defense: 3 },
      { uid: 3, defId: 'tower_round', role: 'tower' as const, hp: 400, maxHp: 400, upgrades, defense: 6 },
      { uid: 4, defId: 'keep_stone', role: 'keep' as const, hp: 600, maxHp: 600, upgrades: [], defense: 20 },
    ],
    closed: true,
    moat: { tiles: 0, coverage: 0, depth: 1, flooded: 0, stakes: 0 },
    army: { infantry: 10, archers: 6, cavalry: 0 },
    armory: false,
    cistern: false,
    charcoal: 0,
    ...extra,
  });
  const army = { name: 'Nemici', infantry: 40, archers: 12, cavalry: 0, rams: 0, trebuchets: 0, morale: 0.7, year: 1200 };

  it('i minatori fanno crollare le mura, ma il fossato allagato o la contromina li fermano', async () => {
    const { resolveSiege } = await import('../src/game/sim/siege');
    const plain = resolveSiege(snap(), army, () => 0.5);
    expect(plain.log.some((l) => /minatori scavano una galleria/.test(l))).toBe(true);
    const flood = resolveSiege(snap({ moat: { tiles: 40, coverage: 0.8, depth: 2, flooded: 1, stakes: 0 } }), army, () => 0.5);
    expect(flood.log.some((l) => /inonda le gallerie/.test(l))).toBe(true);
    const counter = resolveSiege(snap({}, ['countermine']), army, () => 0.5);
    expect(counter.log.some((l) => /contromina/.test(l))).toBe(true);
  });

  it('frecce incendiarie e torri d\'assedio hanno una contromossa', async () => {
    const { resolveSiege } = await import('../src/game/sim/siege');
    expect(resolveSiege(snap(), army, () => 0.5).log.some((l) => /prendono fuoco/.test(l))).toBe(true);
    expect(resolveSiege(snap({ cistern: true }), army, () => 0.5).log.some((l) => /cisterna spengono/.test(l))).toBe(true);
    const deep = resolveSiege(snap({ moat: { tiles: 40, coverage: 0.8, depth: 2, flooded: 0, stakes: 0 } }), army, () => 0.5);
    expect(deep.log.some((l) => /impantanata/.test(l) || /ritira/.test(l) || /respinge/.test(l))).toBe(true);
    // Prima del 1000 non conoscono queste tecniche
    const early = resolveSiege(snap(), { ...army, year: 950 }, () => 0.5);
    expect(early.log.some((l) => /minatori|incendiarie/.test(l))).toBe(false);
  });

  it('un reparto ha un comandante che migliora vincendo e torna disponibile', () => {
    const st = createInitialState(21, 'Rocca', { preset: 'pianura', lords: 1 });
    st.nextRaidDay = 1e9;
    const g = new Game(st, () => 0.5);
    const [x, z] = g.homeSite();
    g.place('keep_wood', x - 1, z - 1);
    g.state.army.infantry = 30;
    const c = g.formCompany({ infantry: 20, archers: 0, cavalry: 0, rams: 0, trebuchets: 0 })!;
    expect(c.cmd?.name).toBeTruthy();
    const weak = g.fieldStrength([{ ...c, cmd: undefined }], []);
    expect(g.fieldStrength([c], [])).toBeGreaterThan(weak);
    c.cmd!.skill = 0.2;
    (g as unknown as { mergeHome(c: unknown): void }).mergeHome(c);
    expect(g.state.veterans?.[0].skill).toBe(0.2);
    expect(g.formCompany({ infantry: 10, archers: 0, cavalry: 0, rams: 0, trebuchets: 0 })!.cmd?.skill).toBe(0.2);
  });
});
