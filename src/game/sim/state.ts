import type { UnitType } from '../data/buildings';
import { emptyResources, type Resources } from '../data/resources';
import { DAYS_PER_YEAR } from '../data/calendar';
import type { PresetId } from '../world/presets';
import type { Cost } from '../data/resources';
import type { Behavior, Formation, Stance } from '../data/units';
import { createLords, type Lord } from './lords';
import { FACTION_LIST, FACTIONS, type FactionId } from '../data/factions';
import { mulberry32 } from '../world/terrain';

export interface PlacedBuilding {
  uid: number;
  defId: string;
  x: number;
  z: number;
  /** Capi di bestiame (solo recinti). Valore continuo, si mostra arrotondato. */
  herd?: number;
  /** Punti vita attuali (solo fortificazioni). */
  hp?: number;
  /** Miglioramenti costruiti (id di UPGRADES). */
  upgrades?: string[];
  /** Proprietario per gli edifici dei signori controllati dal gioco (indice del signore). */
  owner?: number;
  /** Livello degli edifici civili (1 se assente). */
  level?: number;
  /** Soldati di guardia (torri di avvistamento). */
  garrison?: { infantry: number; archers: number };
  /** Solo edifici degli altri: cantiere allo stadio 0-3, oppure 4 = lavori su un edificio finito. */
  site?: number;
}

/** Lavoro in corso dei costruttori: nuovo edificio, miglioramento o evoluzione. */
export interface BuildJob {
  id: number;
  kind: 'build' | 'upgrade' | 'evolve' | 'level';
  /** Edificio (o cantiere, per 'build') su cui si lavora. */
  uid: number;
  /** Miglioramento da costruire. */
  upId?: string;
  /** Tipo in cui si trasforma (evoluzione). */
  to?: string;
  /** Giornate di lavoro necessarie e già svolte. */
  work: number;
  done: number;
  /** Materiali già pagati (rimborsati se si annulla). */
  cost: Cost;
  /** Squadra: al massimo quanti costruttori ci lavorano (se assente, quanti ne servono). */
  crew?: number;
  /** Sospeso: non avanza e libera i costruttori per altri lavori. */
  paused?: boolean;
}

/** Piano permanente: evolve da solo le mura di un tipo appena ci sono i materiali. */
export interface WallPlan {
  defId: string;
}

/** Rapporto dell'ultimo assedio, per l'interfaccia. */
export interface SiegeReport {
  day: number;
  attacker: string;
  outcome: 'repelled' | 'held' | 'sacked';
  log: string[];
  attackerLosses: number;
  defenderLosses: number;
  loot: number;
}

/** Forze di una spedizione: soldati e macchine d'assedio. */
export interface Force {
  infantry: number;
  archers: number;
  cavalry: number;
  rams: number;
  trebuchets: number;
}

export type Outcome = 'repelled' | 'held' | 'sacked';

/** Esito di un attacco, calcolato dal difensore e inviato all'attaccante. */
export interface AttackResult {
  id: string;
  outcome: Outcome;
  survivors: Force;
  loot: Cost;
  log: string[];
  attackerLosses: number;
  defenderLosses: number;
}

/** Spedizione in partenza dal proprio castello. */
export interface Expedition {
  id: string;
  troops: Force;
  stance: Stance;
  departDay: number;
  arriveDay: number;
  status: 'marching' | 'returning';
  returnDay?: number;
  result?: AttackResult;
}

