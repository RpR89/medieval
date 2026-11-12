import { describe, expect, it } from 'vitest';
import { Game } from '../src/game/sim/game';
import { createInitialState, migrateState } from '../src/game/sim/state';
import { dateFromDays, DAYS_PER_YEAR, formatDate, formatDuration } from '../src/game/data/calendar';
import { generateTerrain, isBuildableLand, Tile, tileAt } from '../src/game/world/terrain';
import { getBuilding } from '../src/game/data/buildings';

// Nei test le costruzioni sono immediate, salvo dove si provano i cantieri
Game.instantByDefault = true;

function findSpot(game: Game, defId: string): [number, number] {
  for (let z = 0; z < game.terrain.size; z++) {
    for (let x = 0; x < game.terrain.size; x++) {
      if (game.canPlace(defId, x, z).ok) return [x, z];
    }
  }
  throw new Error(`nessun posto per ${defId}`);
}

describe('calendario', () => {
  it('parte nella primavera del 900 e scorre le stagioni', () => {
    expect(dateFromDays(0)).toMatchObject({ year: 900, season: 'spring' });
    expect(dateFromDays(95).season).toBe('summer');
    expect(dateFromDays(DAYS_PER_YEAR * 3 + 280)).toMatchObject({ year: 903, season: 'winter' });
  });
});

describe('territorio', () => {
  it('è deterministico e contiene acqua, bosco, roccia e oro', () => {
    const a = generateTerrain(42);
    const b = generateTerrain(42);
    expect(a.tiles).toEqual(b.tiles);
    for (const t of [Tile.Forest, Tile.Rock, Tile.Gold, Tile.River, Tile.Sea]) {
      expect(a.tiles.includes(t)).toBe(true);
    }
  });

  it('lascia libero il centro per il castello', () => {
    const t = generateTerrain(7);
    const [c, cz] = t.sites[0];
    let free = 0;
    for (let z = cz - 3; z < cz + 3; z++) for (let x = c - 3; x < c + 3; x++) if (isBuildableLand(tileAt(t, x, z))) free++;
    expect(free).toBeGreaterThan(20);
  });
});

describe('costruzione', () => {
  it('paga il costo, occupa le caselle e impedisce sovrapposizioni', () => {
    const game = new Game(createInitialState(1));
    const [x, z] = findSpot(game, 'keep_wood');
    const wood = game.state.resources.wood;
    expect(game.place('keep_wood', x, z)).not.toBeNull();
    expect(game.state.resources.wood).toBe(wood - (getBuilding('keep_wood').cost.wood ?? 0));
    expect(game.canPlace('hut', x + 1, z + 1).ok).toBe(false);
    expect(game.canPlace('keep_wood', 0, 0).reason).toBe('Ne puoi avere uno solo');
  });

  it('blocca gli edifici di epoche future', () => {
    const game = new Game(createInitialState(1));
    expect(game.canPlace('wall_stone', 30, 30)).toMatchObject({ ok: false, reason: 'Disponibile dal 1150' });
  });

  it('richiede la roccia per la cava e l\'acqua per il pescatore', () => {
    const game = new Game(createInitialState(3));
    const [qx, qz] = findSpot(game, 'quarry');
    expect(tileAt(game.terrain, qx, qz)).toBeOneOf([Tile.Rock, Tile.Gold]);
    expect(findSpot(game, 'fisher')).toBeTruthy();
  });

  it('la demolizione rimborsa metà del costo', () => {
    const game = new Game(createInitialState(1));
    const [x, z] = findSpot(game, 'hut');
    const b = game.place('hut', x, z)!;
    const wood = game.state.resources.wood;
    game.demolish(b.uid);
    expect(game.state.resources.wood).toBe(wood + 7);
    expect(game.buildingAt(x, z)).toBeUndefined();
  });
});

