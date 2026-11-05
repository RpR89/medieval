import { describe, expect, it } from 'vitest';
import { Game, FOREIGN } from '../src/game/sim/game';
import { createInitialState } from '../src/game/sim/state';
import { generateTerrain, isBuildableLand, tileAt, Tile } from '../src/game/world/terrain';
import { PRESET_LIST } from '../src/game/world/presets';
import { packBuildings } from '../src/net/match';

describe('mappe', () => {
  it('ogni tipo di mappa a due giocatori lascia liberi entrambi i siti dei castelli', () => {
    for (const p of PRESET_LIST) {
      for (let seed = 0; seed < 20; seed++) {
        const t = generateTerrain(seed, { preset: p.id, players: 2 });
        expect(t.sites).toHaveLength(2);
        for (const [sx, sz] of t.sites) {
          let free = 0;
          for (let z = sz - 4; z < sz + 4; z++) for (let x = sx - 4; x < sx + 4; x++) if (isBuildableLand(tileAt(t, x, z))) free++;
          expect(free, `${p.id} seed ${seed}`).toBeGreaterThan(55);
        }
        expect(t.tiles.includes(Tile.Gold)).toBe(true);
      }
    }
  });

  it('Montana ha molta più roccia della pianura, la valle un fiume largo', () => {
    const count = (preset: 'montana' | 'pianura' | 'valle', tile: Tile) => {
      let n = 0;
      for (let s = 0; s < 10; s++) n += generateTerrain(s, { preset, players: 2 }).tiles.filter((t) => t === tile).length;
      return n;
    };
    expect(count('montana', Tile.Rock)).toBeGreaterThan(2 * count('pianura', Tile.Rock));
    expect(count('valle', Tile.River)).toBeGreaterThan(1.5 * count('pianura', Tile.River));
  });
});

describe('partita a due', () => {
  const make = (slot: 0 | 1) => {
    const st = createInitialState(7, 'C', { preset: 'pianura', match: { id: 'm1', slot } });
    const g = new Game(st);
    Object.assign(g.state.resources, { wood: 1e4, coins: 1e4, stone: 1e4 });
    return g;
  };

  it('ognuno costruisce solo nella propria metà', () => {
    const a = make(0);
    const b = make(1);
    expect(a.terrain.size).toBe(104);
    const [ax, az] = a.homeSite();
    const [bx] = b.homeSite();
    expect(ax).toBeLessThan(52);
    expect(bx).toBeGreaterThan(52);
    expect(a.canPlace('hut', ax, az + 4).ok).toBe(true);
    expect(a.canPlace('hut', bx, az + 4).reason).toBe('Fuori dal tuo territorio');
    expect(b.canPlace('hut', ax, az + 4).reason).toBe('Fuori dal tuo territorio');
  });

  it('bloccata finché manca l\'altro giocatore', () => {
    const a = make(0);
    a.locked = true;
    const [x, z] = a.homeSite();
    expect(a.canPlace('hut', x, z).reason).toMatch(/attesa/);
    expect(a.recruit('infantry')).toBe(0);
    a.locked = false;
    expect(a.canPlace('hut', x, z).ok).toBe(true);
  });

  it('gli edifici dell\'avversario occupano le caselle ma non entrano nell\'economia', () => {
    const a = make(0);
    const b = make(1);
    const [bx, bz] = b.homeSite();
    b.place('keep_wood', bx - 1, bz - 1);
    b.place('hut', bx + 3, bz);
    a.setOthers(packBuildings(b.state.buildings));
    expect(a.others).toHaveLength(2);
    expect(a.buildingAt(bx + 3, bz)?.uid).toBeGreaterThanOrEqual(FOREIGN);
    expect(a.isForeign(a.buildingAt(bx + 3, bz)!)).toBe(true);
    expect(a.state.buildings).toHaveLength(0);
    expect(a.analysis().housing).toBe(10);
    // Non si può migliorare o demolire ciò che è dell'altro
    expect(a.demolish(a.others[0].uid)).toBe(false);
    expect(a.canUpgrade(a.others[0], 'cistern').ok).toBe(false);
  });

  it('lo stato della partita sopravvive al salvataggio', () => {
    const a = make(0);
    const restored = new Game(JSON.parse(JSON.stringify(a.state)));
    expect(restored.state.match).toEqual({ id: 'm1', slot: 0 });
    expect(restored.terrain.preset).toBe('pianura');
    expect(restored.terrain.tiles).toEqual(a.terrain.tiles);
  });
});