/** Reparto di truppe sul campo, comandato dal giocatore. */
export interface Company {
  id: string;
  troops: Force;
  /** Posizione continua sulla mappa (in caselle). */
  x: number;
  z: number;
  /** Ordine corrente. */
  order: 'idle' | 'move' | 'attack' | 'home' | 'siege';
  /** Caselle ancora da percorrere. */
  path?: Array<[number, number]>;
  /** Bersaglio dell'attacco (casella di un edificio nemico). */
  target?: [number, number];
  /** Bottino trasportato. */
  cargo?: Cost;
  /** Impegnato in un assalto (id dell'attacco). */
  engaged?: string;
  heading?: number;
  formation?: Formation;
  behavior?: Behavior;
  /** Velocità imposta quando si marcia in gruppo (quella del più lento). */
  groupSpeed?: number;
  /** Proprietario per i reparti dei signori controllati dal gioco (indice del signore). */
  owner?: number;
  /** Spedizione di un signore contro un altro signore. */
  targetLord?: number;
  /** Diplomatico in missione (nessun soldato). */
  envoy?: { lord: number; mission: DiploMission; gift?: Cost };
  /** Esploratore a cavallo (nessun soldato): vede lontano. */
  scout?: boolean;
  /** Viveri portati dietro (unità di cibo): fuori dal territorio i soldati mangiano questi. */
  food?: number;
  /** Carri delle salmerie al seguito. */
  wagons?: number;
}

export type DiploMission = 'alliance' | 'pact' | 'peace' | 'gift' | 'tribute' | 'war';

/** Assedio in corso al nostro castello: dura giorni, a fasi, un giro di mura alla volta. */
export interface ActiveSiege {
  attacker: string;
  /** Signore che assedia (assente per i predoni). */
  lord?: number;
  companyId?: string;
  troops: Force;
  startTroops: number;
  /** Morale degli assedianti (0-1). */
  morale: number;
  startDay: number;
  phase: 'prepare' | 'bombard' | 'assault';
  /** Giorno in cui finisce la fase corrente. */
  nextDay: number;
  /** Giri di mura già caduti. */
  breached: number;
  assaults: number;
  /** Scale e macchine costruite sul posto. */
  ladders: number;
  mangonels: number;
  camp: [number, number];
  /** Tratto di mura preso di mira dal bombardamento. */
  target?: number;
  /** Scorte rimaste fuori dalle mura (granai esterni): non si possono usare. */
  isolated: Cost;
  /** Giorni passati senza cibo dentro le mura. */
  starving: number;
  /** Giorno da cui si può tentare un'altra sortita. */
  sortieReady: number;
  log: Array<{ day: number; text: string }>;
}

/** Il nostro assedio al castello di un signore: lo decidiamo noi, fase per fase. */
export interface OffensiveSiege {
  lord: number;
  companyIds: string[];
  camp: [number, number];
  startDay: number;
  ladders: number;
  mangonels: number;
  /** Dove tirano le macchine: tratto più debole, porta o torre. */
  aim: 'weakest' | 'gate' | 'tower';
  target?: number;
  /** Giorni di fame nel castello assediato. */
  starving: number;
  assaults: number;
  /** Prossima sortita possibile degli assediati. */
  sallyDay: number;
  log: Array<{ day: number; text: string }>;
}

/** Proposta di un signore al giocatore: si accetta o si rifiuta. */
export interface Proposal {
  id: number;
  lord: number;
  kind: 'help' | 'alliance' | 'marriage' | 'trade' | 'tribute' | 'spy';
  text: string;
  expires: number;
  coins?: number;
  goods?: Cost;
  /** Signore contro cui si chiede aiuto. */
  target?: number;
}

/** Esercito nemico in marcia verso il proprio castello. */
export interface IncomingAttack {
  id: string;
  from: string;
  troops: Force;
  stance: Stance;
  departDay: number;
  arriveDay: number;
  resolved?: AttackResult;
  /** Effetto della formazione degli assalitori: frecce subite e forza in mischia. */
  tactics?: { arrows: number; melee: number };
}

export type EventKind = 'info' | 'good' | 'bad';

export interface GameEvent {
  day: number;
  text: string;
  kind: EventKind;
}

export type SeasonEventId = 'poor_harvest' | 'bumper' | 'flood' | 'plague' | 'harsh_winter' | 'merchants';