describe('simulazione', () => {
  it('il grano si raccoglie in estate e non in inverno', () => {
    const game = new Game(createInitialState(5), () => 0.5);
    const [x, z] = findSpot(game, 'field_grain');
    game.place('field_grain', x, z);
    game.state.resources.grain = 0;
    game.state.population = 4;
    game.state.day = 95;
    const before = game.state.resources.grain;
    game.advance(10);
    const summer = game.state.resources.grain - before;
    expect(summer).toBeGreaterThan(30);

    game.state.day = 280;
    game.state.resources.grain = 1000;
    game.state.resources.vegetables = 0;
    game.state.resources.meat = 0;
    const w = game.state.resources.grain;
    game.advance(5);
    expect(game.state.resources.grain).toBeLessThan(w); // si mangia e basta
  });

  it('senza cibo la popolazione cala', () => {
    const game = new Game(createInitialState(5), () => 0.5);
    for (const id of ['grain', 'vegetables', 'meat'] as const) game.state.resources[id] = 0;
    const pop = game.state.population;
    game.advance(30);
    expect(game.state.population).toBeLessThan(pop);
  });

  it('i bovini si riproducono in primavera e servono fieno in inverno', () => {
    const game = new Game(createInitialState(9), () => 0.5);
    const [x, z] = findSpot(game, 'pasture_cattle');
    const b = game.place('pasture_cattle', x, z)!;
    game.advance(80);
    expect(b.herd!).toBeGreaterThan(4);
    game.state.day = 275;
    game.state.resources.hay = 1000;
    game.advance(10);
    expect(game.state.resources.hay).toBeLessThan(1000);
  });

  it('reclutare richiede la caserma e toglie un abitante', () => {
    const game = new Game(createInitialState(2));
    expect(game.recruit('infantry')).toBe(0);
    const [x, z] = findSpot(game, 'barracks');
    game.place('barracks', x, z);
    const pop = game.state.population;
    expect(game.recruit('infantry', 3)).toBe(3);
    expect(game.state.population).toBe(pop - 3);
    expect(game.armyPower()).toBeGreaterThan(0);
  });

  it('il mercato compra e vende ai prezzi stagionali', () => {
    const game = new Game(createInitialState(2));
    game.levelOverride = 2;
    expect(game.trade('wood', -10).ok).toBe(false);
    const [x, z] = findSpot(game, 'market');
    game.place('market', x, z);
    const coins = game.state.resources.coins;
    expect(game.trade('wood', -10).ok).toBe(true);
    const gain = game.state.resources.coins - coins;
    // Ogni unità venduta fa calare un po' il prezzo: l'incasso è appena sotto il prezzo iniziale
    expect(gain).toBeGreaterThan(0);
    expect(gain).toBeLessThanOrEqual(game.sellPrice('wood') * 10 / 0.95 + 1);
    expect(game.buyPrice('grain')).toBeGreaterThan(game.sellPrice('grain'));
  });

  it('il mercato non si può spremere: vendere abbassa il prezzo, comprare lo alza, e rivendere subito fa perdere', () => {
    const game = new Game(createInitialState(2));
    game.levelOverride = 2;
    const [x, z] = findSpot(game, 'market');
    game.place('market', x, z);
    Object.assign(game.state.resources, { coins: 5000, stone: 500, grain: 500 });
    game.storageCap = () => 1e9;
    const p0 = game.sellPrice('stone');
    game.trade('stone', -200);
    expect(game.sellPrice('stone')).toBeLessThan(p0 * 0.7);
    // Comprare e rivendere la stessa merce non è mai un guadagno
    const c = game.state.resources.coins;
    game.trade('grain', 100);
    game.trade('grain', -100);
    expect(game.state.resources.coins).toBeLessThan(c);
    // Col tempo il mercato si riassesta
    game.advance(120);
    expect(game.sellPrice('stone')).toBeGreaterThan(p0 * 0.85);
  });

  it('d\'inverno la gente brucia legna: senza, si patisce il freddo', () => {
    const st = createInitialState(2);
    st.day = 360 * 5 + 280; // inverno
    st.population = 40;
    st.nextRaidDay = 1e9;
    const game = new Game(st, () => 0.5);
    game.state.resources.wood = 100;
    game.advance(10);
    expect(game.state.resources.wood).toBeLessThan(100 - 40 * 0.012 * 9);
    game.state.resources.wood = 0;
    game.advance(2);
    expect(game.moodTarget().parts.some(([n]) => /legna da ardere/.test(n))).toBe(true);
  });

  it('gli assalti vengono risolti e programmati di nuovo', () => {
    const game = new Game(createInitialState(4), () => 0.5);
    game.state.day = game.state.nextRaidDay - 0.1;
    const next = game.state.nextRaidDay;
    game.advance(0.5);
    expect(game.state.nextRaidDay).toBeGreaterThan(next);
    expect(game.state.lastSiege?.log.length).toBeGreaterThan(1);
  });
});

describe('salvataggi', () => {
  it('sopravvivono a JSON e ricostruiscono l\'occupazione', () => {
    const game = new Game(createInitialState(11));
    const [x, z] = findSpot(game, 'hut');
    game.place('hut', x, z);
    game.advance(20);
    const restored = new Game(migrateState(JSON.parse(JSON.stringify(game.state))));
    expect(restored.buildingAt(x, z)?.defId).toBe('hut');
    expect(restored.state.day).toBeCloseTo(game.state.day);
  });

  it('rifiuta dati non validi', () => {
    expect(() => migrateState({})).toThrow();
  });
});

