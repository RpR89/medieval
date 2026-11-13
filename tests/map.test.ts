import { expect, it } from 'vitest';
import { Game } from '../src/game/sim/game';
import { createInitialState } from '../src/game/sim/state';
import { PRESETS } from '../src/game/world/presets';
it('mappe bilanciate: ogni signore e il giocatore hanno una cava di pietra (o ferro, o oro) nel territorio', () => {
  const miss: string[] = [];
  for (const preset of Object.keys(PRESETS)) for (let seed = 1; seed < 8; seed++) {
    const g = new Game(createInitialState(seed, 'R', { preset: preset as never, lords: 4 }), () => 0.5);
    const G = g as unknown as { lordSpotSearch(l: unknown, id: string, inside: boolean): unknown };
    for (const l of g.lords()) if (!G.lordSpotSearch(l, 'quarry', false)) miss.push(`${preset}/${seed}/${l.id}`);
    // Anche il giocatore: una casella di roccia entro 20 dal suo sito
    const [hx, hz] = g.homeSite();
    let ok = false;
    for (let z = hz - 20; z <= hz + 20 && !ok; z++) for (let x = hx - 20; x <= hx + 20 && !ok; x++) ok = g.canPlace('quarry', x, z).reason !== 'Va costruita sulla roccia' && g.terrain.tiles[z * g.terrain.size + x] === 2;
    if (!ok) miss.push(`${preset}/${seed}/player`);
  }
  expect(miss).toEqual([]);
}, 120000);
