import { describe, expect, it } from 'vitest';
import { Game, lineTiles } from '../src/game/sim/game';
import { createInitialState, type Force, type IncomingAttack } from '../src/game/sim/state';
import { mulberry32, Tile } from '../src/game/world/terrain';
import { packBuildings } from '../src/net/match';

/** Due castelli nella stessa partita, collegati "a mano" come farebbe la rete. */
function duel(year = 1100) {
  const mk = (slot: 0 | 1) => {
    const st = createInitialState(5, slot ? 'Rocca del Sud' : 'Rocca del Nord', { preset: 'pianura', match: { id: 'm', slot } });
    st.day = (year - 900) * 360 + 100;
    st.nextRaidDay = 1e9; // niente predoni in questi test
    const g = new Game(st, mulberry32(10 + slot));
    g.terrain.tiles.fill(Tile.Grass);
    g.levelOverride = 5;
    Object.assign(g.state.resources, { wood: 1e5, stone: 1e5, coins: 5000, charcoal: 500, grain: 2000 });
    g.storageCap = () => 1e9;
    return g;
  };
  const a = mk(0);
  const b = mk(1);
  // Ognuno vede gli edifici dell'altro
  const sync = () => {
    a.setOthers(packBuildings(b.state.buildings));
    b.setOthers(packBuildings(a.state.buildings));
  };
  // Inoltro dei messaggi: annuncio d'attacco e risultato
  a.onAttackResolved((r) => b.applyAttackResult(r));
  b.onAttackResolved((r) => a.applyAttackResult(r));
  const send = (from: Game, to: Game, fromName: string) => {
    for (const e of from.state.expeditions ?? []) {
      if (e.status !== 'marching') continue;
      const inc: IncomingAttack = { id: e.id, from: fromName, troops: e.troops, stance: e.stance, departDay: e.departDay, arriveDay: e.arriveDay };
      to.receiveAttack(inc);
    }
  };
  return { a, b, sync, send };
}

const force = (f: Partial<Force>): Force => ({ infantry: 0, archers: 0, cavalry: 0, rams: 0, trebuchets: 0, ...f });

/** Castello difeso: anello di palizzate con porta attorno alla motta. */
function fortify(g: Game, stone = false) {
  const [cx, cz] = g.homeSite();
  g.place(stone ? 'keep_stone' : 'keep_wood', cx - 1, cz - 1);
  const r = 5;
  const wall = stone ? 'wall_stone' : 'palisade';
  const gate = stone ? 'gate_stone' : 'gate_wood';
  g.placeLine(wall, lineTiles(cx - r, cz - r, cx + r, cz - r));
  g.placeLine(wall, lineTiles(cx - r, cz + r, cx + r, cz + r));
  g.placeLine(wall, lineTiles(cx - r, cz - r + 1, cx - r, cz + r - 1));
  g.place(gate, cx + r, cz);
  g.placeLine(wall, lineTiles(cx + r, cz - r + 1, cx + r, cz - 1));
  g.placeLine(wall, lineTiles(cx + r, cz + 1, cx + r, cz + r - 1));
  expect(g.analysis().closed).toBe(true);
}

function runUntil(gs: Game[], pred: () => boolean, maxDays = 200) {
  for (let d = 0; d < maxDays * 4 && !pred(); d++) for (const g of gs) g.advance(0.25);
}