export interface ActiveEvent {
  id: SeasonEventId;
  until: number;
  text: string;
}

export interface GameState {
  version: 1;
  seed: number;
  castleName: string;
  /** Giorni trascorsi dall'inizio (con decimali). */
  day: number;
  resources: Resources;
  population: number;
  buildings: PlacedBuilding[];
  army: Record<UnitType, number>;
  nextUid: number;
  nextRaidDay: number;
  log: GameEvent[];
  lastSiege?: SiegeReport;
  /** Tipo di mappa (default: classica). */
  preset?: PresetId;
  /** Schieramento scelto all'inizio. */
  faction?: FactionId;
  /** Caselle già esplorate (bit per casella, in base64). */
  explored?: string;
  /** Assedio in corso. */
  siege?: ActiveSiege;
  /** Carri delle salmerie al castello. */
  wagons?: number;
  /** Obiettivi di epoca già raggiunti. */
  goalsDone?: string[];
  /** Eventi stagionali in corso (carestie, epidemie, raccolti…). */
  events?: ActiveEvent[];
  /** Piani di evoluzione automatica delle mura. */
  plans?: WallPlan[];
  nextEventDay?: number;
  /** Nostro assedio in corso a un signore. */
  offense?: OffensiveSiege;
  /** Proposte dei signori in attesa di risposta. */
  proposals?: Proposal[];
  nextProposalId?: number;
  /** Agitatori stranieri che sobillano il popolo fino a questo giorno. */
  agitation?: { lord: number; until: number };
  /** Partita multigiocatore: id e posto (0 = chi l'ha creata, 1 = chi si è unito). */
  match?: { id: string; slot: 0 | 1 };
  /** Signori controllati dal gioco (solo in giocatore singolo). */
  lords?: Lord[];
  /** Livello di tassazione (indice di TAX_LEVELS, default 2 = normale). */
  taxLevel?: number;
  /** Contento della popolazione, 0-100. */
  happiness?: number;
  /** Macchine d'assedio in deposito. */
  engines?: { rams: number; trebuchets: number };
  expeditions?: Expedition[];
  /** Reparti sul campo. */
  companies?: Company[];
  incoming?: IncomingAttack[];
  /** Edifici in costruzione (occupano il terreno ma non funzionano ancora). */
  sites?: PlacedBuilding[];
  /** Coda dei lavori, in ordine di priorità. */
  jobs?: BuildJob[];
  nextJobId?: number;
  /** Costruttori desiderati (assente = quanti più possibile). */
  builders?: number;
  /** Ultimi rapporti delle spedizioni concluse. */
  campaignLog?: Array<{ day: number; text: string; outcome: Outcome; log: string[] }>;
}

export interface StateOptions {
  preset?: PresetId;
  match?: { id: string; slot: 0 | 1 };
  /** Numero di signori rivali (0-4), solo in giocatore singolo. */
  lords?: number;
  /** Anno di partenza (vedi START_ERAS). */
  startYear?: number;
  /** Schieramento. */
  faction?: FactionId;
}

/** Ripari di fortuna per chi arriva con il signore: tutta la gente iniziale ha un tetto. */
export const BASE_HOUSING = 24;
/** Famiglie che restano sempre (il seguito del signore): sotto questa soglia nessuno se ne va. */
export const MIN_POPULATION = 5;
export const BASE_STORAGE = 500;
export const FOOD_PER_PERSON = 0.1;
/** Tassa giornaliera per abitante a livello normale (1,5 monete al mese). */
export const TAX_PER_PERSON = 0.05;

