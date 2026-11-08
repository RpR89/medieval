import { describe, expect, it } from 'vitest';
import { Game } from '../src/game/sim/game';
import { createInitialState } from '../src/game/sim/state';
import { mulberry32 } from '../src/game/world/terrain';

Game.instantByDefault = true;

function realm(lords = 3) {
  const st = createInitialState(33, 'Rocca', { preset: 'pianura', lords });
  st.day = 150 * 360 + 100;
  st.nextRaidDay = 1e9;
  const g = new Game(st, mulberry32(9));
  Object.assign(g.state.resources, { wood: 1e4, stone: 1e4, coins: 1e4, grain: 1e4 });
  const [x, z] = g.homeSite();
  g.place('keep_wood', x - 1, z - 1);
  g.buildLordCastlesNow();
  return g;
}

describe('intrighi tra signori', () => {
  it('i signori litigano, si alleano e si fanno la guerra tra loro', () => {
    const g = realm(3);
    const [a, b] = g.lords();
    // Due signori che si odiano, uno molto più forte
    a.personality = 'aggressive';
    a.army = { infantry: 80, archers: 30, cavalry: 10 };
    b.army = { infantry: 5, archers: 2, cavalry: 0 };
    a.ties = { [b.id]: -90 };
    b.ties = { [a.id]: -90 };
    for (let i = 0; i < 4000 && !(a.foes ?? []).includes(b.id); i++) g.advance(0.25);
    expect(a.foes).toContain(b.id);
    expect(g.state.log.some((e) => /dichiara guerra/.test(e.text))).toBe(true);
    // Prima o poi le truppe partono contro il nemico
    for (let i = 0; i < 8000 && !a.companies.some((c) => c.targetLord === b.id) && !g.state.log.some((e) => /marcia con .* contro/.test(e.text)); i++) g.advance(0.25);
    expect(g.state.log.some((e) => /marcia con .* contro/.test(e.text))).toBe(true);
  });
});

describe('proposte al giocatore', () => {
  it('si accettano o si rifiutano con effetti concreti', () => {
    const g = realm(2);
    const [a, b] = g.lords();
    a.relation = 70;
    // Una proposta di nozze
    (g as unknown as { propose: (p: object) => void }).propose({ lord: a.id, kind: 'marriage', coins: 300, text: 'Nozze' });
    const coins = g.state.resources.coins;
    const p = g.pendingProposals()[0];
    expect(g.answerProposal(p.id, true)).toMatch(/alleato/);
    expect(a.status).toBe('alliance');
    expect(g.state.resources.coins).toBe(coins + 300);
    // Richiesta d'aiuto: si entra in guerra contro l'altro signore
    a.foes = [b.id];
    b.foes = [a.id];
    (g as unknown as { propose: (p: object) => void }).propose({ lord: a.id, kind: 'help', target: b.id, coins: 100, text: 'Aiuto' });
    g.answerProposal(g.pendingProposals()[0].id, true);
    expect(b.status).toBe('war');
    // Commercio: compriamo pietra
    (g as unknown as { propose: (p: object) => void }).propose({ lord: b.id, kind: 'trade', coins: -200, goods: { stone: 50 }, text: 'Pietra' });
    const stone = g.state.resources.stone;
    g.answerProposal(g.pendingProposals()[0].id, true);
    expect(g.state.resources.stone).toBe(stone + 50);
  });

  it('una spia catturata rivela il castello del suo signore; le proposte ignorate scadono', () => {
    const g = realm(1);
    const l = g.lords()[0];
    const [kx, kz] = g.lordKeep(l);
    g.updateVision();
    expect(g.isExplored(kx, kz)).toBe(false);
    (g as unknown as { propose: (p: object) => void }).propose({ lord: l.id, kind: 'spy', text: 'Spia' });
    g.answerProposal(g.pendingProposals()[0].id, true);
    expect(g.isExplored(kx, kz)).toBe(true);
    (g as unknown as { propose: (p: object) => void }).propose({ lord: l.id, kind: 'tribute', coins: 100, text: 'Tributo' });
    const rel = l.relation;
    g.advance(90);
    expect(g.pendingProposals()).toHaveLength(0);
    expect(l.relation).toBeLessThan(rel);
  });
});