describe('spedizioni', () => {
  it('le truppe partono, marciano, combattono e i superstiti tornano col bottino', () => {
    const { a, b, sync, send } = duel();
    const [bx, bz] = b.homeSite();
    b.place('keep_wood', bx - 1, bz - 1); // castello senza mura
    b.state.resources.coins = 3000;
    sync();
    Object.assign(a.state.army, { infantry: 30, archers: 10, cavalry: 8 });
    const e = a.launch(force({ infantry: 25, archers: 10, cavalry: 8 }), 'resolute')!;
    expect(e).not.toBeNull();
    expect(a.state.army.infantry).toBe(5); // a casa ne restano pochi
    expect(e.arriveDay - e.departDay).toBe(a.marchDays(e.troops));
    send(a, b, 'Rocca del Nord');
    expect(b.state.log.at(-1)!.text).toMatch(/marcia contro di noi/);
    const coinsBefore = a.state.resources.coins;
    runUntil([a, b], () => !a.state.expeditions?.length);
    expect(a.state.campaignLog?.length).toBe(1);
    expect(a.state.campaignLog![0].outcome).not.toBe('repelled');
    expect(a.state.army.infantry).toBeGreaterThan(5); // i superstiti sono tornati
    expect(a.state.resources.coins).toBeGreaterThan(coinsBefore - 400); // il bottino compensa la paga
  });

  it('un castello ben fortificato respinge un attacco con forze pari', () => {
    const { a, b, sync, send } = duel();
    fortify(b);
    Object.assign(b.state.army, { infantry: 8, archers: 8, cavalry: 0 });
    sync();
    Object.assign(a.state.army, { infantry: 12, archers: 4, cavalry: 0 });
    a.launch(force({ infantry: 12, archers: 4 }), 'resolute');
    send(a, b, 'Nord');
    runUntil([a, b], () => a.state.expeditions?.[0]?.status === 'returning');
    expect(a.state.expeditions![0].result!.outcome).toBe('repelled');
  });

  it('arieti e trabucchi servono per espugnare un castello in pietra', () => {
    const withEngines = (engines: boolean) => {
      const { a, b, sync, send } = duel(1250);
      fortify(b, true);
      Object.assign(b.state.army, { infantry: 6, archers: 6, cavalry: 0 });
      sync();
      Object.assign(a.state.army, { infantry: 40, archers: 15, cavalry: 5 });
      const [ax, az] = a.homeSite();
      expect(a.place('siege_workshop', ax + 6, az + 6), String(a.canPlace('siege_workshop', ax + 6, az + 6).reason)).not.toBeNull();
      if (engines) {
        for (const t of ['rams', 'rams', 'trebuchets'] as const) expect(a.buildEngine(t), String(a.canBuildEngine(t).reason)).toBe(true);
      }
      const f = force({ infantry: 40, archers: 15, cavalry: 5, rams: engines ? 2 : 0, trebuchets: engines ? 1 : 0 });
      a.launch(f, 'allin');
      send(a, b, 'Nord');
      runUntil([a, b], () => a.state.expeditions?.[0]?.status === 'returning');
      return a.state.expeditions![0].result!;
    };
    const without = withEngines(false);
    const withE = withEngines(true);
    expect(withE.defenderLosses + (withE.outcome !== 'repelled' ? 100 : 0)).toBeGreaterThan(without.defenderLosses + (without.outcome !== 'repelled' ? 100 : 0) - 1);
  });

  it('controlla le forze disponibili e le regole', () => {
    const { a } = duel();
    a.state.army.infantry = 3;
    expect(a.canLaunch(force({ infantry: 5 })).reason).toMatch(/abbastanza/);
    expect(a.canLaunch(force({})).reason).toMatch(/almeno un soldato/);
    a.engines().rams = 1;
    expect(a.canLaunch(force({ infantry: 1, rams: 1 })).reason).toMatch(/2 fanti/);
    a.locked = true;
    expect(a.canLaunch(force({ infantry: 1 })).reason).toMatch(/attesa/);
    const solo = new Game(createInitialState(1));
    expect(solo.canLaunch(force({ infantry: 1 })).reason).toMatch(/multigiocatore/);
  });

  it('la cavalleria marcia più veloce, le macchine rallentano', () => {
    const { a } = duel();
    const cav = a.marchDays(force({ cavalry: 5 }));
    const inf = a.marchDays(force({ infantry: 5 }));
    const treb = a.marchDays(force({ infantry: 5, trebuchets: 1 }));
    expect(cav).toBeLessThan(inf);
    expect(treb).toBeGreaterThan(inf);
  });

  it('l\'annuncio di un attacco è idempotente (si può rimandare dopo una riconnessione)', () => {
    const { a, b, send } = duel();
    a.state.army.infantry = 5;
    a.launch(force({ infantry: 5 }), 'cautious');
    send(a, b, 'Nord');
    send(a, b, 'Nord');
    expect(b.state.incoming).toHaveLength(1);
  });

  it('stima le difese dell\'avversario dai suoi edifici', () => {
    const { a, b, sync } = duel();
    fortify(b);
    sync();
    const intel = a.opponentIntel()!;
    expect(intel.closed).toBe(true);
    expect(intel.walls).toBeGreaterThan(30);
    expect(intel.gates).toBe(1);
  });
});