/** Epoche da cui si può cominciare, con le risorse di partenza. */
export const START_ERAS = [
  { year: 900, name: 'Motte e palizzate', pop: 20, res: { coins: 300, wood: 220, stone: 60 }, intro: 'costruisci una motta e proteggi la gente' },
  { year: 1050, name: 'Mastio in pietra', pop: 30, res: { coins: 700, wood: 380, stone: 480, lime: 70 }, intro: 'erigi un mastio in pietra' },
  { year: 1150, name: 'Cinte murarie', pop: 40, res: { coins: 1000, wood: 450, stone: 500, lime: 110 }, intro: 'erigi il mastio e una cinta di mura in pietra' },
  { year: 1250, name: 'Castello concentrico', pop: 50, res: { coins: 1400, wood: 500, stone: 500, lime: 150, gold: 20 }, intro: 'costruisci una rocca con torri circolari' },
  { year: 1350, name: 'Tardo Medioevo', pop: 60, res: { coins: 1800, wood: 500, stone: 500, lime: 200, gold: 40 }, intro: 'fortifica la rocca contro eserciti sempre più grandi' },
] as const;

export function createInitialState(seed: number, castleName = 'Castello senza nome', opts: StateOptions = {}): GameState {
  const era = START_ERAS.find((e) => e.year === opts.startYear) ?? START_ERAS[0];
  const day = (era.year - 900) * DAYS_PER_YEAR;
  const resources = emptyResources();
  Object.assign(resources, {
    // Scorte per arrivare al primo raccolto anche partendo da zero (circa un anno)
    grain: 320 + (era.pop - 20) * 8,
    vegetables: 90,
    meat: 50,
    hay: 80,
    // Qualche arma di scorta per i primi soldati, poi serve il fabbro
    weapons: 14,
    ...era.res,
  });
  const lords = !opts.match && opts.lords ? createLords(Math.min(4, opts.lords), seed) : undefined;
  const fx = opts.faction ? FACTIONS[opts.faction].effects : {};
  if (fx.startCoins) resources.coins = Math.round(resources.coins * fx.startCoins);
  for (const [id, n] of Object.entries(fx.start ?? {})) resources[id as keyof Resources] += n ?? 0;
  // I signori rivali prendono gli altri schieramenti
  const rand = mulberry32(seed ^ 0xfac7);
  const others = FACTION_LIST.filter((f) => f.id !== opts.faction).sort(() => rand() - 0.5);
  (lords ?? []).forEach((l, i) => {
    l.faction = others[i % others.length].id;
    l.relation += fx.relations ?? 0;
  });
  for (const l of lords ?? []) {
    // I signori partono da zero come noi, con le scorte dell'epoca
    l.nextAction += day;
    l.pop = era.pop;
    l.wealth = era.res.coins;
    l.res = { food: resources.grain + 70, wood: era.res.wood, stone: era.res.stone, lime: 'lime' in era.res ? era.res.lime : 0 };
  }
  return {
    version: 1,
    seed,
    castleName,
    day,
    resources,
    population: era.pop,
    buildings: [],
    sites: [],
    jobs: [],
    nextJobId: 1,
    army: { infantry: 0, archers: 0, cavalry: 0 },
    nextUid: 1,
    nextRaidDay: day + DAYS_PER_YEAR * 4 - (fx.earlyRaid ?? 0) * 2,
    preset: opts.preset,
    faction: opts.faction,
    match: opts.match,
    lords,
    log: [
      {
        day,
        kind: 'info',
        text: `Anno ${era.year}. Il tuo signore ti affida queste terre: ${era.intro}.`,
      },
    ],
  };
}

/** Rende compatibili salvataggi vecchi o incompleti. */
export function migrateState(raw: unknown): GameState {
  const s = raw as Partial<GameState>;
  if (!s || typeof s !== 'object' || typeof s.seed !== 'number') {
    throw new Error('Salvataggio non valido');
  }
  const base = createInitialState(s.seed, s.castleName);
  return {
    ...base,
    ...s,
    resources: { ...emptyResources(), ...s.resources },
    army: { ...base.army, ...s.army },
    buildings: s.buildings ?? [],
    sites: s.sites ?? [],
    jobs: s.jobs ?? [],
    log: s.log ?? [],
    version: 1,
  } as GameState;
}
