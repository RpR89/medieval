import { describe, expect, it } from 'vitest';
import { Game } from '../src/game/sim/game';
import { createInitialState } from '../src/game/sim/state';
import { Tile, mulberry32 } from '../src/game/world/terrain';
import { getBuilding } from '../src/game/data/buildings';

Game.instantByDefault = true;

function single() {
  const st = createInitialState(21, 'Rocca', { preset: 'pianura', lords: 1 });
  st.day = 100 * 360 + 100;
  st.nextRaidDay = 1e9;
  const g = new Game(st, mulberry32(4));
  Object.assign(g.state.resources, { wood: 1e5, stone: 1e5, lime: 1e5, coins: 1e5, grain: 1e5, charcoal: 1e3 });
  g.storageCap = () => 1e9;
  const [x, z] = g.homeSite();
  g.place('keep_wood', x - 1, z - 1);
  g.buildLordCastlesNow();
  return g;
}

describe('nebbia di guerra', () => {
  it('il castello del signore è nascosto finché non lo si scopre', () => {
    const g = single();
    g.updateVision();
    const l = g.lords()[0];
    const keep = g.others.find((b) => b.owner === l.id && getBuilding(b.defId).fort === 'keep')!;
    expect(g.isRevealed(keep)).toBe(false);
    const [hx, hz] = g.homeSite();
    expect(g.isVisible(hx, hz)).toBe(true);
    // Un esploratore lo scopre
    const [kx, kz] = g.lordKeep(l);
    const s = g.sendScout(kx, kz + 8)!;
    expect(s).not.toBeNull();
    for (let i = 0; i < 4000 && !g.isRevealed(keep); i++) {
      g.advance(0.25);
      if (i % 4 === 0) g.updateVision();
    }
    expect(g.isRevealed(keep)).toBe(true);
    // Le caselle esplorate restano tali anche dopo il salvataggio
    const g2 = new Game(JSON.parse(JSON.stringify(g.state)));
    expect(g2.isExplored(kx, kz)).toBe(true);
  });

  it('gli alleati mostrano il loro castello', () => {
    const g = single();
    const l = g.lords()[0];
    const keep = g.others.find((b) => b.owner === l.id)!;
    expect(g.isRevealed(keep)).toBe(false);
    l.status = 'alliance';
    expect(g.isRevealed(keep)).toBe(true);
  });
});

describe('torri di avvistamento', () => {
  it('vedono lontano, di più con le guardie e il fuoco', () => {
    const g = single();
    g.terrain.tiles.fill(Tile.Grass);
    const [hx, hz] = g.homeSite();
    const t = g.place('watchtower', hx + 20, hz)!;
    expect(t).not.toBeNull();
    const base = g.visionOf(t);
    g.updateVision();
    expect(g.isVisible(hx + 20 + base - 1, hz)).toBe(true);
    g.state.army.archers = 4;
    expect(g.setGarrison(t, 3)).toBe(3);
    expect(g.state.army.archers).toBe(1);
    expect(g.upgrade(t, 'signal_fire')).toBe(true);
    expect(g.visionOf(t)).toBe(base + 3 + 4);
    // Le guardie costano la paga anche se sono lontane
    expect(g.troopsAway().archers).toBe(3);
    g.setGarrison(t, 0);
    expect(g.state.army.archers).toBe(4);
  });

  it('una torre presidiata respinge l\'avanguardia, una sguarnita brucia', () => {
    for (const guarded of [false, true]) {
      const g = single();
      const l = g.lords()[0];
      l.status = 'war';
      const [hx, hz] = g.homeSite();
      g.terrain.tiles.fill(Tile.Grass);
      const t = g.place('watchtower', hx + 12, hz)!;
      if (guarded) {
        g.state.army.archers = 10;
        g.upgrade(t, 'watch_fence');
        g.setGarrison(t, 6);
      }
      l.companies.push({ id: 'raid', troops: { infantry: 8, archers: 2, cavalry: 0, rams: 0, trebuchets: 0 }, x: hx + 12.5, z: hz + 0.5, order: 'attack', path: [] });
      g.advance(1.1);
      expect(g.hpState(t) === 'ruin').toBe(!guarded);
    }
  });
});