describe('fiume', () => {
  it('non attraversa mai il centro della mappa', () => {
    for (let seed = 0; seed < 200; seed++) {
      const t = generateTerrain(seed);
      const [c, cz] = t.sites[0];
      for (let z = cz - 4; z < cz + 4; z++) {
        for (let x = c - 4; x < c + 4; x++) expect(tileAt(t, x, z)).not.toBe(Tile.River);
      }
    }
  });
});

describe('risorse della mappa', () => {
  it('ogni mappa ha almeno una vena d\'oro raggiungibile', () => {
    for (let seed = 0; seed < 200; seed++) expect(generateTerrain(seed).tiles.includes(Tile.Gold)).toBe(true);
  });
});

describe('tempo, epoche e bilancio', () => {
  it('si può cominciare da un\'epoca successiva, con più risorse', () => {
    const a = createInitialState(1);
    const b = createInitialState(1, 'X', { startYear: 1250 });
    expect(dateFromDays(b.day).year).toBe(1250);
    expect(b.resources.stone).toBeGreaterThan(a.resources.stone * 5);
    expect(b.population).toBeGreaterThan(a.population);
    expect(b.nextRaidDay).toBeGreaterThan(b.day);
    // Nel 1250 la motta non c'è più: si parte direttamente dal mastio in pietra
    const g = new Game(b);
    g.terrain.tiles.fill(Tile.Grass);
    const [x, z] = g.homeSite();
    expect(g.canPlace('keep_wood', x - 1, z - 1).ok).toBe(false);
    expect(g.place('keep_stone', x - 1, z - 1)).not.toBeNull();
    expect(g.castleLevel()).toBe(3);
  });

  it('la data mostra la stagione e le durate si leggono in stagioni', () => {
    expect(formatDate(dateFromDays(0))).toMatch(/Primavera 900/);
    expect(formatDate(dateFromDays(100))).toMatch(/Estate 900/);
    expect(formatDate(dateFromDays(300))).toMatch(/Inverno 900/);
    expect(formatDuration(3)).toBe('pochi giorni');
    expect(formatDuration(45)).toBe('mezza stagione');
    expect(formatDuration(90)).toBe('1 stagione');
    expect(formatDuration(225)).toBe('2 stagioni e mezza');
    expect(formatDuration(360 * 5)).toBe('5 anni');
  });

  it('il bilancio a stagione mette a confronto tasse e paga dei soldati', () => {
    const g = new Game(createInitialState(1));
    g.state.population = 40;
    const b0 = g.budget();
    expect(b0.taxes).toBeCloseTo(40 * 0.06 * 90);
    expect(b0.perPerson).toBeCloseTo(5.4);
    g.state.army.infantry = 20;
    const b1 = g.budget();
    expect(b1.army).toBeCloseTo(20 * 0.15 * 90);
    expect(b1.net).toBeLessThan(0);
  });
});

describe('registro delle risorse', () => {
  it('spiega entrate, uscite e spese una tantum per voce', () => {
    const game = new Game(createInitialState(5), () => 0.5);
    game.state.day = 95;
    const [x, z] = findSpot(game, 'field_grain');
    game.place('field_grain', x, z);
    game.state.army.infantry = 5;
    game.state.resources.vegetables = 0;
    game.state.resources.meat = 0;
    game.advance(20);
    const grain = game.resourceFlows('grain');
    expect(grain.income.find((r) => r.label === getBuilding('field_grain').name)?.perSeason).toBeGreaterThan(0);
    expect(grain.expense.some((r) => r.label === 'Abitanti (cibo)')).toBe(true);
    expect(grain.expense.some((r) => r.label === 'Soldati (cibo)')).toBe(true);
    const coins = game.resourceFlows('coins');
    expect(coins.income.some((r) => r.label === 'Tasse')).toBe(true);
    expect(coins.expense.some((r) => r.label.startsWith('Paga:'))).toBe(true);
    const wood = game.resourceFlows('wood');
    expect(wood.oneOff.find((r) => r.label === 'Costruzioni')?.amount).toBeLessThan(0);
    const net = coins.income.reduce((a, r) => a + r.perSeason, 0) + coins.expense.reduce((a, r) => a + r.perSeason, 0);
    expect(coins.netPerSeason).toBeCloseTo(net);
  });
});
