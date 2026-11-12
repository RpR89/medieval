import { describe, expect, it } from 'vitest';
import { TIME_SCALE } from '../src/game/data/calendar';
import { Game } from '../src/game/sim/game';
import { createInitialState, type Force } from '../src/game/sim/state';
import { mulberry32 } from '../src/game/world/terrain';
import { getBuilding } from '../src/game/data/buildings';

// Nei test le costruzioni sono immediate, salvo dove si provano i cantieri
Game.instantByDefault = true;

const F = (f: Partial<Force>): Force => ({ infantry: 0, archers: 0, cavalry: 0, rams: 0, trebuchets: 0, ...f });

function single(lords: number, year = 1000, prebuilt = true) {
  const st = createInitialState(21, 'Rocca', { preset: 'pianura', lords });
  st.day = (year - 900) * 360 + 100;
  st.nextRaidDay = 1e9;
  const g = new Game(st, mulberry32(4));
  Object.assign(g.state.resources, { wood: 1e5, stone: 1e5, lime: 1e5, coins: 1e5, grain: 1e5 });
  g.storageCap = () => 1e9;
  const [x, z] = g.homeSite();
  g.place('keep_wood', x - 1, z - 1);
  g.levelOverride = 5;
  // Per le prove di diplomazia e guerra i signori hanno già il castello della loro epoca
  if (prebuilt) g.buildLordCastlesNow();
  return g;
}

function run(g: Game, days: number, until?: () => boolean) {
  // Durate in "giorni di prima": ora un giorno dura TIME_SCALE volte meno
  for (let i = 0; i < days * 4 * TIME_SCALE; i++) {
    g.advance(0.25);
    if (until?.()) return true;
  }
  return false;
}

describe('signori rivali', () => {
  it('la mappa si ingrandisce e ogni signore ha il suo castello e il suo territorio', () => {
    const g = single(3);
    expect(g.terrain.size).toBe(208);
    expect(g.terrain.sites).toHaveLength(4);
    expect(g.lords()).toHaveLength(3);
    for (const l of g.lords()) {
      const keep = g.others.find((b) => b.owner === l.id && getBuilding(b.defId).fort === 'keep');
      expect(keep, l.name).toBeTruthy();
      expect(g.others.filter((b) => b.owner === l.id && getBuilding(b.defId).fort === 'wall').length).toBeGreaterThan(15);
      // Non si costruisce nel territorio di un signore
      const [sx, sz] = g.lordKeep(l);
      expect(g.canPlace('hut', sx + 8, sz + 8).reason).toMatch(/territorio/);
    }
  });

  it('i signori partono da zero e costruiscono il castello col tempo', () => {
    const g = single(1, 950, false);
    const l = g.lords()[0];
    expect(l.level).toBe(0);
    expect(g.others.filter((b) => b.owner === l.id && b.site === undefined)).toHaveLength(0);
    // Dopo pochi giorni ci sono i primi cantieri
    run(g, 3);
    expect(l.jobs!.length).toBeGreaterThan(0);
    expect(g.others.some((b) => b.owner === l.id && b.site !== undefined && b.site < 4)).toBe(true);
    // In un paio d'anni: motta, campi, case e una cinta che cresce
    run(g, 5000);
    expect(l.level).toBeGreaterThanOrEqual(1);
    const own = (pred: (id: string) => boolean) => l.buildings.filter((b) => pred(b.defId)).length;
    expect(own((id) => id.startsWith('field_'))).toBeGreaterThan(1);
    expect(own((id) => id === 'hut')).toBeGreaterThan(1);
    expect(own((id) => getBuilding(id).fort === 'wall')).toBeGreaterThan(5);
    expect(l.pop!).toBeGreaterThan(20);
  });

  it('con le epoche il signore fa evolvere mura e mastio', () => {
    const g = single(1, 1046, false);
    const l = g.lords()[0];
    l.wealth = 3000;
    // Il calendario è più lento: servono più giorni "di prima" per arrivare alle mura in pietra
    run(g, 9000);
    const walls = l.buildings.filter((b) => getBuilding(b.defId).fort === 'wall').map((b) => b.defId);
    expect(walls.length).toBeGreaterThan(10);
    // Le palizzate costruite prima del 1050 sono diventate muri in pietrame
    expect(walls.join()).toMatch(/wall_rubble/);
    expect(l.level).toBeGreaterThanOrEqual(2);
  }, 30000);

  it('il diplomatico viaggia, porta il dono e torna', () => {
    const g = single(1);
    const l = g.lords()[0];
    // Durante il viaggio i rapporti cambiano anche per gli intrighi: si guarda il salto all'arrivo
    l.nextIntrigue = 1e9;
    const c = g.sendDiplomat(l.id, 'gift', { coins: 400 })!;
    expect(c).not.toBeNull();
    expect(g.canSendDiplomat(l.id, {}).reason).toMatch(/già in viaggio/);
    let before = l.relation;
    let jumped = 0;
    expect(run(g, 200, () => {
      if (l.relation - before > 15) jumped = l.relation - before;
      before = l.relation;
      return !g.state.companies?.length;
    })).toBe(true);
    expect(jumped).toBeGreaterThan(15);
  });

  it('l\'alleanza richiede buoni rapporti; gli alleati mandano rinforzi', () => {
    const g = single(1);
    const l = g.lords()[0];
    l.relation = -10;
    g.sendDiplomat(l.id, 'alliance');
    run(g, 80, () => !g.state.companies?.length);
    expect(l.status).not.toBe('alliance');
    l.relation = 70;
    g.sendDiplomat(l.id, 'alliance', { coins: 300 });
    run(g, 80, () => !g.state.companies?.length);
    expect(l.status).toBe('alliance');
    l.army = { infantry: 40, archers: 20, cavalry: 8 };
    g.state.army = { infantry: 0, archers: 0, cavalry: 0 };
    expect(g.siegeSnapshot().army.infantry).toBe(10);
  });

  it('un signore in guerra manda l\'esercito: marcia, assedia e torna a casa', () => {
    const g = single(1);
    const l = g.lords()[0];
    l.army = { infantry: 30, archers: 10, cavalry: 4 };
    l.relation = -90;
    l.nextAction = 0;
    g.advance(1.25);
    expect(l.status).toBe('war');
    expect(l.companies).toHaveLength(1);
    let seen = 0;
    run(g, 120, () => {
      seen = Math.max(seen, g.enemiesInTerritory());
      return !!g.state.lastSiege;
    });
    expect(seen).toBeGreaterThan(0);
    expect(g.state.lastSiege?.attacker).toMatch(l.name);
  });

  it('assaltare il castello di un signore: guerra, battaglia, bottino; se cade diventa vassallo', () => {
    const g = single(1);
    const l = g.lords()[0];
    l.army = { infantry: 3, archers: 2, cavalry: 0 };
    l.wealth = 2000;
    Object.assign(g.state.army, { infantry: 60, archers: 20, cavalry: 10 });
    // La marcia è lunga e col tempo che fa i viveri delle sacche non bastano: servono i carri
    g.state.wagons = 2;
    const c = g.formCompany(F({ infantry: 60, archers: 20, cavalry: 10 }), 2)!;
    const keep = g.others.find((b) => b.owner === l.id && getBuilding(b.defId).fort === 'keep')!;
    expect(g.orderAttack([c.id], keep.x + 1, keep.z + 1).ok).toBe(true);
    expect(l.status).toBe('war');
    run(g, 200, () => !!g.state.campaignLog?.length);
    expect(g.state.campaignLog?.[0].outcome).not.toBe('repelled');
    const cargo = (g.state.companies ?? []).reduce((s, x) => s + (x.cargo?.coins ?? 0), 0);
    expect(cargo).toBeGreaterThan(0);
    if (g.state.campaignLog?.[0].outcome === 'sacked') {
      expect(l.status).toBe('vassal');
      // Senza truppe da pagare, il tributo fa salire le monete (oltre alle tasse)
      g.state.companies = [];
      g.state.army = { infantry: 0, archers: 0, cavalry: 0 };
      g.state.population = 0;
      const wealth = l.wealth;
      const coins = g.state.resources.coins;
      g.advance(5);
      expect(g.state.resources.coins).toBeGreaterThan(coins);
      expect(l.wealth).toBeLessThan(wealth + 5 * (0.5 + l.level * 0.6));
    }
  });

  it('i rapporti peggiorati portano alla guerra; la pace si può chiedere', () => {
    const g = single(1);
    const l = g.lords()[0];
    l.relation = -75;
    g.advance(1.25);
    expect(l.status).toBe('war');
    l.relation = -30;
    l.nextAction = 1e9;
    g.sendDiplomat(l.id, 'peace', { coins: 600 });
    // Il diplomatico può essere imprigionato solo se la missione non è di pace
    run(g, 80, () => !g.state.companies?.length);
    expect(l.status).toBe('neutral');
  });
});

describe('sviluppo dei signori', () => {
  it('nel tempo ampliano il feudo con botteghe, allevamento e caserme e arrivano al castello di pietra', () => {
    const st = createInitialState(7, 'Rocca', { preset: 'pianura', lords: 2 });
    const g = new Game(st, mulberry32(3));
    g.storageCap = () => 1e9;
    for (let d = 0; d < 360 * 170; d++) g.advance(1);
    for (const l of g.lords()) {
      const ids = new Set(l.buildings.map((b) => b.defId));
      for (const id of ['market', 'barracks', 'smithy', 'pasture_cattle', 'tavern', 'barber']) expect(ids.has(id), `${l.name}: ${id}`).toBe(true);
      // La piazza arriva quando il borgo supera i 70 abitanti
      if ((l.pop ?? 0) >= 75) expect(ids.has('square'), `${l.name}: piazza`).toBe(true);
      expect(l.level, l.name).toBeGreaterThanOrEqual(3);
    }
  }, 60000);
});
