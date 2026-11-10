import { ANIMALS } from '../data/animals';
import {
  getBuilding,
  isAvailable,
  seasonIndex,
  type BuildingDef,
  type UnitType,
} from '../data/buildings';
import { dateFromDays, DAYS_PER_SEASON, DAYS_PER_YEAR, formatDuration, SEASON_NAMES, TIME_SCALE, weatherOf, type GameDate } from '../data/calendar';
import { eraForYear, ERAS } from '../data/eras';
import {
  canAfford,
  FOOD_IDS,
  formatCost,
  pay,
  RESOURCE_IDS,
  RESOURCES,
  TAX_LEVELS,
  type Cost,
  type ResourceId,
} from '../data/resources';
import { CARRY, COMMANDER_NAMES, ENGINES, FORMATIONS, MARCH_SPEED, SOLDIER_FOOD, STANCES, TERRAIN_BATTLE, UNITS, WAGON, type Behavior, type EngineType, type Formation, type Stance } from '../data/units';
import { CASTLE_LEVELS, KEEP_EVOLVE, UPGRADE_BY_ID, upgradesFor, type UpgradeDef } from '../data/upgrades';
import { factionEffects, FACTIONS, type FactionDef, type FactionEffects } from '../data/factions';
import { GOALS, type Goal } from '../data/goals';
import { eraIndex as eraIndexOf, escalatedCost, isLevelable, levelEffects, levelUpCost, maxLevelFor } from '../data/levels';
import {
  generateTerrain,
  isBuildableLand,
  mulberry32,
  isWater,
  Tile,
  tileAt,
  type Terrain,
} from '../world/terrain';
import { resolveSiege, type AttackerArmy, type DefenderSnapshot, type SiegeSegment } from './siege';
import { findPath } from './pathfind';
import { lordCastle, lordLevel, PERSONALITIES, STATUS_NAMES, type Lord, type LordJob } from './lords';
import {
  BASE_HOUSING,
  BASE_STORAGE,
  createInitialState,
  FOOD_PER_PERSON,
  MIN_POPULATION,
  TAX_PER_PERSON,
  type AttackResult,
  type BuildJob,
  type Company,
  type EventKind,
  type Expedition,
  type Force,
  type GameState,
  type IncomingAttack,
  type Outcome,
  type OffensiveSiege,
  type PlacedBuilding,
  type ActiveEvent,
  type Commander,
  type Dynasty,
  type WallPlan,
  type SeasonEventId,
} from './state';

/** Ordine in cui si mangia il cibo: prima quello che deperisce. */
const EATING_ORDER: ResourceId[] = [...FOOD_IDS].sort(
  (a, b) => (RESOURCES[b].spoilage ?? 0) - (RESOURCES[a].spoilage ?? 0),
);

const MAX_LOG = 60;

/** Giornate di lavoro per unità di materiale (la pietra e la calce richiedono più fatica). */
const WORK_PER_UNIT: Partial<Record<ResourceId, number>> = { wood: 12, stone: 22, lime: 18, coins: 1.2, gold: 18, charcoal: 4 };
/** Paga giornaliera e cibo in più per ogni costruttore al lavoro. */
export const BUILDER_WAGE = 0.06;
export const BUILDER_FOOD = 0.05;
/** Costruttori disponibili senza loggia dei muratori. */
export const BASE_BUILDERS = 4;

export interface PlaceCheck {
  ok: boolean;
  reason?: string;
}

export interface Summary {
  date: GameDate;
  eraName: string;
  population: number;
  housing: number;
  jobs: number;
  staffing: number;
  soldiers: number;
  storage: number;
  foodPerDay: number;
  defense: number;
  armyPower: number;
  hasMarket: boolean;
  closed: boolean;
}

export interface DefenseBreakdown {
  walls: number;
  towers: number;
  gates: number;
  moats: number;
  keep: number;
  army: number;
  total: number;
  closed: boolean;
  damaged: number;
  ruined: number;
}

export type HpState = 'ok' | 'damaged' | 'ruin';

interface Analysis {
  version: number;
  /** Cinta chiusa attorno al mastio. */
  closed: boolean;
  /** Caselle raggiungibili dal bordo della mappa (fuori dalla cinta). */
  outside: Uint8Array;
  /** Giri di mura tra il bordo della mappa e ogni casella (le mura del giro k hanno profondità k). */
  depth: Uint8Array;
  /** Giri di mura attorno al mastio. */
  rings: number;
  flooded: Set<number>;
  connected: Map<number, number>;
  housing: number;
  jobs: number;
  storage: number;
  taxMul: number;
}

const D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

/**
 * Giri di mura tra il bordo della mappa e ogni casella (BFS 0-1). Entrare in un muro da terreno
 * libero costa 1; muro→muro (mura spesse, porte, torri) e muro→libero costano 0.
 */
function depthFromEdges(wall: Uint8Array, size: number): Uint8Array {
  const depth = new Uint8Array(size * size).fill(255);
  const dq = new Int32Array(size * size * 4);
  let head = size * size * 2;
  let tail = head;
  const relax = (k: number, d: number, front: boolean) => {
    if (d >= depth[k]) return;
    depth[k] = d;
    if (front) dq[--head] = k;
    else dq[tail++] = k;
  };
  for (let i = 0; i < size; i++) {
    for (const k of [i, (size - 1) * size + i, i * size, i * size + size - 1]) relax(k, wall[k], wall[k] === 0);
  }
  while (head < tail) {
    const k = dq[head++];
    const x = k % size;
    const z = (k - x) / size;
    for (const [dx, dz] of D4) {
      const nx = x + dx;
      const nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= size || nz >= size) continue;
      const nk = nz * size + nx;
      const cost = wall[nk] && !wall[k] ? 1 : 0;
      relax(nk, depth[k] + cost, cost === 0);
    }
  }
  return depth;
}
/** Gli uid degli edifici dell'altro giocatore partono da qui. */
export const FOREIGN = 1_000_000;
const D8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;

/** Caselle di una linea retta (anche diagonale) tra due caselle, senza buchi. */
export function lineTiles(x0: number, z0: number, x1: number, z1: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const dx = Math.abs(x1 - x0);
  const dz = Math.abs(z1 - z0);
  const sx = x0 < x1 ? 1 : -1;
  const sz = z0 < z1 ? 1 : -1;
  let err = dx - dz;
  let x = x0;
  let z = z0;
  for (;;) {
    out.push([x, z]);
    if (x === x1 && z === z1) break;
    const e2 = 2 * err;
    if (e2 > -dz) {
      err -= dz;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      z += sz;
    }
    if (out.length > 200) break;
  }
  return out;
}

/**
 * Il castello di un giocatore: stato serializzabile + territorio rigenerato dal seed.
 * Tutta la logica di gioco vive qui, senza dipendenze dalla grafica.
 */
export type SoundCue = 'horn' | 'victory' | 'defeat' | 'bell';

export class Game {
  readonly terrain: Terrain;
  /** uid dell'edificio che occupa ogni casella (0 = libera). */
  readonly occupancy: Int32Array;
  private eventListeners = new Set<(e: { text: string; kind: EventKind }) => void>();
  private attackListeners = new Set<(r: AttackResult) => void>();
  private lastSeasonIndex: number;
  private lastYear: number;
  private cache: Analysis | null = null;
  /** Cresce a ogni cambiamento visibile (costruzioni, demolizioni, miglioramenti, danni). */
  structureVersion = 0;
  /** Cresce solo quando cambiano i nostri edifici (invalida l'analisi di cinta, fossati e strade). */
  private analysisVersion = 0;
  /** Edifici dell'altro giocatore (solo da guardare: non entrano nella nostra economia). */
  others: PlacedBuilding[] = [];
  /** Bloccato: in multigiocatore finché non sono online entrambi i giocatori. */
  locked = false;
  /** Solo per i test: forza il livello del castello. */
  levelOverride?: number;
  /** Valore iniziale di `instantBuild` (i test lo attivano). */
  static instantByDefault = false;
  /** Costruzioni, miglioramenti ed evoluzioni immediati (test). */
  instantBuild = Game.instantByDefault;
  /** Costruttori assegnati a ogni lavoro nell'ultimo passo. */
  lastCrew = new Map<number, number>();
  /** Costruttori al lavoro nell'ultimo passo. */
  lastBuilders = 0;
  private hungerWarned = -1e9;
  private siteStage = new Map<number, number>();
  private visualDirty = false;
  private stageDirty = false;

  constructor(public state: GameState, private random: () => number = Math.random) {
    this.terrain = generateTerrain(state.seed, { preset: state.preset, players: state.match ? 2 : 1 + (state.lords?.length ?? 0) });
    this.occupancy = new Int32Array(this.terrain.size * this.terrain.size);
    state.sites ??= [];
    state.jobs ??= [];
    // Partite rimaste senza abitanti: torna il seguito del signore
    if (state.population < MIN_POPULATION) state.population = MIN_POPULATION;
    for (const b of state.sites) this.mark(b, b.uid);
    for (const b of state.buildings) {
      this.mark(b, b.uid);
      const def = getBuilding(b.defId);
      if (def.hp && b.hp === undefined) b.hp = this.maxHp(b);
      b.upgrades ??= [];
    }
    const d = dateFromDays(state.day);
    this.lastSeasonIndex = seasonIndex(d.season);
    this.lastYear = d.year;
    if (state.lords?.length) this.syncLords(true);
  }

  // ───────────── Schieramento ─────────────

  /** Effetti dello schieramento scelto. */
  fx(): FactionEffects {
    return factionEffects(this.state.faction);
  }

  faction(): FactionDef | undefined {
    return this.state.faction ? FACTIONS[this.state.faction] : undefined;
  }

  private scaleCost(cost: Cost, mul: number): Cost {
    if (mul === 1) return cost;
    const out: Cost = {};
    for (const [id, n] of Object.entries(cost)) out[id as ResourceId] = Math.ceil((n ?? 0) * mul);
    return out;
  }

  /** Costo di un edificio per il nostro schieramento. */
  costOf(def: BuildingDef, extra = 0): Cost {
    const stoneFort = !!def.fort && def.fort !== 'moat' && (def.cost.stone ?? 0) > 0;
    const already = Math.max(0, this.count(def.id) + this.sites().filter((b) => b.defId === def.id).length + extra);
    return this.scaleCost(escalatedCost(def, already), stoneFort ? this.fx().stoneFortCost ?? 1 : 1);
  }

  /** Costo di un miglioramento per il nostro schieramento. */
  upgradeCostOf(u: UpgradeDef): Cost {
    return this.scaleCost(u.cost, u.id === 'great_hall' || u.id === 'palace' ? this.fx().hallCost ?? 1 : 1);
  }

  /** Costo di un'unità per il nostro schieramento. */
  unitCost(unit: UnitType): Cost {
    return this.scaleCost(UNITS[unit].cost, unit === 'cavalry' ? this.fx().cavalryCost ?? 1 : 1);
  }

  // ───────────── Eventi ─────────────


  private cueListeners = new Set<(c: SoundCue) => void>();

  /** Segnali sonori (corno d'allarme, fanfara, campana) per chi vuole farli sentire. */
  onCue(fn: (c: SoundCue) => void): () => void {
    this.cueListeners.add(fn);
    return () => this.cueListeners.delete(fn);
  }

  private cue(c: SoundCue) {
    for (const fn of this.cueListeners) fn(c);
  }

  onEvent(fn: (e: { text: string; kind: EventKind }) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }


  /** I nostri edifici sono cambiati: cambia l'aspetto e va rifatta l'analisi della cinta. */
  private changed() {
    this.structureVersion++;
    this.analysisVersion++;
    this.cache = null;
  }

  /** Da chiamare dopo aver modificato lo stato dall'esterno (test, strumenti). */
  invalidate() {
    this.changed();
  }

  /** Cambia solo ciò che si vede (cantieri, castelli degli altri): l'analisi resta valida. */
  private changedVisual() {
    this.structureVersion++;
  }

  log(text: string, kind: EventKind = 'info') {
    this.state.log.push({ day: this.state.day, text, kind });
    if (this.state.log.length > MAX_LOG) this.state.log.splice(0, this.state.log.length - MAX_LOG);
    for (const fn of this.eventListeners) fn({ text, kind });
  }

  // ───────────── Interrogazioni ─────────────

  get date(): GameDate {
    return dateFromDays(this.state.day);
  }

  defsPlaced(): Array<{ b: PlacedBuilding; def: BuildingDef }> {
    return this.state.buildings.map((b) => ({ b, def: getBuilding(b.defId) }));
  }

  byUid(uid: number): PlacedBuilding | undefined {
    return this.state.buildings.find((b) => b.uid === uid) ?? (uid >= FOREIGN ? this.others.find((b) => b.uid === uid) : undefined);
  }

  isForeign(b: PlacedBuilding): boolean {
    return b.uid >= FOREIGN;
  }

  /** Centro del proprio sito (dove inquadrare la telecamera). */
  homeSite(): [number, number] {
    return this.terrain.sites[this.state.match?.slot ?? 0] ?? [this.terrain.size / 2, this.terrain.size / 2];
  }


  /** Sostituisce gli edifici dell'altro giocatore (ricevuti dalla rete). */
  setOthers(list: PlacedBuilding[]) {
    for (const b of this.others) this.mark(b, 0);
    this.others = list.map((b) => ({ ...b, uid: FOREIGN + b.uid }));
    for (const b of this.others) {
      // Non sovrascrive i propri edifici (non dovrebbe succedere: territori separati)
      const [w, d] = getBuilding(b.defId).size;
      let free = true;
      for (let z = b.z; z < b.z + d && free; z++) for (let x = b.x; x < b.x + w && free; x++) {
        const k = this.tileIndex(x, z);
        if (this.occupancy[k] && this.occupancy[k] < FOREIGN) free = false;
      }
      if (free) this.mark(b, b.uid);
    }
    this.changedVisual();
  }

  buildingAt(x: number, z: number): PlacedBuilding | undefined {
    if (x < 0 || z < 0 || x >= this.terrain.size || z >= this.terrain.size) return undefined;
    const uid = this.occupancy[z * this.terrain.size + x];
    return uid ? this.byUid(uid) : undefined;
  }

  isMoat(x: number, z: number): boolean {
    return this.buildingAt(x, z)?.defId === 'moat';
  }

  count(defId: string): number {
    return this.state.buildings.filter((b) => b.defId === defId).length;
  }

  has(pred: (def: BuildingDef) => boolean): boolean {
    return this.state.buildings.some((b) => pred(getBuilding(b.defId)));
  }

  soldiers(): number {
    const a = this.state.army;
    return a.infantry + a.archers + a.cavalry;
  }

  towers(): number {
    return this.state.buildings.filter((b) => getBuilding(b.defId).fort === 'tower' && this.hpState(b) !== 'ruin').length;
  }

  storageCap(): number {
    return this.state.siege ? this.siegeStorage() : this.analysis().storage;
  }

  /** Giri di mura tra il bordo della mappa e un edificio. */
  depthOf(b: PlacedBuilding): number {
    const a = this.analysis();
    const [w, d] = getBuilding(b.defId).size;
    let best = 0;
    for (let z = b.z; z < b.z + d; z++) for (let x = b.x; x < b.x + w; x++) best = Math.max(best, a.depth[this.tileIndex(x, z)] % 255);
    return best;
  }

  /** Giri di mura attorno al mastio. */
  rings(): number {
    return this.analysis().rings;
  }

  /** Durante un assedio gli edifici fuori dalle mura rimaste in piedi sono tagliati fuori. */
  isCutOff(b: PlacedBuilding): boolean {
    const sg = this.state.siege;
    if (!sg) return false;
    const def = getBuilding(b.defId);
    if (def.fort) return false;
    return this.depthOf(b) <= sg.breached;
  }

  /** Magazzini utilizzabili durante l'assedio: solo quelli dentro le mura (mastio, granai interni). */
  siegeStorage(): number {
    let cap = BASE_STORAGE * 0.5 + CASTLE_LEVELS[this.castleLevel()].storage;
    for (const b of this.state.buildings) {
      const def = getBuilding(b.defId);
      if (!def.storage || this.isCutOff(b)) continue;
      cap += Math.round(def.storage * levelEffects(b.level ?? 1).storage);
    }
    return Math.round(cap);
  }

  armyPower(): number {
    const towerMul = 1 + Math.min(2, this.towers() * (UNITS.archers.towerBonus ?? 0));
    const armory = this.state.buildings.some((b) => b.upgrades?.includes('armory')) ? 1.2 : 1;
    let p = 0;
    for (const id of Object.keys(UNITS) as UnitType[]) {
      const u = UNITS[id];
      const mul = id === 'archers' ? towerMul : 1;
      p += this.state.army[id] * (u.defense * mul + u.attack * 0.5);
    }
    return p * armory;
  }

  summary(): Summary {
    const date = this.date;
    const a = this.analysis();
    const pop = this.state.population;
    return {
      date,
      eraName: eraForYear(date.year).name,
      population: pop,
      housing: a.housing,
      jobs: a.jobs,
      staffing: a.jobs > 0 ? Math.min(1, pop / a.jobs) : 1,
      soldiers: this.soldiers(),
      storage: a.storage,
      foodPerDay: pop * FOOD_PER_PERSON + this.soldiers() * SOLDIER_FOOD,
      defense: this.fortDefense(),
      armyPower: this.armyPower(),
      hasMarket: this.has((d) => !!d.market),
      closed: a.closed,
    };
  }


  // ───────────── Analisi della cinta, dei fossati e delle strade ─────────────

  private tileIndex(x: number, z: number) {
    return z * this.terrain.size + x;
  }

  /** Blocca il passaggio degli assalitori: mura, torri, porte, mastio (non in rovina) e acqua senza ponte. */
  private blocks(x: number, z: number): boolean {
    const b = this.buildingAt(x, z);
    // Le mura degli altri non c'entrano con la nostra cinta (e cambiano spesso: si ignorano)
    if (b && this.isForeign(b)) return isWater(tileAt(this.terrain, x, z));
    if (b) {
      const def = getBuilding(b.defId);
      if (def.fort && def.fort !== 'moat') return this.hpState(b) !== 'ruin';
      if (def.id === 'bridge') return false;
    }
    return isWater(tileAt(this.terrain, x, z));
  }

  analysis(): Analysis {
    if (this.cache && this.cache.version === this.analysisVersion) return this.cache;
    const size = this.terrain.size;
    let housing = BASE_HOUSING;
    let jobs = 0;
    let storage = BASE_STORAGE;
    let taxMul = 1;
    for (const { b, def } of this.defsPlaced()) {
      const le = levelEffects(b.level ?? 1);
      housing += Math.round((def.housing ?? 0) * le.housing);
      jobs += Math.round(def.workers * le.workers);
      storage += Math.round((def.storage ?? 0) * le.storage);
      taxMul += def.taxBonus ?? 0;
    }
    const lv = CASTLE_LEVELS[this.castleLevel()];
    housing += lv.housing;
    storage += lv.storage;
    taxMul += lv.tax;

    // Profondità: quanti giri di mura separano ogni casella dal bordo della mappa (BFS 0-1).
    // Entrare in un muro da terreno libero costa 1; muro→muro (mura spesse, porte) e muro→libero costano 0.
    // Due conti: la struttura delle cinte (anche le mura in rovina contano come giro, finché non
    // vengono conquistate in un assalto) e lo stato attuale (una breccia apre la cinta).
    const wall = new Uint8Array(size * size);
    const live = new Uint8Array(size * size);
    for (let z = 0; z < size; z++) {
      for (let x = 0; x < size; x++) {
        const k = z * size + x;
        if (this.blocks(x, z)) live[k] = wall[k] = 1;
        else {
          const b = this.buildingAt(x, z);
          const f = b && !this.isForeign(b) ? getBuilding(b.defId).fort : undefined;
          if (f && f !== 'moat') wall[k] = 1;
        }
      }
    }
    const depth = depthFromEdges(wall, size);
    const liveDepth = depthFromEdges(live, size);
    const outside = new Uint8Array(size * size);
    for (let k = 0; k < size * size; k++) if (liveDepth[k] === 0) outside[k] = 1;
    // Giri di mura attorno al mastio: la massima profondità del terreno libero che lo circonda
    let rings = 0;
    let liveRings = 0;
    for (const b of this.state.buildings) {
      const def = getBuilding(b.defId);
      if (def.fort !== 'keep' || this.hpState(b) === 'ruin') continue;
      const [w, d] = def.size;
      for (let z = b.z - 1; z <= b.z + d; z++) {
        for (let x = b.x - 1; x <= b.x + w; x++) {
          if (x < 0 || z < 0 || x >= size || z >= size) continue;
          if (x >= b.x && x < b.x + w && z >= b.z && z < b.z + d) continue;
          const k = this.tileIndex(x, z);
          if (!wall[k] && depth[k] !== 255) rings = Math.max(rings, depth[k]);
          if (!live[k] && liveDepth[k] !== 255) liveRings = Math.max(liveRings, liveDepth[k]);
        }
      }
    }
    // Chiusa davvero solo se non ci sono brecce aperte
    const closed = liveRings > 0;

    // Fossati allagati: componenti connesse che toccano fiume o mare, o con l'allagamento
    const flooded = new Set<number>();
    const seen = new Set<number>();
    for (const b of this.state.buildings) {
      if (b.defId !== 'moat' || seen.has(b.uid)) continue;
      const comp: PlacedBuilding[] = [];
      const stack = [b];
      seen.add(b.uid);
      let wet = false;
      while (stack.length) {
        const m = stack.pop()!;
        comp.push(m);
        if (m.upgrades?.includes('flood')) wet = true;
        for (const [dx, dz] of D8) {
          const t = tileAt(this.terrain, m.x + dx, m.z + dz);
          if (Math.abs(dx) + Math.abs(dz) === 1 && isWater(t)) wet = true;
          const n = this.buildingAt(m.x + dx, m.z + dz);
          if (n && n.defId === 'moat' && !seen.has(n.uid)) {
            seen.add(n.uid);
            stack.push(n);
          }
        }
      }
      if (wet) for (const m of comp) flooded.add(m.uid);
    }

    // Rete stradale: dal mastio e dal mercato attraverso strade, ponti e porte
    const node = (x: number, z: number) => {
      const b = this.buildingAt(x, z);
      if (!b) return null;
      const def = getBuilding(b.defId);
      if (def.road || def.fort === 'gate') return def;
      // Il fossato davanti a una porta col ponte levatoio vale come strada: il ponte lo attraversa
      if (def.fort === 'moat') {
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const g = this.buildingAt(x + dx, z + dz);
          if (g && getBuilding(g.defId).fort === 'gate' && g.upgrades?.includes('drawbridge')) return def;
        }
      }
      return null;
    };
    const reached = new Map<number, number>(); // casella → bonus (1.15 sterrata, 1.25 lastricata)
    const rq: number[] = [];
    for (const b of this.state.buildings) {
      const def = getBuilding(b.defId);
      if (def.fort !== 'keep' && !def.market) continue;
      const [w, d] = def.size;
      for (let z = b.z - 1; z <= b.z + d; z++) {
        for (let x = b.x - 1; x <= b.x + w; x++) {
          const n = node(x, z);
          if (n && !reached.has(this.tileIndex(x, z))) {
            reached.set(this.tileIndex(x, z), n.id === 'road_paved' ? 1.25 : 1.15);
            rq.push(this.tileIndex(x, z));
          }
        }
      }
    }
    while (rq.length) {
      const k = rq.pop()!;
      const x = k % size;
      const z = (k - x) / size;
      for (const [dx, dz] of D8) {
        const nx = x + dx;
        const nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= size || nz >= size) continue;
        const kk = this.tileIndex(nx, nz);
        const n = node(nx, nz);
        if (!n || reached.has(kk)) continue;
        reached.set(kk, n.id === 'road_paved' ? 1.25 : 1.15);
        rq.push(kk);
      }
    }
    const connected = new Map<number, number>();
    for (const b of this.state.buildings) {
      const def = getBuilding(b.defId);
      if (def.road || def.fort) continue;
      const [w, d] = def.size;
      let best = 0;
      if (def.market) best = 1.15;
      for (let z = b.z - 1; z <= b.z + d; z++) {
        for (let x = b.x - 1; x <= b.x + w; x++) {
          if (x < 0 || z < 0 || x >= size || z >= size) continue;
          best = Math.max(best, reached.get(this.tileIndex(x, z)) ?? 0);
          const n = this.buildingAt(x, z);
          if (n && getBuilding(n.defId).fort === 'keep') best = Math.max(best, 1.15);
        }
      }
      if (best > 0) connected.set(b.uid, best);
    }

    this.cache = { version: this.analysisVersion, closed, outside, depth, rings, flooded, connected, housing, jobs, storage, taxMul };
    return this.cache;
  }

  /** Moltiplicatore di produzione dovuto alla rete stradale (1 se non collegato). */
  roadBonus(b: PlacedBuilding): number {
    return this.analysis().connected.get(b.uid) ?? 1;
  }

  isConnected(b: PlacedBuilding): boolean {
    return this.analysis().connected.has(b.uid);
  }

  isInside(x: number, z: number): boolean {
    return !this.analysis().outside[this.tileIndex(x, z)];
  }

  moatFlooded(b: PlacedBuilding): boolean {
    if (this.fx().floodedMoats && !this.isForeign(b) && b.defId === 'moat') return true;
    return this.analysis().flooded.has(b.uid);
  }

  moatDepth(b: PlacedBuilding): number {
    return 1 + (b.upgrades?.includes('deep1') ? 1 : 0) + (b.upgrades?.includes('deep2') ? 1 : 0);
  }

  // ───────────── Punti vita e miglioramenti ─────────────

  maxHp(b: PlacedBuilding): number {
    const def = getBuilding(b.defId);
    if (!def.hp) return 0;
    let hp = def.hp;
    for (const u of b.upgrades ?? []) hp *= UPGRADE_BY_ID[u]?.hpMul ?? 1;
    // Lo schieramento conta solo per i nostri edifici
    if (!this.isForeign(b) && def.fort && def.fort !== 'keep' && def.fort !== 'moat') hp *= this.fx().fortHp ?? 1;
    return Math.round(hp);
  }

  hpState(b: PlacedBuilding): HpState {
    const max = this.maxHp(b);
    if (!max) return 'ok';
    const hp = b.hp ?? max;
    if (hp <= 0) return 'ruin';
    return hp < max * 0.5 ? 'damaged' : 'ok';
  }

  /** Difesa statica di una fortificazione (per l'interfaccia). */
  defenseOf(b: PlacedBuilding): number {
    const def = getBuilding(b.defId);
    if (!def.fort) return 0;
    let d = def.defense ?? 0;
    for (const u of b.upgrades ?? []) d += UPGRADE_BY_ID[u]?.defense ?? 0;
    if (def.fort === 'moat') return d * (this.moatFlooded(b) ? 1.6 : 1);
    const max = this.maxHp(b);
    const health = max ? Math.max(0, b.hp ?? max) / max : 1;
    const closedMul = def.fort === 'keep' || this.analysis().closed ? 1 : 0.5;
    return d * health * closedMul;
  }

  defenseBreakdown(): DefenseBreakdown {
    const out: DefenseBreakdown = { walls: 0, towers: 0, gates: 0, moats: 0, keep: 0, army: this.armyPower(), total: 0, closed: this.analysis().closed, damaged: 0, ruined: 0 };
    for (const b of this.state.buildings) {
      const def = getBuilding(b.defId);
      if (!def.fort) continue;
      const v = this.defenseOf(b);
      const key = ({ wall: 'walls', tower: 'towers', gate: 'gates', moat: 'moats', keep: 'keep' } as const)[def.fort];
      out[key] += v;
      const st = this.hpState(b);
      if (st === 'damaged') out.damaged++;
      if (st === 'ruin') out.ruined++;
    }
    out.total = out.walls + out.towers + out.gates + out.moats + out.keep;
    return out;
  }

  fortDefense(): number {
    return this.defenseBreakdown().total;
  }

  upgradeOptions(b: PlacedBuilding): UpgradeDef[] {
    return upgradesFor(b.defId);
  }

  canUpgrade(b: PlacedBuilding, upId: string): PlaceCheck {
    if (this.isForeign(b)) return { ok: false, reason: 'Appartiene all\'altro giocatore' };
    if (this.locked) return { ok: false, reason: 'In attesa dell\'altro giocatore' };
    const u = UPGRADE_BY_ID[upId];
    if (!u || !u.appliesTo.includes(b.defId)) return { ok: false, reason: 'Non applicabile' };
    if (b.upgrades?.includes(upId)) return { ok: false, reason: 'Già costruito' };
    const pending = this.jobFor(b.uid);
    if (pending) return { ok: false, reason: pending.upId === upId ? 'In costruzione' : 'Lavori già in corso' };
    if (this.date.year < u.minYear) return { ok: false, reason: `Disponibile dal ${u.minYear}` };
    const built = getBuilding(b.defId).builtIn ?? [];
    if (built.includes(upId)) return { ok: false, reason: 'Già compreso' };
    if (u.requires && !b.upgrades?.includes(u.requires) && !built.includes(u.requires)) {
      return { ok: false, reason: `Richiede: ${UPGRADE_BY_ID[u.requires].name}` };
    }
    if (u.needsMoat && !this.gateHasMoat(b)) return { ok: false, reason: 'Serve un fossato davanti alla porta' };
    if (u.minPop && this.state.population < u.minPop) return { ok: false, reason: `Servono ${u.minPop} abitanti` };
    if (this.hpState(b) === 'ruin') return { ok: false, reason: 'Prima va riparato' };
    if (!canAfford(this.state.resources, this.upgradeCostOf(u))) return { ok: false, reason: 'Risorse insufficienti' };
    return { ok: true };
  }

  upgrade(b: PlacedBuilding, upId: string): boolean {
    return this.track('Miglioramenti', () => this.upgradeImpl(b, upId), 'event');
  }

  private upgradeImpl(b: PlacedBuilding, upId: string): boolean {
    if (!this.startUpgrade(b, upId)) return false;
    this.changed();
    return true;
  }

  /** Paga il miglioramento e lo mette in coda ai costruttori (o lo applica subito). */
  private startUpgrade(b: PlacedBuilding, upId: string): boolean {
    if (!this.canUpgrade(b, upId).ok) return false;
    const u = UPGRADE_BY_ID[upId];
    const cost = this.upgradeCostOf(u);
    pay(this.state.resources, cost);
    if (this.instantBuild) this.applyUpgrade(b, upId);
    else this.jobs().push({ id: this.newJobId(), kind: 'upgrade', uid: b.uid, upId, work: Game.workFor(u.cost), done: 0, cost: { ...cost } });
    return true;
  }

  private applyUpgrade(b: PlacedBuilding, upId: string) {
    if (b.upgrades?.includes(upId)) return;
    if (['bailey', 'great_hall', 'palace'].includes(upId)) {
      const next = { bailey: 2, great_hall: 4, palace: 5 }[upId as 'bailey'];
      this.log(`Il castello sale al livello ${next}: ${CASTLE_LEVELS[next].name}!`, 'good');
    }
    const before = this.maxHp(b);
    b.upgrades = [...(b.upgrades ?? []), upId];
    // I punti vita in più si aggiungono a quelli attuali
    if (before) b.hp = (b.hp ?? before) + (this.maxHp(b) - before);
  }

  /** Applica il miglioramento a tutti gli edifici dello stesso tipo, finché bastano le risorse. */
  upgradeAll(defId: string, upId: string): number {
    return this.track('Miglioramenti', () => this.upgradeAllImpl(defId, upId), 'event');
  }

  private upgradeAllImpl(defId: string, upId: string): number {
    let n = 0;
    for (const b of this.state.buildings) {
      if (b.defId !== defId || !this.canUpgrade(b, upId).ok) continue;
      if (this.startUpgrade(b, upId)) n++;
    }
    if (n) this.changed();
    return n;
  }

  gateHasMoat(b: PlacedBuilding): boolean {
    const [w, d] = getBuilding(b.defId).size;
    for (let z = b.z - 1; z <= b.z + d; z++) {
      for (let x = b.x - 1; x <= b.x + w; x++) {
        const inX = x >= b.x && x < b.x + w;
        const inZ = z >= b.z && z < b.z + d;
        if (inX === inZ) continue; // solo i lati, non gli angoli né l'interno
        if (this.isMoat(x, z)) return true;
      }
    }
    return false;
  }

  repairCost(b: PlacedBuilding): Cost {
    const max = this.maxHp(b);
    if (!max) return {};
    const missing = Math.max(0, max - (b.hp ?? max)) / max;
    if (missing <= 0) return {};
    const cost: Cost = {};
    for (const [id, n] of Object.entries(getBuilding(b.defId).cost)) {
      // Di una rovina restano le pietre: si ricostruisce con meno materiali
      cost[id as ResourceId] = Math.ceil((n ?? 0) * (this.hpState(b) === 'ruin' ? 0.4 : 0.6) * missing);
    }
    return cost;
  }

  repair(b: PlacedBuilding): boolean {
    return this.track('Riparazioni', () => this.repairImpl(b), 'event');
  }

  private repairImpl(b: PlacedBuilding): boolean {
    if (this.isForeign(b) || this.locked) return false;
    const cost = this.repairCost(b);
    if (!Object.keys(cost).length || !canAfford(this.state.resources, cost)) return false;
    const was = this.hpState(b);
    pay(this.state.resources, cost);
    b.hp = this.maxHp(b);
    if (was !== 'ok') this.changed();
    return true;
  }

  repairAll(): number {
    return this.track('Riparazioni', () => this.repairAllImpl(), 'event');
  }

  private repairAllImpl(): number {
    if (this.locked) return 0;
    let n = 0;
    let visual = false;
    for (const b of this.state.buildings) {
      const cost = this.repairCost(b);
      if (!Object.keys(cost).length || !canAfford(this.state.resources, cost)) continue;
      if (this.hpState(b) !== 'ok') visual = true;
      pay(this.state.resources, cost);
      b.hp = this.maxHp(b);
      n++;
    }
    if (visual) this.changed();
    return n;
  }

  // ───────────── Costruzione ─────────────

  canPlace(defId: string, x: number, z: number): PlaceCheck {
    const def = getBuilding(defId);
    if (!isAvailable(def, this.date.year)) {
      return { ok: false, reason: `Disponibile dal ${def.minYear}` };
    }
    if (this.locked) return { ok: false, reason: 'In attesa dell\'altro giocatore' };
    if (def.minLevel && this.castleLevel() < def.minLevel) {
      return { ok: false, reason: `Richiede il castello al livello ${def.minLevel} (${CASTLE_LEVELS[def.minLevel].name})` };
    }
    if (def.unique && this.count(def.id) + this.sites().filter((b) => b.defId === def.id).length > 0) return { ok: false, reason: 'Ne puoi avere uno solo' };
    if (def.fort === 'keep' && [...this.state.buildings, ...this.sites()].some((b) => getBuilding(b.defId).fort === 'keep')) {
      return { ok: false, reason: 'Hai già un castello: fallo evolvere' };
    }
    const [w, d] = def.size;
    for (let dz = 0; dz < d; dz++) for (let dx = 0; dx < w; dx++) {
      if (!this.ownsTile(x + dx, z + dz)) return { ok: false, reason: 'Fuori dal tuo territorio' };
    }
    const t = this.terrainCheck(def, x, z);
    if (!t.ok) return t;
    if (!canAfford(this.state.resources, this.costOf(def))) return { ok: false, reason: 'Risorse insufficienti' };
    return { ok: true };
  }

  /** Regole del terreno e caselle libere (senza territorio, epoca né costi). */
  private terrainCheck(def: BuildingDef, x: number, z: number): PlaceCheck {
    const [w, d] = def.size;
    let rock = 0;
    let gold = 0;
    let river = 0;
    for (let dz = 0; dz < d; dz++) {
      for (let dx = 0; dx < w; dx++) {
        const t = tileAt(this.terrain, x + dx, z + dz);
        if (t === undefined) return { ok: false, reason: 'Fuori dalla mappa' };
        if (this.occupancy[(z + dz) * this.terrain.size + x + dx]) return { ok: false, reason: 'Spazio occupato' };
        if (t === Tile.River) river++;
        if (def.placement === 'river') continue;
        if (isWater(t)) return { ok: false, reason: 'Non si costruisce sull\'acqua' };
        if (t === Tile.Rock) rock++;
        if (t === Tile.Gold) gold++;
        if (def.placement !== 'rock' && def.placement !== 'goldVein' && !isBuildableLand(t)) {
          return { ok: false, reason: t === Tile.Forest ? 'C\'è il bosco' : 'Terreno roccioso' };
        }
      }
    }
    const area = w * d;
    if (def.placement === 'river' && river < area) return { ok: false, reason: 'Il ponte va costruito sul fiume' };
    if (def.placement === 'rock' && rock + gold < area) return { ok: false, reason: 'Va costruita sulla roccia' };
    if (def.placement === 'goldVein' && gold === 0) return { ok: false, reason: 'Serve una vena d\'oro' };
    if (def.placement === 'goldVein' && rock + gold < area) return { ok: false, reason: 'Va costruita sulla roccia' };
    if (def.placement === 'nearForest' && !this.near(x, z, w, d, 2, (t) => t === Tile.Forest)) {
      return { ok: false, reason: 'Serve un bosco vicino' };
    }
    if (def.placement === 'nearWater' && !this.near(x, z, w, d, 1, (t) => isWater(t))) {
      return { ok: false, reason: 'Serve acqua vicino (fiume o mare)' };
    }
    return { ok: true };
  }

  private near(x: number, z: number, w: number, d: number, r: number, pred: (t: Tile | undefined) => boolean) {
    for (let zz = z - r; zz < z + d + r; zz++) {
      for (let xx = x - r; xx < x + w + r; xx++) {
        if (pred(tileAt(this.terrain, xx, zz))) return true;
      }
    }
    return false;
  }

  private placeQuiet(defId: string, x: number, z: number): PlacedBuilding | null {
    if (!this.canPlace(defId, x, z).ok) return null;
    const def = getBuilding(defId);
    const cost = this.costOf(def);
    pay(this.state.resources, cost);
    const b: PlacedBuilding = { uid: this.state.nextUid++, defId, x, z, upgrades: [] };
    if (def.herd) b.herd = def.herd.start;
    if (def.hp) b.hp = def.hp;
    this.mark(b, b.uid);
    if (this.instantBuild) this.state.buildings.push(b);
    else {
      this.sites().push(b);
      this.jobs().push({ id: this.newJobId(), kind: 'build', uid: b.uid, work: this.buildWork(def), done: 0, cost: { ...cost } });
    }
    return b;
  }

  place(defId: string, x: number, z: number): PlacedBuilding | null {
    return this.track('Costruzioni', () => this.placeImpl(defId, x, z), 'event');
  }

  private placeImpl(defId: string, x: number, z: number): PlacedBuilding | null {
    const b = this.placeQuiet(defId, x, z);
    if (b) this.changed();
    return b;
  }

  /** Costruisce lungo una fila di caselle (mura, fossati, strade). */
  placeLine(defId: string, tiles: Array<[number, number]>): { placed: number; reason?: string } {
    return this.track('Costruzioni', () => this.placeLineImpl(defId, tiles), 'event');
  }

  private placeLineImpl(defId: string, tiles: Array<[number, number]>): { placed: number; reason?: string } {
    let placed = 0;
    let reason: string | undefined;
    for (const [x, z] of tiles) {
      const check = this.canPlace(defId, x, z);
      if (!check.ok) {
        if (check.reason === 'Risorse insufficienti') {
          reason = check.reason;
          break;
        }
        if (check.reason !== 'Spazio occupato') reason ??= check.reason;
        continue;
      }
      if (this.placeQuiet(defId, x, z)) placed++;
    }
    if (placed) this.changed();
    return { placed, reason };
  }

  demolish(uid: number): boolean {
    return this.track('Demolizioni (rimborso)', () => this.demolishImpl(uid), 'event');
  }

  private demolishImpl(uid: number): boolean {
    if (this.locked) return false;
    const pending = this.jobFor(uid);
    if (pending && pending.kind === 'build') return this.cancelJobImpl(pending.id);
    if (pending) this.cancelJobImpl(pending.id);
    const i = this.state.buildings.findIndex((b) => b.uid === uid);
    if (i < 0) return false;
    const b = this.state.buildings[i];
    const def = getBuilding(b.defId);
    // Metà di quanto era costato (senza contare l'edificio stesso nella maggiorazione)
    for (const [id, n] of Object.entries(this.costOf(def, -1))) {
      this.state.resources[id as ResourceId] += Math.floor((n ?? 0) * 0.5);
    }
    if (def.herd && b.herd) this.slaughter(def.herd.species, Math.floor(b.herd));
    if (b.garrison) {
      this.state.army.infantry += b.garrison.infantry;
      this.state.army.archers += b.garrison.archers;
    }
    this.mark(b, 0);
    this.state.buildings.splice(i, 1);
    this.changed();
    return true;
  }

  private mark(b: PlacedBuilding, value: number) {
    const [w, d] = getBuilding(b.defId).size;
    for (let dz = 0; dz < d; dz++) {
      for (let dx = 0; dx < w; dx++) this.occupancy[(b.z + dz) * this.terrain.size + b.x + dx] = value;
    }
  }

  // ───────────── Esercito ─────────────

  canRecruit(unit: UnitType): PlaceCheck {
    if (this.locked) return { ok: false, reason: 'In attesa dell\'altro giocatore' };
    if (!this.has((d) => d.trains === unit)) return { ok: false, reason: 'Serve l\'edificio di addestramento' };
    if (this.state.population < 2) return { ok: false, reason: 'Non ci sono abbastanza abitanti' };
    if (!canAfford(this.state.resources, this.unitCost(unit))) return { ok: false, reason: 'Risorse insufficienti' };
    return { ok: true };
  }

  recruit(unit: UnitType, n = 1): number {
    return this.track('Reclutamento', () => this.recruitImpl(unit, n), 'event');
  }

  private recruitImpl(unit: UnitType, n: number): number {
    let done = 0;
    for (let i = 0; i < n && this.canRecruit(unit).ok; i++) {
      pay(this.state.resources, this.unitCost(unit));
      this.state.population -= 1;
      this.state.army[unit] += 1;
      done++;
    }
    return done;
  }

  dismiss(unit: UnitType, n = 1): number {
    const done = Math.min(n, this.state.army[unit]);
    this.state.army[unit] -= done;
    this.state.population += done;
    return done;
  }

  // ───────────── Mercato ─────────────

  price(id: ResourceId): number {
    const base = RESOURCES[id].basePrice;
    if (!RESOURCES[id].food && id !== 'hay') return base;
    const curve = [1.15, 0.9, 0.8, 1.4];
    return base * curve[seasonIndex(this.date.season)];
  }

  buyPrice(id: ResourceId): number {
    // I materiali da costruzione al mercato costano cari: non devono sostituire cave e boschi
    const scarce = id === 'wood' || id === 'stone' || id === 'lime' || id === 'gold' ? 1.6 : 1.25;
    return Math.ceil(this.price(id) * scarce * (this.fx().buy ?? 1) * 10) / 10;
  }

  sellPrice(id: ResourceId): number {
    return Math.floor(this.price(id) * 0.8 * (this.fx().sell ?? 1) * 10) / 10;
  }

  trade(id: ResourceId, amount: number): PlaceCheck {
    return this.track('Mercato', () => this.tradeImpl(id, amount), 'event');
  }

  private tradeImpl(id: ResourceId, amount: number): PlaceCheck {
    if (id === 'coins') return { ok: false, reason: 'Non si commerciano monete' };
    if (this.locked) return { ok: false, reason: 'In attesa dell\'altro giocatore' };
    if (!this.summary().hasMarket) return { ok: false, reason: 'Serve un mercato' };
    const r = this.state.resources;
    if (amount > 0) {
      const cost = this.buyPrice(id) * amount;
      if (r.coins < cost) return { ok: false, reason: 'Monete insufficienti' };
      if (r[id] + amount > this.storageCap()) return { ok: false, reason: 'Magazzini pieni' };
      r.coins -= cost;
      r[id] += amount;
    } else {
      const n = -amount;
      if (r[id] < n) return { ok: false, reason: 'Merce insufficiente' };
      r[id] -= n;
      r.coins += this.sellPrice(id) * n;
    }
    return { ok: true };
  }

  /** Riceve una carovana da un altro giocatore. */
  receive(goods: Cost, from: string): void {
    return this.track('Carovane ricevute', () => this.receiveImpl(goods, from), 'event');
  }

  private receiveImpl(goods: Cost, from: string): void {
    const cap = this.storageCap();
    for (const [id, n] of Object.entries(goods)) {
      const rid = id as ResourceId;
      if (!RESOURCE_IDS.includes(rid) || !n || n <= 0) continue;
      this.state.resources[rid] = rid === 'coins' ? this.state.resources[rid] + n : Math.min(cap, this.state.resources[rid] + n);
    }
    this.log(`Carovana ricevuta da ${from}.`, 'good');
  }

  // ───────────── Simulazione ─────────────

  /** Avanza la simulazione di `days` giorni (può essere frazionario). */
  advance(days: number) {
    let left = days;
    while (left > 1e-9) {
      const dt = Math.min(0.25, left);
      this.step(dt);
      left -= dt;
    }
  }

  private lastGoalDay = -1;

  // ───────────── Dinastia ─────────────

  dynasty(): Dynasty {
    return (this.state.dynasty ??= { ruler: { name: COMMANDER_NAMES[this.state.seed % COMMANDER_NAMES.length], born: this.state.day - 27 * DAYS_PER_YEAR } });
  }

  ageOf(born: number): number {
    return Math.floor((this.state.day - born) / DAYS_PER_YEAR);
  }

  /** Le nozze con la casata di un signore: un alleato naturale, e più probabilità di avere eredi. */
  private marryInto(l: Lord) {
    this.dynasty().spouse = l.id;
    l.relation = Math.max(l.relation, 55);
    this.log(`💍 Il signore ${this.dynasty().ruler.name} sposa una dama di ${l.castle}: casate legate.`, 'good');
  }

  /** Eventi di casata, una volta l'anno: nascite, morte del signore e successione. */
  private stepDynasty() {
    const d = this.dynasty();
    const s = this.state;
    if (this.state.match) return;
    const age = this.ageOf(d.ruler.born);
    if (!d.heir && age >= 20 && age <= 50 && this.random() < (d.spouse !== undefined ? 0.5 : 0.25)) {
      d.heir = { name: COMMANDER_NAMES[Math.floor(this.random() * COMMANDER_NAMES.length)], born: s.day };
      this.log(`👶 Nasce ${d.heir.name}, erede del signore ${d.ruler.name}${d.spouse !== undefined ? ` e nipote del signore di ${this.lord(d.spouse)?.castle ?? 'un castello alleato'}` : ''}.`, 'good');
    }
    if (age < 52 || this.random() >= (age - 50) * 0.05) return;
    // Il signore muore
    const old = d.ruler.name;
    if (d.heir && this.ageOf(d.heir.born) >= 16) {
      d.ruler = d.heir;
      delete d.heir;
      this.log(`👑 Muore il signore ${old}. Sale al trono ${d.ruler.name}: la successione è serena.`, 'info');
    } else if (d.heir) {
      d.regencyUntil = s.day + (16 - this.ageOf(d.heir.born)) * DAYS_PER_YEAR;
      this.log(`👑 Muore il signore ${old}: l'erede ${d.heir.name} è ancora un bambino e governa un reggente. Il popolo è inquieto.`, 'bad');
      d.ruler = { name: d.heir.name, born: d.heir.born };
      delete d.heir;
    } else {
      s.happiness = Math.max(0, this.happiness() - 18);
      d.ruler = { name: COMMANDER_NAMES[Math.floor(this.random() * COMMANDER_NAMES.length)], born: s.day - 30 * DAYS_PER_YEAR };
      const ally = d.spouse !== undefined ? this.lord(d.spouse) : undefined;
      if (ally && ally.status !== 'war') {
        ally.relation = Math.min(100, ally.relation + 10);
        this.track('Dote e aiuti', () => (s.resources.coins += 150), 'event');
        this.log(`👑 Muore il signore ${old} senza figli. I parenti di ${ally.castle} sostengono la successione di ${d.ruler.name} (+150 monete).`, 'bad');
      } else {
        const rival = this.lords().find((l) => l.status !== 'vassal' && l.relation < 25);
        this.log(`👑 Muore il signore ${old} senza figli: crisi di successione, il popolo è scosso.${rival ? ` ${rival.name} avanza pretese sul castello!` : ''}`, 'bad');
        if (rival) {
          rival.relation -= 30;
          this.remember(rival, 'Pretendeva il nostro castello', -8);
          if (rival.personality === 'aggressive') this.declareWar(rival, 'Rivendica la successione');
        }
      }
    }
  }

  /** Eventi stagionali in corso. */
  activeEvents(): ActiveEvent[] {
    return (this.state.events ?? []).filter((e) => e.until > this.state.day);
  }

  private hasEvent(id: SeasonEventId): boolean {
    return this.activeEvents().some((e) => e.id === id);
  }

  /** Moltiplicatore della resa di campi e pascoli dovuto agli eventi. */
  private evDay = -1;
  private evFactor = 1;
  private farmEventFactor(): number {
    const d = Math.floor(this.state.day);
    if (d !== this.evDay) {
      this.evDay = d;
      this.evFactor = (this.hasEvent('poor_harvest') ? 0.55 : 1) * (this.hasEvent('bumper') ? 1.4 : 1) * (this.hasEvent('flood') ? 0.7 : 1);
    }
    return this.evFactor;
  }

  /** Ogni tanto una stagione porta un fatto fuori dall'ordinario: la prudenza (scorte, varietà) lo attutisce. */
  private stepEvents(si: number) {
    const s = this.state;
    if (s.events) s.events = s.events.filter((e) => e.until > s.day);
    if (s.nextEventDay === undefined) s.nextEventDay = s.day + 120 + this.random() * 120;
    if (s.day < s.nextEventDay || this.state.siege) return;
    s.nextEventDay = s.day + 140 + this.random() * 200;
    const pool: SeasonEventId[][] = [
      ['flood', 'merchants', 'merchants'],
      ['plague', 'poor_harvest', 'merchants'],
      ['bumper', 'poor_harvest', 'bumper', 'merchants'],
      ['harsh_winter', 'harsh_winter', 'merchants'],
    ];
    const id = pool[si][Math.floor(this.random() * pool[si].length)];
    const r = this.state.resources;
    const push = (text: string, days: number) => (s.events ??= []).push({ id, until: s.day + days, text });
    if (id === 'poor_harvest') {
      push('Raccolto scarso', 120);
      this.log('🥀 Un raccolto scarso: campi e pascoli rendono molto meno per qualche mese. Le scorte nei granai ti salvano.', 'bad');
    } else if (id === 'bumper') {
      push('Raccolto eccezionale', 100);
      this.log('🌾 Un raccolto eccezionale: i campi rendono di più per qualche mese. Riempi i granai!', 'good');
    } else if (id === 'flood') {
      push('Alluvione', 40);
      this.track('Alluvione', () => {
        r.hay *= 0.75;
        r.vegetables *= 0.8;
      }, 'event');
      this.log('🌊 Una piena ha allagato i campi: scorte di fieno e ortaggi perse e raccolti ridotti per un mese.', 'bad');
    } else if (id === 'plague') {
      push('Epidemia', 60);
      const loss = this.state.population * (this.happiness() > 60 ? 0.04 : 0.09);
      this.state.population = Math.max(6, this.state.population - loss);
      this.state.happiness = Math.max(0, this.happiness() - 8);
      this.log(`☠️ Un'epidemia: ${Math.round(loss)} abitanti morti e popolo scosso. Una popolazione contenta regge meglio.`, 'bad');
    } else if (id === 'harsh_winter') {
      push('Inverno rigido', 90);
      this.log('❄️ Un inverno rigido: la gente mangia di più. Tieni le scorte.', 'bad');
    } else {
      const gain = this.track('Mercanti di passaggio', () => {
        let c = 0;
        for (const rid of ['cloth', 'bread', 'weapons', 'cheese', 'iron'] as const) {
          const n = Math.floor(r[rid] * 0.3);
          if (n < 1) continue;
          r[rid] -= n;
          c += n * RESOURCES[rid].basePrice * 1.5;
        }
        r.coins += c;
        return c;
      }, 'event');
      this.log(gain > 0 ? `🐪 Una carovana di mercanti compra le tue merci pregiate a prezzo alto: +${Math.round(gain)} monete.` : '🐪 Una carovana di mercanti passa dal castello, ma non hai merci pregiate da vendere (tessuto, pane, armi, formaggio, ferro).', gain > 0 ? 'good' : 'info');
    }
  }

  /** Obiettivi visibili ora: quelli dell'epoca in corso e gli arretrati. */
  goals(): Array<{ goal: Goal; have: number; done: boolean }> {
    const era = eraIndexOf(dateFromDays(this.state.day).year);
    const done = new Set(this.state.goalsDone ?? []);
    return GOALS.filter((g) => g.era <= era).map((goal) => ({ goal, have: Math.min(goal.need, goal.have(this)), done: done.has(goal.id) }));
  }

  private checkGoals(era: number) {
    const done = (this.state.goalsDone ??= []);
    for (const goal of GOALS) {
      if (goal.era > era || done.includes(goal.id) || goal.have(this) < goal.need) continue;
      done.push(goal.id);
      this.track('Obiettivi raggiunti', () => {
        for (const [id, n] of Object.entries(goal.reward)) this.state.resources[id as ResourceId] += n ?? 0;
      }, 'event');
      this.cue('bell');
      this.log(`🎯 Obiettivo raggiunto: ${goal.text}. Premio: ${formatCost(goal.reward)}`, 'good');
    }
  }

  private step(dt: number) {
    const s = this.state;
    const r = s.resources;
    s.day += dt;
    const date = dateFromDays(s.day);
    const si = seasonIndex(date.season);

    if (date.year !== this.lastYear) {
      this.onNewYear(date.year);
      if (!this.locked) this.stepDynasty();
    }
    if (Math.floor(s.day) !== this.lastGoalDay) {
      this.lastGoalDay = Math.floor(s.day);
      if (this.lastGoalDay % 4 === 0) this.checkGoals(eraIndexOf(date.year));
      this.stepEvents(si);
      if (Math.floor(s.day) % 3 === 0 && !this.locked) this.stepPlans();
    }
    if (si !== this.lastSeasonIndex) this.track('Macellazione d\'inverno', () => this.onNewSeason(si), 'event');

    const a = this.analysis();
    const pop0 = s.population;
    // I costruttori lasciano i campi e le botteghe: meno braccia per la produzione
    const builders = this.stepJobs(dt);
    if (builders) this.track('Paga dei costruttori', () => (r.coins = Math.max(0, r.coins - builders * BUILDER_WAGE * dt)));
    const staffing = a.jobs > 0 ? Math.min(1, Math.max(0, pop0 - builders) / a.jobs) : 1;

    // Produzione degli edifici (le strade aumentano la resa)
    for (const { b, def } of this.defsPlaced()) {
      if ((def.produces || def.herd) && !this.isCutOff(b)) this.track(def.name, () => this.produce(b, def, a, si, staffing, dt));
    }

    // Alimentazione
    const pop = s.population;
    const away = this.troopsAway();
    // I reparti fuori dal territorio mangiano i viveri che si portano dietro
    const abroad = this.abroadSoldiers();
    const soldiersHome = this.soldiers() + away.infantry + away.archers + away.cavalry - abroad;
    let need = (pop * FOOD_PER_PERSON + builders * BUILDER_FOOD + soldiersHome * SOLDIER_FOOD) * dt * (this.hasEvent('harsh_winter') ? 1.2 : 1);
    const needed = need;
    let variety = 0;
    const soldiersEating = soldiersHome * SOLDIER_FOOD;
    this.track(
      [
        ['Abitanti (cibo)', pop * FOOD_PER_PERSON],
        ['Soldati (cibo)', soldiersEating],
        ['Costruttori (cibo in più)', builders * BUILDER_FOOD],
      ],
      () => {
        for (const id of EATING_ORDER) {
          if (r[id] > 0.5) variety++;
          const eat = Math.min(r[id], need);
          r[id] -= eat;
          need -= eat;
        }
      },
    );
    const fed = needed > 0 ? 1 - need / needed : 1;

    // Contento della popolazione: si avvicina gradualmente al valore che merita il governo
    this.lastFed = fed;
    this.lastVariety = variety;
    const mood = this.moodTarget();
    const h = this.happiness();
    s.happiness = h + Math.sign(mood.total - h) * Math.min(Math.abs(mood.total - h), 2 * dt);

    // Popolazione: cresce di più se la gente è contenta, se ne va se è scontenta
    const hm = this.happiness();
    if (fed < 0.99) {
      s.population -= pop * 0.004 * (1 - fed) * dt;
    } else if (pop < a.housing && hm >= 30) {
      const growth = (0.006 + pop * 0.00013) * (1 + 0.08 * Math.max(0, variety - 1)) * Math.min(1.5, hm / 55) * (this.fx().growth ?? 1);
      s.population = Math.min(a.housing, pop + growth * dt);
    }
    if (hm < 30) s.population -= pop * 0.0015 * ((30 - hm) / 30) * dt;
    // Tumulti: con la gente molto scontenta, ogni giorno c'è il rischio di una rivolta
    if (hm < 20 && this.random() < 0.02 * dt) {
      const lostCoins = Math.round(r.coins * 0.1);
      this.track('Tumulti', () => {
        r.coins -= lostCoins;
        for (const id of FOOD_IDS) r[id] *= 0.9;
      }, 'event');
      this.log(`Tumulti nel borgo: la folla saccheggia i magazzini (−${lostCoins} monete, −10% di cibo). Abbassa le tasse!`, 'bad');
    }
    if (s.population > a.housing) s.population -= (s.population - a.housing) * 0.008 * dt;
    // Il seguito del signore non se ne va mai: si può sempre ripartire
    s.population = Math.max(Math.min(MIN_POPULATION, pop0), s.population, 0);
    // Avviso quando il cibo sta per finire
    const foodLeft = FOOD_IDS.reduce((t, id) => t + r[id], 0);
    const perDay = Math.max(0.01, needed / dt);
    if (foodLeft / perDay < 40 && s.day - this.hungerWarned > 90) {
      this.hungerWarned = s.day;
      this.log(`⚠️ Il cibo basta per circa ${formatDuration(foodLeft / perDay)}: costruisci campi, orti, cacciatori o pescatori (e i costruttori sottraggono braccia ai campi).`, 'bad');
    }

    // Tasse
    this.track('Tasse', () => (r.coins += this.taxPerDay() * dt));

    // Mantenimento dell'esercito (anche le truppe in spedizione e le macchine d'assedio)
    this.track('Macchine d\'assedio (manutenzione)', () => {
      for (const id of Object.keys(ENGINES) as EngineType[]) {
        const n = (s.engines?.[id] ?? 0) + away[id];
        for (const [res, u] of Object.entries(ENGINES[id].upkeep)) r[res as ResourceId] = Math.max(0, r[res as ResourceId] - (u ?? 0) * n * dt);
      }
    });
    for (const id of Object.keys(UNITS) as UnitType[]) this.track(`Paga: ${UNITS[id].name.toLowerCase()}`, () => {
      const n = s.army[id] + away[id];
      if (!n) return;
      let ok = true;
      for (const [res, u] of Object.entries(UNITS[id].upkeep)) {
        const cost = (u ?? 0) * n * dt;
        const rid = res as ResourceId;
        if (r[rid] < cost) ok = false;
        r[rid] = Math.max(0, r[rid] - cost);
      }
      if (!ok && s.army[id] > 0 && this.random() < 0.05 * dt) {
        s.army[id] -= 1;
        this.log(`Un soldato (${UNITS[id].name}) ha disertato: paga o rifornimenti mancanti.`, 'bad');
      }
    });

    // Deperimento e magazzini
    const cap = this.storageCap(); // durante un assedio vale la capienza dei soli magazzini dentro le mura
    this.track('Deperimento', () => {
      for (const id of RESOURCE_IDS) {
        const sp = RESOURCES[id].spoilage;
        if (sp) r[id] -= r[id] * sp * dt;
      }
    });
    this.track('Magazzini pieni (merce persa)', () => {
      for (const id of RESOURCE_IDS) {
        if (id !== 'coins' && r[id] > cap) r[id] = cap;
        if (r[id] < 0) r[id] = 0;
      }
    });

    if (s.day >= s.nextRaidDay) this.track('Assedi dei predoni', () => this.resolveRaid(), 'event');
    if (s.siege) this.track('Assedi dei predoni', () => this.stepSiege(dt), 'event');
    if (s.offense) this.stepOffense(dt);
    this.stepSupplies(dt);
    this.track('Assedi e spedizioni', () => this.stepWar(), 'event');
    this.track('Bottino riportato dai reparti', () => this.stepCompanies(dt), 'event');
    if (s.lords?.length) this.stepLords(dt);
    this.updateFlowRates(dt);
    if (this.visualDirty) {
      this.visualDirty = false;
      this.stageDirty = false;
      this.changed();
    } else if (this.stageDirty) {
      this.stageDirty = false;
      this.changedVisual();
    }
  }

  /** Produzione di un edificio (e dei suoi animali) in un passo. */
  private produce(b: PlacedBuilding, def: BuildingDef, a: Analysis, si: number, staffing: number, dt: number) {
    const r = this.state.resources;
    if (def.produces) {
      let factor = staffing * (def.seasonal ? def.seasonal[si] : 1) * dt * (a.connected.get(b.uid) ?? 1) * this.productivity() * levelEffects(b.level ?? 1).production;
      if (def.consumes) {
        for (const [id, n] of Object.entries(def.consumes)) {
          const need = (n ?? 0) * factor;
          if (need > 0) factor *= Math.min(1, r[id as ResourceId] / need);
        }
        for (const [id, n] of Object.entries(def.consumes)) r[id as ResourceId] -= (n ?? 0) * factor;
      }
      if (def.category === 'farming' || def.category === 'animals') factor *= this.farmEventFactor();
      const fp = this.fx().produce ?? {};
      for (const [id, n] of Object.entries(def.produces)) r[id as ResourceId] += (n ?? 0) * factor * (fp[id as ResourceId] ?? 1);
    }
    if (def.herd && b.herd !== undefined) this.stepHerd(b, def, si, staffing, dt);
  }

  // ───────────── Registro delle risorse (entrate e uscite per voce) ─────────────

  /** Flussi continui: media mobile (al giorno) per "risorsa|voce". */
  private flowRates = new Map<string, number>();
  private stepFlows = new Map<string, number>();
  /** Spese e incassi una tantum degli ultimi 30 giorni. */
  private flowEvents: Array<{ day: number; res: ResourceId; amount: number; label: string }> = [];
  private tracking = false;

  /** Esegue fn e attribuisce alla voce (o alle voci, in proporzione) le variazioni delle risorse. */
  private track<T>(label: string | Array<[string, number]>, fn: () => T, kind: 'rate' | 'event' = 'rate'): T {
    if (this.tracking) return fn();
    const r = this.state.resources;
    const before = RESOURCE_IDS.map((id) => r[id]);
    this.tracking = true;
    try {
      return fn();
    } finally {
      this.tracking = false;
      const parts: Array<[string, number]> = typeof label === 'string' ? [[label, 1]] : label;
      const tot = parts.reduce((s, [, w]) => s + w, 0) || 1;
      RESOURCE_IDS.forEach((id, i) => {
        const d = r[id] - before[i];
        if (Math.abs(d) < 1e-9) return;
        for (const [l, w] of parts) {
          if (!w) continue;
          const amt = (d * w) / tot;
          if (kind === 'rate') {
            const key = `${id}|${l}`;
            this.stepFlows.set(key, (this.stepFlows.get(key) ?? 0) + amt);
          } else this.flowEvents.push({ day: this.state.day, res: id, amount: amt, label: l });
        }
      });
    }
  }

  private updateFlowRates(dt: number) {
    const k = Math.min(1, dt / 10); // media su circa 10 giorni: segue le stagioni
    const keys = new Set([...this.flowRates.keys(), ...this.stepFlows.keys()]);
    for (const key of keys) {
      const inst = (this.stepFlows.get(key) ?? 0) / dt;
      const old = this.flowRates.get(key);
      const v = old === undefined ? inst : old + (inst - old) * k;
      if (Math.abs(v) < 1e-5 && !this.stepFlows.has(key)) this.flowRates.delete(key);
      else this.flowRates.set(key, v);
    }
    this.stepFlows.clear();
    const cut = this.state.day - 30;
    if (this.flowEvents.length && this.flowEvents[0].day < cut) this.flowEvents = this.flowEvents.filter((e) => e.day >= cut);
  }

  /** Entrate e uscite di una risorsa: flussi al mese e movimenti una tantum degli ultimi 30 giorni. */
  resourceFlows(id: ResourceId): {
    income: Array<{ label: string; perMonth: number }>;
    expense: Array<{ label: string; perMonth: number }>;
    netPerMonth: number;
    oneOff: Array<{ label: string; amount: number }>;
  } {
    const income: Array<{ label: string; perMonth: number }> = [];
    const expense: Array<{ label: string; perMonth: number }> = [];
    let net = 0;
    for (const [key, v] of this.flowRates) {
      const [res, label] = key.split('|');
      if (res !== id) continue;
      const perMonth = v * 30;
      if (Math.abs(perMonth) < 0.05) continue;
      net += perMonth;
      (perMonth > 0 ? income : expense).push({ label, perMonth });
    }
    income.sort((a, b) => b.perMonth - a.perMonth);
    expense.sort((a, b) => a.perMonth - b.perMonth);
    const byLabel = new Map<string, number>();
    for (const e of this.flowEvents) if (e.res === id) byLabel.set(e.label, (byLabel.get(e.label) ?? 0) + e.amount);
    const oneOff = [...byLabel].filter(([, v]) => Math.abs(v) >= 0.5).map(([label, amount]) => ({ label, amount })).sort((a, b) => a.amount - b.amount);
    return { income, expense, netPerMonth: net, oneOff };
  }

  private stepHerd(b: PlacedBuilding, def: BuildingDef, si: number, staffing: number, dt: number) {
    const herd = def.herd!;
    const a = ANIMALS[herd.species];
    const r = this.state.resources;
    let n = b.herd ?? 0;
    const care = (0.4 + 0.6 * staffing) * this.roadBonus(b);

    for (const [id, v] of Object.entries(a.daily)) {
      r[id as ResourceId] += (v ?? 0) * a.dailySeasonal[si] * n * care * dt;
    }

    if (si === 3) {
      let fedRatio = 1;
      for (const [id, v] of Object.entries(a.winterFeed)) {
        const need = (v ?? 0) * n * dt;
        if (need <= 0) continue;
        const got = Math.min(r[id as ResourceId], need);
        r[id as ResourceId] -= got;
        fedRatio = Math.min(fedRatio, got / need);
      }
      if (fedRatio < 1) n -= n * 0.02 * (1 - fedRatio) * dt;
    }

    if (n >= 2) n += (n * a.birthRate[si] * Math.min(1, care) * dt) / DAYS_PER_SEASON;
    const cap = this.herdCapacity(b);
    if (n > cap) {
      const extra = Math.floor(n - cap);
      if (extra > 0) this.slaughter(herd.species, extra);
      n = Math.min(n, cap);
    }
    b.herd = Math.max(0, n);
  }

  private slaughter(species: keyof typeof ANIMALS, heads: number) {
    for (const [id, v] of Object.entries(ANIMALS[species].slaughter)) {
      this.state.resources[id as ResourceId] += (v ?? 0) * heads;
    }
  }

  private onNewSeason(si: number) {
    this.lastSeasonIndex = si;
    const season = (['spring', 'summer', 'autumn', 'winter'] as const)[si];
    if (season === 'winter') {
      let culled = 0;
      for (const { b, def } of this.defsPlaced()) {
        if (!def.herd || !b.herd) continue;
        const heads = Math.floor(b.herd * ANIMALS[def.herd.species].winterCull);
        if (heads > 0) {
          b.herd -= heads;
          this.slaughter(def.herd.species, heads);
          culled += heads;
        }
      }
      this.log(
        culled > 0
          ? `Arriva l'inverno: macellati ${culled} capi per le scorte. Servirà fieno per gli altri.`
          : 'Arriva l\'inverno: i campi riposano, controlla le scorte di cibo e fieno.',
      );
    } else {
      this.log(`Inizia ${SEASON_NAMES[season].toLowerCase()}.`);
    }
  }

  private onNewYear(year: number) {
    const before = eraForYear(this.lastYear);
    const after = eraForYear(year);
    this.lastYear = year;
    if (before.id !== after.id) {
      this.cue('bell');
    this.log(`Nuova epoca: ${after.name}. ${after.description}`, 'good');
    }
  }


  // ───────────── Guerra: macchine d'assedio e spedizioni ─────────────

  onAttackResolved(fn: (r: AttackResult) => void): () => void {
    this.attackListeners.add(fn);
    return () => this.attackListeners.delete(fn);
  }

  engines(): { rams: number; trebuchets: number } {
    this.state.engines ??= { rams: 0, trebuchets: 0 };
    return this.state.engines;
  }

  canBuildEngine(type: EngineType): PlaceCheck {
    if (this.locked) return { ok: false, reason: 'In attesa dell\'altro giocatore' };
    if (!this.has((d) => !!d.workshop)) return { ok: false, reason: 'Serve l\'officina d\'assedio' };
    if (this.date.year < ENGINES[type].minYear) return { ok: false, reason: `Disponibile dal ${ENGINES[type].minYear}` };
    if (!canAfford(this.state.resources, ENGINES[type].cost)) return { ok: false, reason: 'Risorse insufficienti' };
    return { ok: true };
  }

  buildEngine(type: EngineType): boolean {
    return this.track('Macchine d\'assedio (costruzione)', () => this.buildEngineImpl(type), 'event');
  }

  private buildEngineImpl(type: EngineType): boolean {
    if (!this.canBuildEngine(type).ok) return false;
    pay(this.state.resources, ENGINES[type].cost);
    this.engines()[type]++;
    return true;
  }

  /** Truppe attualmente fuori dal castello (in marcia o di ritorno). */
  troopsAway(): Force {
    const f: Force = { infantry: 0, archers: 0, cavalry: 0, rams: 0, trebuchets: 0 };
    for (const e of this.state.expeditions ?? []) {
      const t = e.status === 'returning' && e.result ? e.result.survivors : e.troops;
      for (const k of Object.keys(f) as Array<keyof Force>) f[k] += t[k];
    }
    for (const c of this.state.companies ?? []) for (const k of Object.keys(f) as Array<keyof Force>) f[k] += c.troops[k];
    // Le guardie delle torri di avvistamento sono soldati pagati, ma lontani dal castello
    for (const b of this.state.buildings) {
      if (!b.garrison) continue;
      f.infantry += b.garrison.infantry;
      f.archers += b.garrison.archers;
    }
    return f;
  }

  /** Distanza in caselle tra il proprio sito e quello dell'avversario. */
  private warDistance(): number {
    const slot = this.state.match?.slot ?? 0;
    const a = this.terrain.sites[slot];
    const b = this.terrain.sites[1 - slot] ?? a;
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  }

  /** Giorni di marcia: decide il reparto più lento. */
  marchDays(f: Force): number {
    let speed = Infinity;
    for (const k of ['infantry', 'archers', 'cavalry'] as const) if (f[k] > 0) speed = Math.min(speed, MARCH_SPEED[k]);
    for (const k of ['rams', 'trebuchets'] as const) if (f[k] > 0) speed = Math.min(speed, ENGINES[k].speed);
    if (!isFinite(speed)) speed = 4;
    return Math.max(2, Math.ceil(this.warDistance() / (speed / TIME_SCALE)));
  }

  canLaunch(f: Force): PlaceCheck {
    if (!this.state.match) return { ok: false, reason: 'Le spedizioni sono possibili nelle partite multigiocatore' };
    if (this.locked) return { ok: false, reason: 'In attesa dell\'altro giocatore' };
    const soldiers = f.infantry + f.archers + f.cavalry;
    if (soldiers < 1) return { ok: false, reason: 'Scegli almeno un soldato' };
    if (f.rams + f.trebuchets > 0 && f.infantry < 2 * (f.rams + f.trebuchets)) {
      return { ok: false, reason: 'Ogni macchina d\'assedio richiede almeno 2 fanti per spingerla' };
    }
    for (const k of ['infantry', 'archers', 'cavalry'] as const) if (f[k] > this.state.army[k]) return { ok: false, reason: `Non hai abbastanza ${UNITS[k].name.toLowerCase()}` };
    for (const k of ['rams', 'trebuchets'] as const) if (f[k] > this.engines()[k]) return { ok: false, reason: `Non hai abbastanza ${ENGINES[k].name.toLowerCase()}` };
    if (Object.values(f).some((v) => v < 0 || !Number.isInteger(v))) return { ok: false, reason: 'Numeri non validi' };
    return { ok: true };
  }

  /** Fa partire una spedizione: le truppe lasciano il castello (che resta più sguarnito). */
  launch(f: Force, stance: Stance): Expedition | null {
    if (!this.canLaunch(f).ok) return null;
    for (const k of ['infantry', 'archers', 'cavalry'] as const) this.state.army[k] -= f[k];
    for (const k of ['rams', 'trebuchets'] as const) this.engines()[k] -= f[k];
    const e: Expedition = {
      id: `${this.state.match!.id}:${this.state.match!.slot}:${this.state.nextUid++}`,
      troops: { ...f },
      stance,
      departDay: this.state.day,
      arriveDay: this.state.day + this.marchDays(f),
      status: 'marching',
    };
    (this.state.expeditions ??= []).push(e);
    this.log(`La spedizione è partita: arriverà al castello nemico tra ${formatDuration(e.arriveDay - e.departDay)}.`, 'info');
    return e;
  }

  /** Riceve l'annuncio di un esercito nemico in marcia (idempotente). */
  receiveAttack(a: IncomingAttack) {
    const list = (this.state.incoming ??= []);
    if (list.some((x) => x.id === a.id)) return;
    list.push({ ...a, resolved: undefined });
    const days = Math.max(0, Math.ceil(a.arriveDay - this.state.day));
    const n = a.troops.infantry + a.troops.archers + a.troops.cavalry;
    const engines = a.troops.rams + a.troops.trebuchets;
    this.log(`⚠️ ${a.from} marcia contro di noi con circa ${n} soldati${engines ? ` e ${engines} macchine d'assedio` : ''}: arriverà tra ${formatDuration(days)}!`, 'bad');
  }

  /** Risultati già calcolati, da rimandare all'attaccante se si riconnette. */
  resolvedAttacks(): AttackResult[] {
    return (this.state.incoming ?? []).filter((a) => a.resolved).map((a) => a.resolved!);
  }

  /** L'attaccante riceve l'esito: i superstiti tornano a casa con il bottino. */
  applyAttackResult(r: AttackResult) {
    if (this.applyCompanyResult(r)) return;
    const e = (this.state.expeditions ?? []).find((x) => x.id === r.id);
    if (!e || e.status !== 'marching') return;
    e.status = 'returning';
    e.result = r;
    e.returnDay = this.state.day + this.marchDays(r.survivors);
    const names = { repelled: 'respinta', held: 'ha saccheggiato il borgo nemico (il mastio ha resistito)', sacked: 'ha espugnato il castello nemico' };
    const lootN = Object.values(r.loot).reduce((a, b) => a + (b ?? 0), 0);
    this.log(
      `La spedizione ${names[r.outcome]}! Caduti: ${r.attackerLosses}, nemici caduti: ${r.defenderLosses}${lootN ? `, bottino di ${Math.round(lootN)} unità di merci` : ''}. Rientro tra ${formatDuration(e.returnDay - this.state.day)}.`,
      r.outcome === 'repelled' ? 'bad' : 'good',
    );
    (this.state.campaignLog ??= []).push({ day: this.state.day, text: `Attacco: ${names[r.outcome]}`, outcome: r.outcome, log: r.log });
    if (this.state.campaignLog.length > 10) this.state.campaignLog.shift();
  }

  private stepWar() {
    const s = this.state;
    // Eserciti nemici arrivati: si combatte qui, con lo stato vero del nostro castello
    for (const a of s.incoming ?? []) {
      if (a.resolved || s.day < a.arriveDay) continue;
      const r = this.defendAgainst(a);
      a.resolved = r;
      for (const fn of this.attackListeners) fn(r);
    }
    // Pulizia: tieni solo gli ultimi attacchi risolti
    if (s.incoming && s.incoming.length > 12) s.incoming = s.incoming.slice(-12);
    // Spedizioni rientrate
    for (const e of [...(s.expeditions ?? [])]) {
      if (e.status !== 'returning' || s.day < (e.returnDay ?? Infinity) || !e.result) continue;
      const back = e.result.survivors;
      for (const k of ['infantry', 'archers', 'cavalry'] as const) s.army[k] += back[k];
      for (const k of ['rams', 'trebuchets'] as const) this.engines()[k] += back[k];
      const cap = this.storageCap();
      for (const [id, n] of Object.entries(e.result.loot)) {
        const rid = id as ResourceId;
        s.resources[rid] = rid === 'coins' ? s.resources[rid] + (n ?? 0) : Math.min(cap, s.resources[rid] + (n ?? 0));
      }
      s.expeditions = s.expeditions!.filter((x) => x !== e);
      this.log(`La spedizione è rientrata al castello con ${back.infantry + back.archers + back.cavalry} soldati.`, 'good');
    }
  }

  /** Difesa contro un esercito di un altro giocatore. */
  private defendAgainst(a: IncomingAttack): AttackResult {
    const before = { ...this.state.resources };
    const army: AttackerArmy = {
      name: `L'esercito di ${a.from}`,
      infantry: a.troops.infantry,
      archers: a.troops.archers,
      cavalry: a.troops.cavalry,
      rams: a.troops.rams,
      trebuchets: a.troops.trebuchets,
      morale: STANCES[a.stance]?.morale ?? 0.5,
      arrows: a.tactics?.arrows,
      melee: a.tactics?.melee,
      year: this.date.year,
    };
    const res = this.besiege(army);
    const lost = res.attackerLosses;
    const survivors: Force = {
      infantry: Math.max(0, a.troops.infantry - lost.infantry),
      archers: Math.max(0, a.troops.archers - lost.archers),
      cavalry: Math.max(0, a.troops.cavalry - lost.cavalry),
      // Le macchine si perdono in parte se l'assalto fallisce
      rams: res.outcome === 'repelled' ? Math.floor(a.troops.rams / 2) : a.troops.rams,
      trebuchets: res.outcome === 'repelled' ? Math.floor(a.troops.trebuchets / 2) : a.troops.trebuchets,
    };
    // Bottino: una parte di ciò che il difensore ha perso, quanto i superstiti riescono a portare
    const carry = survivors.infantry * CARRY.infantry + survivors.archers * CARRY.archers + survivors.cavalry * CARRY.cavalry;
    const lostGoods: Cost = {};
    let total = 0;
    for (const id of RESOURCE_IDS) {
      const d = Math.max(0, before[id] - this.state.resources[id]) * 0.6;
      if (d >= 1) {
        lostGoods[id] = d;
        total += id === 'coins' ? d / 5 : d;
      }
    }
    const k = total > carry ? carry / total : 1;
    const loot: Cost = {};
    for (const [id, d] of Object.entries(lostGoods)) loot[id as ResourceId] = Math.floor((d ?? 0) * k);
    return {
      id: a.id,
      outcome: res.outcome,
      survivors,
      loot,
      log: res.log,
      attackerLosses: lost.infantry + lost.archers + lost.cavalry,
      defenderLosses: res.defenderLosses.infantry + res.defenderLosses.archers + res.defenderLosses.cavalry,
    };
  }

  /** Stima delle difese dell'avversario, dai suoi edifici visibili (la guarnigione resta ignota). */
  opponentIntel(): { closed: boolean; breakdown: DefenseBreakdown; walls: number; towers: number; gates: number; moats: number; upgrades: number } | null {
    if (!this.state.match || !this.others.length) return null;
    const key = this.others.length + ':' + this.structureVersion;
    if (this.intelCache?.key === key) return this.intelCache.value;
    const slot = (1 - this.state.match.slot) as 0 | 1;
    const st = createInitialState(this.state.seed, '', { preset: this.state.preset, match: { id: this.state.match.id, slot } });
    st.day = this.state.day;
    st.buildings = this.others.map((b) => ({ ...b, uid: b.uid - FOREIGN }));
    const g = new Game(st);
    const count = (role: string) => g.state.buildings.filter((b) => getBuilding(b.defId).fort === role).length;
    const value = {
      closed: g.analysis().closed,
      breakdown: g.defenseBreakdown(),
      walls: count('wall'),
      towers: count('tower'),
      gates: count('gate'),
      moats: count('moat'),
      upgrades: g.state.buildings.reduce((a, b) => a + (b.upgrades?.length ?? 0), 0),
    };
    this.intelCache = { key, value };
    return value;
  }

  private intelCache: { key: string; value: NonNullable<ReturnType<Game['opponentIntel']>> } | null = null;

  // ───────────── Assedi ─────────────

  /** Fotografia delle difese, usata dalla simulazione dell'assedio (anche per gli attacchi tra giocatori). */
  /**
   * Difese per un assalto. Con `ring` si considera solo quel giro di mura (più il mastio e i
   * fossati appena fuori): negli assedi a fasi i giri cadono uno alla volta.
   */
  siegeSnapshot(ringNo?: number): DefenderSnapshot {
    const a = this.analysis();
    const segments: SiegeSegment[] = [];
    let moatTiles = 0;
    let depth = 0;
    let flooded = 0;
    let stakes = 0;
    let ring = 0;
    for (const b of this.state.buildings) {
      const def = getBuilding(b.defId);
      if (!def.fort) continue;
      if (ringNo !== undefined && def.fort !== 'keep') {
        const d = this.depthOf(b);
        if (def.fort === 'moat' ? d !== ringNo - 1 : d !== ringNo) continue;
      }
      if (def.fort === 'moat') {
        moatTiles++;
        depth += this.moatDepth(b);
        if (this.moatFlooded(b)) flooded++;
        if (b.upgrades?.includes('stakes')) stakes++;
        continue;
      }
      if (def.fort !== 'keep') ring++;
      segments.push({
        uid: b.uid,
        defId: b.defId,
        role: def.fort,
        hp: b.hp ?? this.maxHp(b),
        maxHp: this.maxHp(b),
        upgrades: [...(def.builtIn ?? []), ...(b.upgrades ?? [])],
        defense: (def.defense ?? 0) * (def.fort === 'tower' || def.fort === 'keep' ? this.fx().towerDefense ?? 1 : 1),
        moatAhead: def.fort === 'gate' ? this.gateHasMoat(b) : undefined,
      });
    }
    return {
      segments,
      closed: ringNo === undefined ? a.closed : a.rings >= ringNo,
      ladders: this.state.siege?.ladders,
      starving: this.state.siege?.starving,
      moat: {
        tiles: moatTiles,
        coverage: Math.min(1, moatTiles / Math.max(8, ring * 0.8)),
        depth: moatTiles ? depth / moatTiles : 1,
        flooded: moatTiles ? flooded / moatTiles : 0,
        stakes: moatTiles ? stakes / moatTiles : 0,
      },
      army: this.withAllies(this.defendingTroops()),
      armory: this.state.buildings.some((b) => b.upgrades?.includes('armory')),
      cistern: this.state.buildings.some((b) => b.upgrades?.includes('cistern')),
      charcoal: this.state.resources.charcoal,
      defenseMul: (this.fx().siegeDefense ?? 1) * (this.fx().towerDefense ? 1 + (this.fx().towerDefense! - 1) * 0.5 : 1),
      archerMul: this.fx().archers,
    };
  }

  /** Esercito nemico generato dal gioco, secondo l'epoca e la ricchezza del castello. */
  raiderArmy(): AttackerArmy {
    const year = this.date.year;
    const s = this.state;
    const name =
      year < 960
        ? 'Razziatori ungari'
        : year < 1070
          ? 'Predoni vichinghi'
          : year < 1250
            ? 'L\'esercito di un barone rivale'
            : 'Una compagnia di ventura';
    // La ricchezza attira predoni, ma con un tetto: conta soprattutto l'epoca
    const wealth = Math.min(30, s.resources.coins / 150 + s.population * 0.15);
    const size = Math.round((8 + (year - 900) / 14 + wealth * 0.5) * (0.8 + this.random() * 0.4) * (this.fx().raids ?? 1));
    const archers = Math.round(size * 0.25);
    const cavalry = Math.round(size * (year >= 950 ? 0.15 : 0.05));
    return {
      name,
      infantry: Math.max(1, size - archers - cavalry),
      archers,
      cavalry,
      rams: year >= 1000 ? Math.floor(size / 14) : 0,
      trebuchets: year >= 1200 ? Math.floor(size / 20) : 0,
      morale: year < 1070 ? 0.45 : 0.6,
      year,
    };
  }

  private resolveRaid() {
    const s = this.state;
    const army = this.raiderArmy();
    s.nextRaidDay = s.day + (1000 + this.random() * 1000) / (this.fx().raids ?? 1);
    if (s.siege || !this.ownKeep()) {
      // Senza castello (o durante un altro assedio) i predoni razziano e se ne vanno
      this.besiege(army);
      return;
    }
    const n = this.terrain.size;
    const [kx, kz] = this.keepCenter();
    const a = this.random() * Math.PI * 2;
    const from: [number, number] = [Math.round(Math.min(n - 3, Math.max(2, kx + Math.cos(a) * 40))), Math.round(Math.min(n - 3, Math.max(2, kz + Math.sin(a) * 40)))];
    this.startSiege(army.name, { infantry: army.infantry, archers: army.archers, cavalry: army.cavalry, rams: army.rams, trebuchets: army.trebuchets }, from, army.morale);
  }

  /** Risolve un assedio e ne applica le conseguenze. Restituisce l'esito. */
  besiege(army: AttackerArmy) {
    const s = this.state;
    const result = resolveSiege(this.siegeSnapshot(), army, this.random);
    let visual = false;
    for (const [uid, hp] of result.damage) {
      const b = this.byUid(uid);
      if (!b) continue;
      const before = this.hpState(b);
      b.hp = Math.max(0, Math.round(hp));
      if (this.hpState(b) !== before) visual = true;
    }
    this.applyDefenderLosses(result.defenderLosses);
    s.resources.charcoal = Math.max(0, s.resources.charcoal - result.charcoalUsed);
    this.siegeConsequences(army, result, visual);
    return result;
  }

  /** Esito finale di un assedio: bottino o saccheggio, rapporto per l'interfaccia. */
  private siegeConsequences(army: AttackerArmy, result: ReturnType<typeof resolveSiege>, visual: boolean, extraLog: string[] = []) {
    const s = this.state;
    const cistern = this.state.buildings.some((b) => b.upgrades?.includes('cistern'));
    let loot = 0;
    const atkLost = result.attackerLosses.infantry + result.attackerLosses.archers + result.attackerLosses.cavalry;
    const defLost = result.defenderLosses.infantry + result.defenderLosses.archers + result.defenderLosses.cavalry;
    if (result.outcome === 'repelled') {
      loot = Math.round(atkLost * 3);
      s.resources.coins += loot;
      this.log(`Assalto respinto (${army.name})! Nemici caduti: ${atkLost}, nostri caduti: ${defLost}. Bottino: ${loot} monete.`, 'good');
    } else {
      const ratio = result.outcome === 'held' ? 0.15 : 0.45;
      for (const id of RESOURCE_IDS) s.resources[id] *= 1 - ratio;
      const dead = Math.floor(s.population * (result.outcome === 'held' ? 0.04 : 0.15) * (cistern ? 0.5 : 1));
      s.population -= dead;
      this.log(
        result.outcome === 'held'
          ? `Borgo saccheggiato (${army.name}): −${Math.round(ratio * 100)}% delle scorte, ${dead} morti. Il mastio ha resistito.`
          : `Castello espugnato (${army.name})! Perso il ${Math.round(ratio * 100)}% delle scorte e ${dead} abitanti.`,
        'bad',
      );
    }
    s.lastSiege = {
      day: s.day,
      attacker: army.name,
      outcome: result.outcome,
      log: [...extraLog, ...result.log],
      attackerLosses: atkLost,
      defenderLosses: defLost,
      loot,
    };
    if (visual) this.changed();
  }

  // ───────────── Rifornimenti dei reparti ─────────────

  /** Giorni di viveri che i soldati portano nello zaino (i carri ne aggiungono molti di più). */
  static readonly SUPPLY_DAYS = 40;
  /** In marcia si raziona e si foraggia: un quarto del consumo normale. */
  static readonly FIELD_RATION = 0.25;

  /** Preleva cibo dai magazzini (prima quello che deperisce): restituisce quanto preso. */
  private takeFood(amount: number): number {
    let left = amount;
    const r = this.state.resources;
    for (const id of EATING_ORDER) {
      const t = Math.min(r[id], left);
      r[id] -= t;
      left -= t;
      if (left <= 0) break;
    }
    return amount - left;
  }

  private abroadSoldiers(): number {
    let n = 0;
    for (const c of this.companies()) {
      if (c.envoy || c.scout || this.ownsTile(Math.floor(c.x), Math.floor(c.z))) continue;
      n += c.troops.infantry + c.troops.archers + c.troops.cavalry;
    }
    return n;
  }

  /** Cibo che un reparto può portare: zaini dei soldati più i carri delle salmerie. */
  supplyCap(c: Company): number {
    const n = c.troops.infantry + c.troops.archers + c.troops.cavalry;
    return n * SOLDIER_FOOD * Game.FIELD_RATION * Game.SUPPLY_DAYS + (c.wagons ?? 0) * WAGON.capacity;
  }

  canBuildWagon(): PlaceCheck {
    if (this.locked) return { ok: false, reason: 'In attesa dell\'altro giocatore' };
    if (!canAfford(this.state.resources, WAGON.cost)) return { ok: false, reason: 'Risorse insufficienti' };
    return { ok: true };
  }

  buildWagon(): boolean {
    return this.track('Carri delle salmerie', () => {
      if (!this.canBuildWagon().ok) return false;
      pay(this.state.resources, WAGON.cost);
      this.state.wagons = (this.state.wagons ?? 0) + 1;
      return true;
    }, 'event');
  }

  /** Giorni di viveri rimasti a un reparto. */
  supplyDays(c: Company): number {
    const n = c.troops.infantry + c.troops.archers + c.troops.cavalry;
    return n > 0 ? (c.food ?? 0) / (n * SOLDIER_FOOD * Game.FIELD_RATION) : Infinity;
  }

  /** Fuori dal territorio i reparti consumano i viveri; senza, disertano. Dentro si riforniscono. */
  private stepSupplies(dt: number) {
    for (const c of this.companies()) {
      if (c.envoy || c.scout) continue;
      const n = c.troops.infantry + c.troops.archers + c.troops.cavalry;
      if (n <= 0) continue;
      const ration = n * SOLDIER_FOOD * Game.FIELD_RATION;
      const full = this.supplyCap(c);
      if (this.ownsTile(Math.floor(c.x), Math.floor(c.z))) {
        // Nel proprio territorio i carri tornano a riempirsi dai granai
        // Si riempie in fretta: i carri caricano dai granai
        const want = Math.min(full - (c.food ?? 0), Math.max(ration * 8, (c.wagons ?? 0) * 40) * dt);
        if (want > 0) c.food = (c.food ?? 0) + this.track('Viveri dei reparti', () => this.takeFood(want));
        continue;
      }
      const eat = ration * dt * (weatherOf(this.state.day) === 'snow' ? 1.25 : 1);
      if ((c.food ?? 0) >= eat) {
        c.food = (c.food ?? 0) - eat;
        continue;
      }
      c.food = 0;
      // Senza viveri: fame e diserzioni
      const k = 1 - 0.012 * dt;
      c.troops.infantry *= k;
      c.troops.archers *= k;
      c.troops.cavalry *= k;
      if (!this.alerted.has(`hungry|${c.id}`)) {
        this.alerted.add(`hungry|${c.id}`);
        this.log('🍞 Un reparto lontano da casa ha finito i viveri: i soldati cominciano a disertare. Riportalo nel territorio o rifornisci la marcia.', 'bad');
      }
    }
    for (const c of this.companies()) {
      for (const k of ['infantry', 'archers', 'cavalry'] as const) if (c.troops[k] < 0.5 && c.troops[k] > 0 && (c.food ?? 1) === 0) c.troops[k] = 0;
    }
    this.pruneCompanies();
  }

  /** Giorni stimati per arrivare in fondo al percorso. */
  etaDays(c: Company): number | null {
    if (!c.path?.length) return null;
    const v = this.companySpeed(c);
    if (v <= 0) return null;
    let cost = 0;
    let px = c.x;
    let pz = c.z;
    for (const [x, z] of c.path) {
      const d = Math.hypot(x + 0.5 - px, z + 0.5 - pz);
      const m = c.envoy ? this.envoyMoveCost(x, z) : this.moveCost(x, z);
      cost += d * (isFinite(m) ? m : 1);
      px = x + 0.5;
      pz = z + 0.5;
    }
    return cost / v;
  }

  // ───────────── Intrighi, guerre tra signori e proposte ─────────────

  /** Notizie dal regno: le mosse dei signori arrivano come voci. */
  private news(text: string) {
    this.log(`📰 ${text}`, 'info');
  }

  /** Rapporto tra due signori (simmetrico). */
  tie(a: Lord, b: Lord): number {
    a.ties ??= {};
    b.ties ??= {};
    if (a.ties[b.id] === undefined) {
      const base = (PERSONALITIES[a.personality].base + PERSONALITIES[b.personality].base) / 2;
      const v = Math.round(base + (mulberry32(this.state.seed + a.id * 31 + b.id * 17)() - 0.5) * 50);
      a.ties[b.id] = v;
      b.ties[a.id] = v;
    }
    return a.ties[b.id];
  }

  private setTie(a: Lord, b: Lord, v: number) {
    const x = Math.max(-100, Math.min(100, v));
    a.ties ??= {};
    b.ties ??= {};
    a.ties[b.id] = x;
    b.ties[a.id] = x;
  }

  private lordWar(a: Lord, b: Lord, why: string) {
    if ((a.foes ?? []).includes(b.id)) return;
    a.foes = [...(a.foes ?? []), b.id];
    b.foes = [...(b.foes ?? []), a.id];
    (a.warSince ??= {})[b.id] = this.state.day;
    (b.warSince ??= {})[a.id] = this.state.day;
    a.friends = (a.friends ?? []).filter((x) => x !== b.id);
    b.friends = (b.friends ?? []).filter((x) => x !== a.id);
    this.setTie(a, b, Math.min(this.tie(a, b), -60));
    this.news(`${a.name} dichiara guerra a ${b.name}: ${why}.`);
    // Gli alleati del signore attaccato entrano in guerra
    for (const id of b.friends ?? []) {
      const ally = this.lord(id);
      if (ally && ally !== a && !(ally.foes ?? []).includes(a.id)) {
        ally.foes = [...(ally.foes ?? []), a.id];
        a.foes = [...(a.foes ?? []), ally.id];
        (ally.warSince ??= {})[a.id] = this.state.day;
        (a.warSince ??= {})[ally.id] = this.state.day;
        this.news(`${ally.name}, alleato di ${b.name}, entra in guerra contro ${a.name}.`);
      }
    }
  }

  private makePeace(a: Lord, b: Lord) {
    a.foes = (a.foes ?? []).filter((x) => x !== b.id);
    b.foes = (b.foes ?? []).filter((x) => x !== a.id);
    this.setTie(a, b, Math.max(this.tie(a, b), -20));
  }

  private proposals(): NonNullable<GameState['proposals']> {
    return (this.state.proposals ??= []);
  }

  private propose(p: Omit<NonNullable<GameState['proposals']>[number], 'id' | 'expires'>) {
    if (this.proposals().some((x) => x.lord === p.lord)) return;
    const id = this.state.nextProposalId ?? 1;
    this.state.nextProposalId = id + 1;
    this.proposals().push({ ...p, id, expires: this.state.day + 75 });
    this.log(`📜 ${p.text} (rispondi nella scheda Diplomazia)`, p.kind === 'tribute' || p.kind === 'spy' ? 'bad' : 'info');
  }

  /** Una mossa di un signore: rapporti con gli altri, guerre, alleanze, proposte a noi, intrighi. */
  private intrigue(l: Lord) {
    const power = this.lordPower(l);
    for (const o of this.lords()) {
      if (o === l) continue;
      let t = this.tie(l, o);
      // I rapporti si muovono: chi è in guerra si odia, i vicini bellicosi litigano
      t += (this.random() - 0.5) * 26 + (l.personality === 'aggressive' ? -5 : l.personality === 'greedy' ? -2 : l.personality === 'peaceful' ? 2 : 0);
      if ((l.foes ?? []).includes(o.id)) t -= 4;
      this.setTie(l, o, t);
      const atWar = (l.foes ?? []).includes(o.id);
      if (!atWar && l.liege !== o.id && o.liege !== l.id && t < -40 && power > this.lordPower(o) * (l.personality === 'aggressive' ? 0.7 : 1.0) && this.random() < 0.6) {
        this.lordWar(l, o, t < -70 ? 'un vecchio rancore' : 'vuole le sue terre');
      } else if (!atWar && t > 50 && !(l.friends ?? []).includes(o.id) && this.random() < 0.5) {
        l.friends = [...(l.friends ?? []), o.id];
        o.friends = [...(o.friends ?? []), l.id];
        this.news(`${l.name} e ${o.name} stringono un'alleanza.`);
      } else if (atWar && this.state.day - (l.warSince?.[o.id] ?? 0) > 720 && (t > -30 || this.random() < 0.12)) {
        this.makePeace(l, o);
        this.news(`${l.name} e ${o.name} firmano la pace.`);
      }
    }
    // In guerra con un altro signore: spedizione contro di lui
    const foes = (l.foes ?? []).map((id) => this.lord(id)).filter((x): x is Lord => !!x);
    if (foes.length && !l.companies.length && this.random() < 0.6) this.launchLordRaid(l, foes[Math.floor(this.random() * foes.length)].id);
    // Gli alleati entrano nelle nostre guerre
    if (l.status === 'alliance') {
      for (const w of this.lords()) {
        if (w !== l && w.status === 'war' && !(l.foes ?? []).includes(w.id) && this.random() < 0.4) {
          this.lordWar(l, w, `per tenere fede all'alleanza con ${this.state.castleName}`);
          break;
        }
      }
    }
    // Chi è alleato di un nostro nemico ci diventa ostile
    if (l.status === 'neutral') {
      const enemyFriend = (l.friends ?? []).map((id) => this.lord(id)).find((x) => x?.status === 'war');
      if (enemyFriend && this.random() < 0.3) {
        l.relation -= 25;
        if (l.relation < -50) this.declareWar(l, `È alleato di ${enemyFriend.name}`);
      }
    }
    if (l.status === 'war' || l.status === 'vassal') return;
    // Proposte e intrighi verso di noi: di rado (uno o due anni tra una e l'altra) e non troppe insieme
    if (this.state.day < (l.nextProposal ?? 0) || this.proposals().length >= 3 || this.random() < 0.5) return;
    const asked = this.proposals().length;
    const r = this.random();
    const strong = power > this.myPower() * 1.1;
    if (foes.length && l.relation >= 0 && r < 0.35) {
      const target = foes[0];
      if (target.status !== 'war') {
        const coins = Math.round(80 + l.level * 60);
        this.propose({ lord: l.id, kind: 'help', target: target.id, coins, text: `${l.name} ti chiede di unirti alla guerra contro ${target.name}: offre ${coins} monete.` });
      }
    } else if (l.relation > 60 && l.status !== 'alliance' && r < 0.5) {
      const coins = Math.round(150 + l.level * 80);
      this.propose({ lord: l.id, kind: 'marriage', coins, text: `${l.name} propone un matrimonio tra le casate: alleanza e una dote di ${coins} monete.` });
    } else if (l.relation > 35 && l.status === 'neutral' && r < 0.5) {
      this.propose({ lord: l.id, kind: 'alliance', text: `${l.name} propone un'alleanza.` });
    } else if (l.personality === 'greedy' && strong && r < 0.4) {
      const coins = Math.round(60 + l.level * 50);
      this.propose({ lord: l.id, kind: 'tribute', coins, text: `${l.name} pretende un tributo di ${coins} monete, o ci saranno conseguenze.` });
    } else if (l.relation < -10 && r < 0.3) {
      if (this.random() < 0.5) {
        this.propose({ lord: l.id, kind: 'spy', text: `Le guardie hanno catturato una spia di ${l.name}. Imprigionarla (scopri il suo castello, rapporti peggiori) o rimandarla indietro?` });
      } else {
        this.state.agitation = { lord: l.id, until: this.state.day + 120 };
        this.log(`🕯️ Agitatori al soldo di ${l.name} sobillano i contadini: il contento cala per qualche mese.`, 'bad');
      }
    } else if (r < 0.55) {
      // Commercio: il signore vende ciò che ha in abbondanza, o compra grano se gli manca
      const res = l.res!;
      const st = this.lordStats(l, 0, true);
      const spare: Array<'stone' | 'wood'> = (['stone', 'wood'] as const).filter((k) => res[k] > 300);
      const hungry = res.food < st.use.food * 12;
      const sell = spare.length > 0 && (!hungry || this.random() < 0.5);
      if (!sell && !hungry) return;
      const id: ResourceId = sell ? spare[Math.floor(this.random() * spare.length)] : 'grain';
      const n = Math.round(sell ? Math.min(res[id as 'stone'] * 0.3, 60 + this.random() * 80) : 80 + this.random() * 120);
      if (sell) res[id as 'stone'] -= n;
      const coins = Math.round(n * RESOURCES[id].basePrice * (sell ? 1.1 : 1.2));
      this.propose({
        lord: l.id,
        kind: 'trade',
        coins: sell ? -coins : coins,
        goods: { [id]: sell ? n : -n },
        text: sell ? `${l.name} offre ${n} ${RESOURCES[id].name.toLowerCase()} per ${coins} monete.` : `${l.name} vuole comprare ${n} di grano per ${coins} monete.`,
      });
    }
    if (this.proposals().length > asked || this.state.agitation?.lord === l.id) l.nextProposal = this.state.day + 360 * (1 + this.random());
  }

  /** Proposte in attesa. */
  pendingProposals() {
    return this.proposals();
  }

  /** Risposta a una proposta. */
  answerProposal(id: number, accept: boolean): string {
    const i = this.proposals().findIndex((x) => x.id === id);
    if (i < 0) return '';
    const p = this.proposals()[i];
    const l = this.lord(p.lord);
    const r = this.state.resources;
    if (!l) {
      this.proposals().splice(i, 1);
      return '';
    }
    let msg = '';
    if (accept) {
      if (p.kind === 'tribute' && r.coins < (p.coins ?? 0)) return 'Non hai abbastanza monete';
      if (p.kind === 'trade' && (p.coins ?? 0) < 0 && r.coins < -(p.coins ?? 0)) return 'Non hai abbastanza monete';
      if (p.kind === 'trade') {
        const [[gid, gn]] = Object.entries(p.goods ?? {}) as Array<[ResourceId, number]>;
        if (gn < 0 && r[gid] < -gn) return `Non hai abbastanza ${RESOURCES[gid].name.toLowerCase()}`;
      }
    }
    this.proposals().splice(i, 1);
    switch (p.kind) {
      case 'help': {
        const target = this.lord(p.target ?? -1);
        if (accept && target) {
          this.track('Diplomazia', () => (r.coins += p.coins ?? 0), 'event');
          l.relation += 20;
          this.remember(l, 'Siamo scesi in guerra al suo fianco', 14);
          this.declareWar(target, `Ci siamo uniti a ${l.name}`);
          msg = `Siamo in guerra con ${target.name} al fianco di ${l.name} (+${p.coins} monete).`;
        } else {
          l.relation -= 8;
          this.remember(l, 'Ha rifiutato di aiutarlo in guerra', -9);
          msg = `Rifiutiamo di entrare in guerra: ${l.name} è deluso.`;
        }
        break;
      }
      case 'alliance':
      case 'marriage':
        if (accept) {
          l.status = 'alliance';
          l.relation += 15;
          this.remember(l, p.kind === 'marriage' ? 'Nozze tra le nostre case' : 'Ha accettato l\'alleanza', p.kind === 'marriage' ? 18 : 10);
          if (p.kind === 'marriage') this.marryInto(l);
          if (p.kind === 'marriage') this.track('Diplomazia', () => (r.coins += p.coins ?? 0), 'event');
          msg = p.kind === 'marriage' ? `Nozze celebrate: ${l.name} è nostro alleato (dote ${p.coins} monete).` : `Alleanza con ${l.name}!`;
        } else {
          l.relation -= p.kind === 'marriage' ? 12 : 5;
          this.remember(l, 'Ha rifiutato la sua proposta', -6);
          msg = `Proposta di ${l.name} rifiutata.`;
        }
        break;
      case 'tribute':
        if (accept) {
          this.track('Diplomazia', () => (r.coins -= p.coins ?? 0), 'event');
          l.relation += 10;
          msg = `Pagato il tributo a ${l.name}.`;
        } else {
          l.relation -= 20;
          this.remember(l, 'Ha rifiutato il tributo', -14);
          msg = `Rifiutiamo il tributo: ${l.name} è furioso.`;
          if (l.relation < -45 || l.personality === 'aggressive') this.declareWar(l, 'Abbiamo rifiutato il tributo');
        }
        break;
      case 'trade':
        if (accept) {
          this.track('Commercio con i signori', () => {
            r.coins += p.coins ?? 0;
            for (const [gid, gn] of Object.entries(p.goods ?? {})) r[gid as ResourceId] += gn ?? 0;
          }, 'event');
          l.relation += 4;
          this.remember(l, 'Un buon affare', 3);
          l.wealth -= p.coins ?? 0;
          msg = `Affare concluso con ${l.name}.`;
        } else msg = `Nessun accordo con ${l.name}.`;
        break;
      case 'spy':
        if (accept) {
          l.relation -= 10;
          this.remember(l, 'Ha catturato la sua spia', -6);
          // La spia, interrogata, rivela il castello del suo signore
          this.revealAround(...this.lordKeep(l), 11);
          msg = `La spia di ${l.name} è in catene: ora conosciamo il suo castello.`;
        } else {
          l.relation += 5;
          msg = `La spia torna da ${l.name}: un gesto apprezzato.`;
        }
        break;
    }
    if (msg) this.log(`📜 ${msg}`, accept ? 'good' : 'info');
    return msg;
  }

  // ───────────── Memoria dei signori ─────────────

  /** Il signore ricorda un fatto: pesa sul suo atteggiamento per qualche anno. */
  private remember(l: Lord, text: string, w: number) {
    const m = (l.memory ??= []);
    m.unshift({ day: this.state.day, text, w });
    m.length = Math.min(m.length, 8);
  }

  /** Quanto i ricordi spingono il rapporto (da -30 a +30): dimezzano ogni tre anni. */
  memoryBias(l: Lord): number {
    let b = 0;
    for (const m of l.memory ?? []) b += m.w * Math.pow(0.5, (this.state.day - m.day) / 1080);
    return Math.max(-30, Math.min(30, b));
  }

  /** Ricordi ancora vivi, per l'interfaccia. */
  memoriesOf(l: Lord): Array<{ text: string; w: number; years: number }> {
    return (l.memory ?? [])
      .filter((m) => Math.abs(m.w) * Math.pow(0.5, (this.state.day - m.day) / 1080) >= 1)
      .map((m) => ({ text: m.text, w: m.w, years: Math.floor((this.state.day - m.day) / 360) }));
  }

  /** Le proposte scadute valgono come rifiuto (i tributi ignorati irritano). */
  private expireProposals() {
    for (const p of [...this.proposals()]) {
      if (this.state.day < p.expires) continue;
      // Il tributo ignorato è un rifiuto (e irrita); il resto scade senza clamore
      if (p.kind === 'tribute') this.answerProposal(p.id, false);
      else {
        this.proposals().splice(this.proposals().indexOf(p), 1);
        const l = this.lord(p.lord);
        if (l && p.kind === 'help') l.relation -= 4;
      }
    }
  }

  /** Scopre le caselle attorno a un punto (informazioni ottenute senza andarci). */
  private revealAround(cx: number, cz: number, r: number) {
    const { exp } = this.fogGrids();
    const n = this.terrain.size;
    for (let z = Math.max(0, cz - r); z <= Math.min(n - 1, cz + r); z++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(n - 1, cx + r); x++) if ((x - cx) ** 2 + (z - cz) ** 2 <= r * r) exp[z * n + x] = 1;
    }
    this.lastRevealed = -1;
    this.forceExploredSave = true;
  }
  private forceExploredSave = false;

  // ───────────── Il nostro assedio a un signore ─────────────

  /** Un reparto arrivato alle mura di un signore si unisce all'assedio (o lo comincia). */
  private joinOffense(c: Company, l: Lord) {
    const s = this.state;
    c.order = 'siege';
    c.path = [];
    if (!s.offense) {
      if (l.status !== 'war') this.declareWar(l, 'Hai stretto d\'assedio il suo castello');
      s.offense = {
        lord: l.id,
        companyIds: [],
        camp: [Math.floor(c.x), Math.floor(c.z)],
        startDay: s.day,
        ladders: 0,
        mangonels: 0,
        aim: 'weakest',
        starving: 0,
        assaults: 0,
        sallyDay: s.day + 10,
        log: [],
      };
      this.offenseLog(`Ci accampiamo davanti a ${l.castle}: comincia l'assedio. I campi fuori dalle mura del signore non rendono più.`);
      this.log(`⛺ Assedio a ${l.castle}! Prepara scale e macchine, scegli dove colpire e decidi tu quando assaltare.`, 'info');
    }
    if (!s.offense.companyIds.includes(c.id)) s.offense.companyIds.push(c.id);
  }

  private offenseLog(text: string) {
    const o = this.state.offense;
    if (!o) return;
    o.log.push({ day: this.state.day, text });
    if (o.log.length > 40) o.log.splice(0, o.log.length - 40);
  }

  /** Reparti che partecipano al nostro assedio. */
  offenseCompanies(): Company[] {
    const o = this.state.offense;
    if (!o) return [];
    return this.companies().filter((c) => o.companyIds.includes(c.id) && c.order === 'siege');
  }

  offenseTroops(): Force {
    const t: Force = { infantry: 0, archers: 0, cavalry: 0, rams: 0, trebuchets: 0 };
    for (const c of this.offenseCompanies()) for (const k of Object.keys(t) as Array<keyof Force>) t[k] += c.troops[k];
    return t;
  }

  setOffenseAim(aim: OffensiveSiege['aim']) {
    const o = this.state.offense;
    if (!o) return;
    o.aim = aim;
    o.target = undefined;
  }

  /** Un giorno del nostro assedio: macchine, bombardamento, fame del castello, sortite. */
  private stepOffense(dt: number) {
    const s = this.state;
    const o = s.offense;
    if (!o) return;
    const l = this.lord(o.lord);
    const comps = this.offenseCompanies();
    if (!l || !comps.length) {
      this.endOffense('L\'assedio è finito: non ci sono più reparti nel campo.');
      return;
    }
    if (l.status === 'vassal') {
      this.endOffense(`${l.name} è ormai nostro vassallo: l'assedio è finito.`);
      return;
    }
    const t = this.offenseTroops();
    const size = t.infantry + t.archers + t.cavalry;
    // Preparazione: scale e, dal 1100, mangani costruiti sul posto
    o.ladders = Math.min(40, o.ladders + size * 0.02 * dt);
    if (this.date.year >= 1100) o.mangonels = Math.min(5, o.mangonels + (size / 60) * 0.06 * dt);
    // Bombardamento del tratto scelto
    const engines = Math.floor(o.mangonels) + t.trebuchets * 2.5;
    if (engines > 0) {
      let target = o.target !== undefined ? l.buildings.find((b) => b.uid === o.target) : undefined;
      if (!target || (target.hp ?? 1) <= 0) {
        const forts = l.buildings.filter((b) => {
          const f = getBuilding(b.defId).fort;
          return f && f !== 'moat' && f !== 'keep' && (b.hp ?? 1) > 0;
        });
        const pref = forts.filter((b) => (o.aim === 'gate' ? getBuilding(b.defId).fort === 'gate' : o.aim === 'tower' ? getBuilding(b.defId).fort === 'tower' : true));
        const pool = pref.length ? pref : forts;
        // Il più vicino al campo tra quelli del tipo scelto; per "più debole" quello con meno punti vita
        pool.sort((a, b) =>
          o.aim === 'weakest'
            ? (a.hp ?? 0) - (b.hp ?? 0)
            : Math.hypot(a.x - o.camp[0], a.z - o.camp[1]) - Math.hypot(b.x - o.camp[0], b.z - o.camp[1]),
        );
        target = pool[0];
        o.target = target?.uid;
      }
      if (target) {
        target.hp = Math.max(0, (target.hp ?? this.maxHp(target)) - engines * 9 * dt);
        if (target.hp <= 0) {
          this.offenseLog(`Breccia! ${getBuilding(target.defId).name} del nemico crolla sotto i nostri colpi.`);
          this.log(`🧱 Breccia nelle mura di ${l.castle}: è il momento di assaltare!`, 'good');
          o.target = undefined;
          this.syncLords(true);
        }
      }
    }
    // Fame nel castello assediato: senza cibo il signore si arrende
    if ((l.res?.food ?? 0) < 1) o.starving += dt;
    if (o.starving > 25) {
      l.status = 'vassal';
      l.relation = -30;
      const coins = Math.floor(l.wealth * 0.4);
      l.wealth -= coins;
      for (const c of comps) {
        c.cargo ??= {};
        c.cargo.coins = (c.cargo.coins ?? 0) + Math.floor(coins / comps.length);
      }
      this.log(`👑 Affamato, ${l.name} apre le porte di ${l.castle}: si arrende e diventa nostro vassallo (bottino ${coins} monete nei carri).`, 'good');
      this.endOffense(`${l.castle} si arrende per fame.`);
      return;
    }
    // Sortita degli assediati se si sentono abbastanza forti
    if (s.day >= o.sallyDay) {
      o.sallyDay = s.day + 15 + this.random() * 15;
      const theirs = l.army.infantry * 3 + l.army.archers * 1.5 + l.army.cavalry * 6;
      const ours = t.infantry * 3 + t.archers * 1.5 + t.cavalry * 5;
      if (theirs > ours * 0.5 && theirs > 20) {
        const ratio = theirs / (theirs + ours);
        const ourLoss = size * 0.12 * ratio;
        for (const c of comps) {
          const n = c.troops.infantry + c.troops.archers + c.troops.cavalry;
          const k = n > 0 ? 1 - ourLoss / Math.max(1, size) : 1;
          c.troops.infantry = Math.round(c.troops.infantry * k);
          c.troops.archers = Math.round(c.troops.archers * k);
          c.troops.cavalry = Math.round(c.troops.cavalry * k);
        }
        const theirLoss = (l.army.infantry + l.army.archers + l.army.cavalry) * 0.15 * (1 - ratio);
        const tot = Math.max(1, l.army.infantry + l.army.archers + l.army.cavalry);
        for (const k of ['infantry', 'archers', 'cavalry'] as const) l.army[k] = Math.max(0, l.army[k] - theirLoss * (l.army[k] / tot));
        o.ladders *= 0.6;
        o.mangonels = Math.floor(o.mangonels * 0.7);
        const text = `Sortita degli assediati: perdiamo ${Math.round(ourLoss)} uomini e qualche macchina, loro ${Math.round(theirLoss)}.`;
        this.offenseLog(text);
        this.log(`⚔️ ${text}`, 'bad');
        this.pruneCompanies();
      }
    }
  }

  /** Il giocatore ordina l'assalto. */
  offenseAssault(): boolean {
    const o = this.state.offense;
    const comps = this.offenseCompanies();
    if (!o || !comps.length) return false;
    const l = this.lord(o.lord);
    if (!l) return false;
    const troops = this.offenseTroops();
    const id = `off:${this.state.nextUid++}`;
    for (const c of comps) c.engaged = id;
    const soldiers = Math.max(1, troops.infantry + troops.archers + troops.cavalry);
    const share = (fn: (c: Company) => number) => comps.reduce((s, c) => s + fn(c) * (c.troops.infantry + c.troops.archers + c.troops.cavalry), 0) / soldiers;
    const a: IncomingAttack = {
      id,
      from: this.state.castleName,
      troops,
      stance: 'resolute',
      departDay: this.state.day,
      arriveDay: this.state.day,
      tactics: { arrows: share((c) => FORMATIONS[c.formation ?? 'line'].arrows), melee: share((c) => FORMATIONS[c.formation ?? 'line'].attack) },
    };
    o.assaults++;
    this.offenseLog(`Assalto n. ${o.assaults} con ${soldiers} soldati e ${Math.floor(o.ladders)} scale.`);
    this.assaultLord(comps[0], a, { ladders: o.ladders, starving: o.starving });
    // Esito: chi resta continua l'assedio, a meno che il castello sia caduto
    if (!this.state.offense) return true;
    if (l.status === 'vassal') {
      this.endOffense(`${l.castle} è caduta!`);
      return true;
    }
    o.ladders *= 0.4;
    for (const c of this.companies()) if (o.companyIds.includes(c.id) && !c.engaged) c.order = 'siege';
    return true;
  }

  /** Fine del nostro assedio: i reparti restano liberi (con il bottino nei carri). */
  endOffense(reason: string) {
    const o = this.state.offense;
    if (!o) return;
    this.offenseLog(reason);
    this.cue(this.lord(o.lord)?.status === 'vassal' ? 'victory' : 'defeat');
    for (const c of this.companies()) {
      if (!o.companyIds.includes(c.id)) continue;
      if (c.order === 'siege') c.order = 'idle';
    }
    (this.state.campaignLog ??= []).push({
      day: this.state.day,
      text: `Assedio di ${this.lord(o.lord)?.castle ?? '?'}: ${reason}`,
      outcome: this.lord(o.lord)?.status === 'vassal' ? 'sacked' : 'repelled',
      log: o.log.map((x) => x.text),
    });
    if (this.state.campaignLog.length > 10) this.state.campaignLog.shift();
    this.state.offense = undefined;
    this.syncLords(true);
  }

  /** Togliere l'assedio: i reparti tornano a casa. */
  liftOffense() {
    const o = this.state.offense;
    if (!o) return;
    const ids = this.offenseCompanies().map((c) => c.id);
    this.endOffense('Togliamo l\'assedio.');
    this.orderHome(ids);
  }

  // ───────────── Assedio a fasi ─────────────

  /** Inizia un assedio: l'esercito si accampa davanti alle mura dalla parte da cui arriva. */
  startSiege(name: string, troops: Force, from: [number, number], morale: number, lord?: number, companyId?: string) {
    const s = this.state;
    const [kx, kz] = this.keepCenter();
    // Il campo: oltre le mura più esterne, verso la direzione di arrivo
    let reach = 6;
    for (const b of s.buildings) {
      const def = getBuilding(b.defId);
      if (def.fort) reach = Math.max(reach, Math.hypot(b.x + def.size[0] / 2 - kx, b.z + def.size[1] / 2 - kz));
    }
    const dx = from[0] - kx;
    const dz = from[1] - kz;
    const dl = Math.hypot(dx, dz) || 1;
    const n = this.terrain.size;
    let camp: [number, number] = [Math.round(kx + (dx / dl) * (reach + 6)), Math.round(kz + (dz / dl) * (reach + 6))];
    camp = [Math.min(n - 3, Math.max(2, camp[0])), Math.min(n - 3, Math.max(2, camp[1]))];
    const size = troops.infantry + troops.archers + troops.cavalry;
    s.siege = {
      attacker: name,
      lord,
      companyId,
      troops,
      startTroops: size,
      morale,
      startDay: s.day,
      phase: 'prepare',
      nextDay: s.day + 6 + this.random() * 6,
      breached: 0,
      assaults: 0,
      ladders: 0,
      mangonels: 0,
      camp,
      isolated: {},
      starving: 0,
      sortieReady: s.day,
      log: [],
    };
    this.siegeLog(`${name} si accampa davanti al castello con ${Math.round(size)} soldati: comincia l'assedio.`);
    this.isolateStores();
    // Ciò che è fuori dalle mura si ferma: campi, pascoli, botteghe
    const cut = s.buildings.filter((b) => this.isCutOff(b) && (getBuilding(b.defId).produces || getBuilding(b.defId).herd)).length;
    if (cut) this.siegeLog(`${cut} edifici fuori dalle mura sono tagliati fuori: niente raccolti finché dura l'assedio.`);
    this.cue('horn');
    this.log(`⚔️ Assedio! ${name} circonda il castello. Resisti con le scorte dentro le mura, tenta una sortita o paga un riscatto.`, 'bad');
    this.changedVisual();
  }

  private siegeLog(text: string) {
    const sg = this.state.siege;
    if (!sg) return;
    sg.log.push({ day: this.state.day, text });
    if (sg.log.length > 40) sg.log.splice(0, sg.log.length - 40);
  }

  /** Le scorte che non entrano nei magazzini dentro le mura restano fuori, isolate. */
  private isolateStores() {
    const sg = this.state.siege;
    if (!sg) return;
    const cap = this.siegeStorage();
    const r = this.state.resources;
    let moved = 0;
    for (const id of RESOURCE_IDS) {
      if (id === 'coins' || r[id] <= cap) continue;
      const extra = r[id] - cap;
      sg.isolated[id] = (sg.isolated[id] ?? 0) + extra;
      r[id] = cap;
      moved += extra;
    }
    if (moved > 1) this.siegeLog(`Le scorte dei granai fuori dalle mura (${Math.round(moved)} unità) restano isolate: dentro c'è posto solo per ${cap} per risorsa.`);
  }

  /** Cibo dentro le mura e per quanti giorni basta. */
  siegeFood(): { food: number; days: number } {
    const r = this.state.resources;
    const food = FOOD_IDS.reduce((t, id) => t + r[id], 0);
    const perDay = this.state.population * FOOD_PER_PERSON + this.soldiers() * SOLDIER_FOOD;
    return { food, days: perDay > 0 ? food / perDay : Infinity };
  }

  /** C'è un assedio in corso (subito o nostro)? */
  siegeActive(): boolean {
    return !!this.state.siege || !!this.state.offense;
  }

  /** Nome e durata residua della fase in corso. */
  siegePhase(): { name: string; days: number } | null {
    const sg = this.state.siege;
    if (!sg) return null;
    const names = { prepare: 'Preparazione: costruiscono scale e macchine', bombard: 'Bombardamento delle mura', assault: 'Assalto!' };
    return { name: names[sg.phase], days: Math.max(0, sg.nextDay - this.state.day) };
  }

  /** Un passo dell'assedio: logoramento, fame, fasi, assalti. */
  private stepSiege(dt: number) {
    const s = this.state;
    const sg = s.siege;
    if (!sg) return;
    // Il reparto del signore e l'assedio condividono le truppe (anche dopo un caricamento)
    if (sg.lord !== undefined && sg.companyId) {
      const c = this.lord(sg.lord)?.companies.find((x) => x.id === sg.companyId);
      if (c) c.troops = sg.troops;
    }
    // Malattie e diserzioni nel campo; il morale cala col tempo
    const k = 1 - 0.003 * dt;
    sg.troops.infantry *= k;
    sg.troops.archers *= k;
    sg.troops.cavalry *= k;
    sg.morale = Math.max(0, sg.morale - 0.0025 * dt);
    sg.starving = this.lastFed < 0.6 ? sg.starving + dt : Math.max(0, sg.starving - dt * 0.5);
    const size = sg.troops.infantry + sg.troops.archers + sg.troops.cavalry;
    if (sg.morale < 0.2 || size < sg.startTroops * 0.3 || size < 3) {
      this.endSiege('lifted', [`${sg.attacker} toglie l'assedio: troppe perdite e morale a terra.`]);
      return;
    }
    if (sg.starving > 30) {
      this.endSiege('surrender', ['Senza più cibo dentro le mura, il castello si arrende.']);
      return;
    }
    if (sg.phase === 'prepare') {
      // Scale: più uomini, più scale; mangani dal 1100
      sg.ladders = Math.min(30, sg.ladders + size * 0.02 * dt);
      if (this.date.year >= 1100) sg.mangonels = Math.min(4, sg.mangonels + (size / 60) * 0.06 * dt);
    } else if (sg.phase === 'bombard') {
      this.bombard(dt);
    }
    if (s.day < sg.nextDay) return;
    if (sg.phase === 'prepare') {
      const engines = Math.floor(sg.mangonels) + sg.troops.trebuchets;
      if (engines > 0 && this.analysis().rings > sg.breached) {
        sg.phase = 'bombard';
        sg.nextDay = s.day + 8 + this.random() * 8;
        this.siegeLog(`Le macchine (${engines}) cominciano a bersagliare le mura.`);
      } else {
        sg.phase = 'assault';
        sg.nextDay = s.day;
      }
    } else if (sg.phase === 'bombard') {
      sg.phase = 'assault';
      sg.nextDay = s.day;
    } else {
      this.siegeAssault();
    }
  }

  /** Bombardamento: le macchine colpiscono il tratto più debole del giro di mura sotto attacco. */
  private bombard(dt: number) {
    const sg = this.state.siege!;
    const ring = sg.breached + 1;
    let target = sg.target !== undefined ? this.byUid(sg.target) : undefined;
    if (!target || this.hpState(target) === 'ruin' || this.depthOf(target) !== ring) {
      let best: PlacedBuilding | undefined;
      let score = Infinity;
      for (const b of this.state.buildings) {
        const def = getBuilding(b.defId);
        if (!def.fort || def.fort === 'moat' || def.fort === 'keep' || this.hpState(b) === 'ruin' || this.depthOf(b) !== ring) continue;
        const sc = (b.hp ?? this.maxHp(b)) * (def.fort === 'tower' ? 2 : 1);
        if (sc < score) {
          score = sc;
          best = b;
        }
      }
      target = best;
      sg.target = best?.uid;
    }
    if (!target) return;
    const engines = Math.floor(sg.mangonels) + sg.troops.trebuchets * 2.5;
    const before = this.hpState(target);
    target.hp = Math.max(0, (target.hp ?? this.maxHp(target)) - engines * 9 * dt);
    if (this.hpState(target) !== before) {
      this.changed();
      if (this.hpState(target) === 'ruin' && sg.nextDay > this.state.day + 2) {
        this.siegeLog(`Breccia! ${getBuilding(target.defId).name} crolla sotto i colpi: assalto tra un paio di giorni (riparala, se puoi).`);
        this.log(`🧱 Breccia nelle mura: ripara ${getBuilding(target.defId).name.toLowerCase()} prima dell'assalto!`, 'bad');
        sg.nextDay = Math.min(sg.nextDay, this.state.day + 2);
      }
    }
  }

  /** Assalto al giro di mura successivo. */
  private siegeAssault() {
    const s = this.state;
    const sg = s.siege!;
    const ring = sg.breached + 1;
    const rings = this.analysis().rings;
    const army: AttackerArmy = {
      name: sg.attacker,
      infantry: Math.round(sg.troops.infantry),
      archers: Math.round(sg.troops.archers),
      cavalry: Math.round(sg.troops.cavalry),
      rams: sg.troops.rams,
      trebuchets: sg.troops.trebuchets,
      morale: Math.max(0.3, sg.morale),
      year: this.date.year,
    };
    const result = resolveSiege(this.siegeSnapshot(rings > sg.breached ? ring : undefined), army, this.random);
    let visual = false;
    for (const [uid, hp] of result.damage) {
      const b = this.byUid(uid);
      if (!b) continue;
      const was = this.hpState(b);
      b.hp = Math.max(0, Math.round(hp));
      if (this.hpState(b) !== was) visual = true;
    }
    this.applyDefenderLosses(result.defenderLosses);
    s.resources.charcoal = Math.max(0, s.resources.charcoal - result.charcoalUsed);
    for (const k of ['infantry', 'archers', 'cavalry'] as const) sg.troops[k] = Math.max(0, sg.troops[k] - result.attackerLosses[k]);
    sg.assaults++;
    const lost = result.attackerLosses.infantry + result.attackerLosses.archers + result.attackerLosses.cavalry;
    if (result.outcome === 'repelled') {
      sg.morale -= 0.18;
      sg.ladders *= 0.4;
      sg.phase = 'prepare';
      sg.nextDay = s.day + 5 + this.random() * 6;
      this.siegeLog(`Assalto n. ${sg.assaults} respinto! Caduti ${lost} assalitori.`);
      this.log(`🛡️ Assalto respinto: ${sg.attacker} perde ${lost} uomini.`, 'good');
      if (visual) this.changed();
      return;
    }
    if (rings > ring) {
      // Cade un giro, ma ce n'è un altro: l'assedio continua più dentro
      sg.breached = ring;
      sg.target = undefined;
      sg.ladders = 0;
      sg.phase = 'prepare';
      sg.nextDay = s.day + 6 + this.random() * 6;
      this.siegeLog(`Il ${ring === 1 ? 'primo' : `${ring}°`} giro di mura è caduto! Si resiste dietro il successivo.`);
      this.log(`🔥 Le mura esterne sono cadute: gli edifici tra le cinte sono perduti finché dura l'assedio.`, 'bad');
      this.isolateStores();
      this.changed();
      return;
    }
    this.endSiege(result.outcome, result.log, result, visual);
  }

  /** Fine dell'assedio: ritirata, resa o caduta del castello. */
  private endSiege(how: Outcome | 'lifted' | 'surrender', lines: string[], result?: ReturnType<typeof resolveSiege>, visual = true) {
    const s = this.state;
    const sg = s.siege;
    if (!sg) return;
    s.siege = undefined;
    const won = how === 'repelled' || how === 'lifted';
    this.cue(won ? 'victory' : 'defeat');
    // Le scorte isolate tornano disponibili (se il nemico ha vinto, le ha prese lui)
    if (won) for (const [id, n] of Object.entries(sg.isolated)) s.resources[id as ResourceId] += n ?? 0;
    const army: AttackerArmy = { name: sg.attacker, infantry: 0, archers: 0, cavalry: 0, rams: 0, trebuchets: 0, morale: 0.5 };
    const days = Math.round(s.day - sg.startDay);
    const story = [...sg.log.map((l) => l.text), `L'assedio è durato ${formatDuration(days)}.`];
    if (how === 'lifted') {
      s.lastSiege = { day: s.day, attacker: sg.attacker, outcome: 'repelled', log: [...story, ...lines], attackerLosses: Math.round(sg.startTroops), defenderLosses: 0, loot: 0 };
      this.log(`🏰 ${sg.attacker} toglie l'assedio dopo ${formatDuration(days)}!`, 'good');
    } else if (how === 'surrender') {
      const r = { outcome: 'sacked' as const, log: lines, attackerLosses: { infantry: 0, archers: 0, cavalry: 0 }, defenderLosses: { infantry: 0, archers: 0, cavalry: 0 }, damage: new Map(), charcoalUsed: 0, rounds: 0 };
      this.siegeConsequences(army, r as unknown as ReturnType<typeof resolveSiege>, false, story);
    } else if (result) {
      this.siegeConsequences(army, result, visual, story);
    }
    // Il signore riporta a casa i superstiti
    if (sg.lord !== undefined) {
      const l = this.lord(sg.lord);
      const c = l?.companies.find((x) => x.id === sg.companyId);
      if (l && c) {
        c.troops = { ...sg.troops, infantry: Math.round(sg.troops.infantry), archers: Math.round(sg.troops.archers), cavalry: Math.round(sg.troops.cavalry) };
        c.order = 'home';
        const [sx, sz] = this.lordKeep(l);
        c.path = findPath(this.terrain.size, [Math.floor(c.x), Math.floor(c.z)], [sx, sz + 4], (x, z) => this.lordMoveCost(x, z));
        if (!won) l.wealth += 150 + l.level * 50;
        else l.relation -= 5;
      }
    }
    this.changed();
  }

  /** Sortita: la guarnigione esce e colpisce il campo nemico (macchine e scale bruciano). */
  canSortie(): PlaceCheck {
    const sg = this.state.siege;
    if (!sg) return { ok: false, reason: 'Nessun assedio' };
    if (this.state.day < sg.sortieReady) return { ok: false, reason: `I soldati si riprendono (${formatDuration(sg.sortieReady - this.state.day)})` };
    if (this.soldiers() < 4) return { ok: false, reason: 'Servono almeno 4 soldati' };
    return { ok: true };
  }

  sortie(): string {
    const sg = this.state.siege;
    if (!sg || !this.canSortie().ok) return '';
    const a = this.state.army;
    // Esce metà della guarnigione: la cavalleria conta di più, il nemico è sorpreso nel campo
    const out = { infantry: Math.floor(a.infantry / 2), archers: Math.floor(a.archers / 3), cavalry: a.cavalry };
    const mine = (out.infantry * 3 + out.archers * 1.5 + out.cavalry * 6) * 1.3;
    const theirs = (sg.troops.infantry * 3 + sg.troops.archers * 1.5 + sg.troops.cavalry * 5) * 0.55 * (0.6 + sg.morale);
    const ratio = mine / Math.max(1, mine + theirs);
    const kill = Math.max(1, (sg.troops.infantry + sg.troops.archers + sg.troops.cavalry) * 0.18 * ratio * 2);
    const tot = Math.max(1, sg.troops.infantry + sg.troops.archers + sg.troops.cavalry);
    for (const k of ['infantry', 'archers', 'cavalry'] as const) sg.troops[k] = Math.max(0, sg.troops[k] - kill * (sg.troops[k] / tot));
    const lossK = 0.35 * (1 - ratio);
    let ourLost = 0;
    for (const k of ['infantry', 'archers', 'cavalry'] as const) {
      const l = Math.round(out[k] * lossK);
      a[k] -= l;
      ourLost += l;
    }
    sg.sortieReady = this.state.day + 12;
    let text: string;
    if (ratio > 0.45) {
      sg.ladders *= 0.3;
      sg.mangonels = Math.floor(sg.mangonels * 0.5);
      sg.morale -= 0.1;
      if (sg.phase !== 'prepare') {
        sg.phase = 'prepare';
        sg.nextDay = this.state.day + 6;
      }
      text = `Sortita riuscita! Bruciate scale e macchine, ${Math.round(kill)} nemici a terra (nostri caduti: ${ourLost}).`;
      this.log(`🔥 ${text}`, 'good');
    } else {
      text = `Sortita respinta: ${Math.round(kill)} nemici a terra, ma noi perdiamo ${ourLost} uomini.`;
      this.log(`⚔️ ${text}`, 'bad');
    }
    this.siegeLog(text);
    return text;
  }

  /** Riscatto: si pagano gli assedianti perché se ne vadano. */
  ransomCost(): number {
    const sg = this.state.siege;
    if (!sg) return 0;
    const size = sg.troops.infantry + sg.troops.archers + sg.troops.cavalry;
    return Math.round((size * 6 + 40) * (0.6 + sg.morale * 0.8));
  }

  payRansom(): boolean {
    const cost = this.ransomCost();
    if (!this.state.siege || this.state.resources.coins < cost) return false;
    this.track('Riscatto agli assedianti', () => (this.state.resources.coins -= cost), 'event');
    this.siegeLog(`Pagato un riscatto di ${cost} monete.`);
    this.endSiege('lifted', [`Il riscatto è stato pagato: ${this.state.siege?.attacker ?? 'il nemico'} se ne va.`]);
    return true;
  }


  // ───────────── Reparti sul campo (comandati dal giocatore) ─────────────

  /** Reparti dell'avversario, ricevuti dalla rete (solo da guardare). */
  enemyCompanies: Company[] = [];
  private assaultListeners = new Set<(a: IncomingAttack) => void>();
  private fieldCooldown = new Map<string, number>();

  companies(): Company[] {
    return (this.state.companies ??= []);
  }

  onAssault(fn: (a: IncomingAttack) => void): () => void {
    this.assaultListeners.add(fn);
    return () => this.assaultListeners.delete(fn);
  }

  setEnemyCompanies(list: Company[]) {
    this.enemyCompanies = list;
  }

  /** Centro del proprio mastio (o del sito, se non c'è ancora). */
  keepCenter(): [number, number] {
    const k = this.state.buildings.find((b) => getBuilding(b.defId).fort === 'keep');
    if (!k) return this.homeSite();
    const [w, d] = getBuilding(k.defId).size;
    return [k.x + w / 2, k.z + d / 2];
  }

  /** Costo per i propri reparti di entrare in una casella (Infinity = invalicabile). */
  moveCost(x: number, z: number): number {
    const t = tileAt(this.terrain, x, z);
    if (t === undefined) return Infinity;
    const b = this.buildingAt(x, z);
    if (b) {
      const def = getBuilding(b.defId);
      if (def.road) return def.id === 'road_paved' ? 0.5 : 0.65;
      if (def.fort === 'gate') return this.isForeign(b) ? (this.hpState(b) === 'ruin' ? 1.5 : Infinity) : 0.8;
      if (def.fort === 'moat') return 3;
      if (def.fort) return this.hpState(b) === 'ruin' ? 1.6 : Infinity;
      return this.isForeign(b) ? 1.4 : 1.2;
    }
    // Il mare non si attraversa; i fiumi si guadano a fatica (i ponti sono molto più rapidi)
    if (t === Tile.Sea) return Infinity;
    if (t === Tile.River) return 10;
    if (t === Tile.Forest) return 2.2;
    if (t === Tile.Rock || t === Tile.Gold) return 1.4;
    return 1;
  }

  /** Velocità del reparto (caselle al giorno), decisa dal più lento. */
  companySpeed(c: Company): number {
    let v = Infinity;
    for (const k of ['infantry', 'archers', 'cavalry'] as const) if (c.troops[k] > 0) v = Math.min(v, MARCH_SPEED[k]);
    for (const k of ['rams', 'trebuchets'] as const) if (c.troops[k] > 0) v = Math.min(v, ENGINES[k].speed);
    // Le velocità sono in caselle al giorno: i giorni ora sono più brevi, la marcia resta uguale in tempo reale
    if (c.envoy) return 3 / TIME_SCALE;
    if (c.scout) return 4 / TIME_SCALE;
    if (c.wagons) v = Math.min(v, WAGON.speed);
    // Fango e neve rallentano la marcia
    const wx = weatherOf(this.state.day);
    v = ((isFinite(v) ? v : 4) * FORMATIONS[c.formation ?? 'line'].speed * (wx === 'rain' ? 0.85 : wx === 'snow' ? 0.75 : 1)) / TIME_SCALE;
    return c.groupSpeed ? Math.min(v, c.groupSpeed) : v;
  }

  private spawnPoint(): [number, number] {
    // La prima casella libera a partire dal mastio (anche dentro la cinta: poi si esce dalla porta)
    const [cx, cz] = this.keepCenter();
    for (let r = 1; r < 12; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const x = Math.floor(cx + dx);
          const z = Math.floor(cz + dz + 0.5);
          if (!this.buildingAt(x, z) && isFinite(this.moveCost(x, z))) return [x + 0.5, z + 0.5];
        }
      }
    }
    return [cx, cz + 2];
  }

  canForm(f: Force): PlaceCheck {
    if (this.locked) return { ok: false, reason: 'In attesa dell\'altro giocatore' };
    if (f.infantry + f.archers + f.cavalry < 1) return { ok: false, reason: 'Scegli almeno un soldato' };
    if (f.rams + f.trebuchets > 0 && f.infantry < 2 * (f.rams + f.trebuchets)) {
      return { ok: false, reason: 'Ogni macchina d\'assedio richiede almeno 2 fanti per spingerla' };
    }
    if (Object.values(f).some((v) => v < 0 || !Number.isInteger(v))) return { ok: false, reason: 'Numeri non validi' };
    for (const k of ['infantry', 'archers', 'cavalry'] as const) if (f[k] > this.state.army[k]) return { ok: false, reason: `Non hai abbastanza ${UNITS[k].name.toLowerCase()} nel castello` };
    for (const k of ['rams', 'trebuchets'] as const) if (f[k] > this.engines()[k]) return { ok: false, reason: `Non hai abbastanza ${ENGINES[k].name.toLowerCase()}` };
    return { ok: true };
  }

  /** Forma un reparto con truppe della guarnigione: esce dal castello e si può muovere sulla mappa. */
  formCompany(f: Force, wagons = 0): Company | null {
    if (!this.canForm(f).ok) return null;
    wagons = Math.max(0, Math.min(Math.floor(wagons), this.state.wagons ?? 0));
    for (const k of ['infantry', 'archers', 'cavalry'] as const) this.state.army[k] -= f[k];
    for (const k of ['rams', 'trebuchets'] as const) this.engines()[k] -= f[k];
    const [x, z] = this.spawnPoint();
    const slot = this.state.match?.slot ?? 0;
    const c: Company = { id: `c${slot}-${this.state.nextUid++}`, troops: { ...f }, x, z, order: 'idle', formation: 'line', behavior: 'defensive' };
    if (wagons) {
      c.wagons = wagons;
      this.state.wagons = (this.state.wagons ?? 0) - wagons;
    }
    c.food = this.track('Viveri dei reparti', () => this.takeFood(this.supplyCap(c)));
    if (f.infantry + f.archers + f.cavalry >= 8) c.cmd = this.takeCommander();
    this.companies().push(c);
    return c;
  }

  /** Un comandante esperto, se ce n'è uno in attesa; altrimenti uno nuovo. */
  private takeCommander(): Commander {
    const vets = (this.state.veterans ??= []);
    if (vets.length) {
      vets.sort((a, b) => b.skill - a.skill);
      return vets.shift()!;
    }
    const used = new Set(this.companies().map((c) => c.cmd?.name));
    const free = COMMANDER_NAMES.filter((n) => !used.has(n));
    const pool = free.length ? free : COMMANDER_NAMES;
    return { name: pool[Math.floor(this.random() * pool.length)], skill: 0.03 + this.random() * 0.05, wins: 0 };
  }

  /** Esito dei comandanti dopo uno scontro: chi vince si afferma, chi perde può cadere. */
  private commanderOutcome(group: Company[], won: boolean, losses: Record<string, Force>) {
    for (const c of group) {
      const cmd = c.cmd;
      if (!cmd) continue;
      if (won) {
        cmd.wins++;
        cmd.skill = Math.min(0.35, cmd.skill + 0.03);
        this.log(`🎖️ ${cmd.name} esce vittorioso (+${Math.round(cmd.skill * 100)}% alla forza del reparto).`, 'good');
        continue;
      }
      const l = losses[c.id];
      const before = c.troops.infantry + c.troops.archers + c.troops.cavalry;
      const lost = l ? l.infantry + l.archers + l.cavalry : 0;
      if (before > 0 && lost / before > 0.5 && this.random() < 0.35) {
        this.log(`💀 ${cmd.name} è caduto in battaglia: il reparto è sbandato.`, 'bad');
        if (l) {
          // Lo sbandamento costa un'altra fetta di soldati
          for (const k of ['infantry', 'archers', 'cavalry'] as const) l[k] += Math.round((c.troops[k] - l[k]) * 0.15);
        }
        delete c.cmd;
      }
    }
  }

  private own(ids: string[]): Company[] {
    return this.companies().filter((c) => ids.includes(c.id) && !c.engaged);
  }

  private route(c: Company, tx: number, tz: number, append = false) {
    const size = this.terrain.size;
    const gx = Math.max(0, Math.min(size - 1, Math.floor(tx)));
    const gz = Math.max(0, Math.min(size - 1, Math.floor(tz)));
    const last = append && c.path?.length ? c.path[c.path.length - 1] : null;
    const from: [number, number] = last ? [last[0], last[1]] : [Math.floor(c.x), Math.floor(c.z)];
    const seg = findPath(size, from, [gx, gz], (x, z) => this.moveCost(x, z));
    c.path = last ? [...c.path!, ...seg] : seg;
  }

  /**
   * Punti di arrivo per un gruppo: in fila perpendicolare alla direzione di marcia,
   * centrata sul punto scelto (fanti al centro, arcieri e cavalieri ai lati).
   */
  private spread(list: Company[], tx: number, tz: number): Array<[number, number]> {
    if (list.length === 1) return [[tx, tz]];
    const cx = list.reduce((s, c) => s + c.x, 0) / list.length;
    const cz = list.reduce((s, c) => s + c.z, 0) / list.length;
    let dx = tx - cx;
    let dz = tz - cz;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d;
    dz /= d;
    const px = -dz;
    const pz = dx;
    const gap = 1.5;
    return list.map((_, i) => {
      const k = (i % 2 ? 1 : -1) * Math.ceil(i / 2);
      return [tx + px * k * gap, tz + pz * k * gap];
    });
  }

  private orderGroup(list: Company[], tx: number, tz: number, order: Company['order'], append: boolean) {
    // Fanti al centro della fila
    const sorted = [...list].sort((a, b) => b.troops.infantry - a.troops.infantry);
    const pts = this.spread(sorted, tx, tz);
    const slowest = Math.min(...sorted.map((c) => {
      const g = c.groupSpeed;
      c.groupSpeed = undefined;
      const v = this.companySpeed(c);
      c.groupSpeed = g;
      return v;
    }));
    sorted.forEach((c, i) => {
      this.route(c, pts[i][0], pts[i][1], append && c.order === order);
      c.order = order;
      c.groupSpeed = sorted.length > 1 ? slowest : undefined;
    });
  }

  /** Ordine di movimento verso una casella. Con più reparti si dispongono in formazione attorno al punto. */
  /** Ordine di movimento. Con `append` (Maiusc) aggiunge una tappa al percorso già assegnato. */
  orderMove(ids: string[], tx: number, tz: number, append = false) {
    const list = this.own(ids);
    for (const c of list) c.target = undefined;
    this.orderGroup(list, tx, tz, 'move', append);
  }

  setFormation(ids: string[], f: Formation) {
    for (const c of this.companies()) if (ids.includes(c.id)) c.formation = f;
  }

  setBehavior(ids: string[], b: Behavior) {
    for (const c of this.companies()) if (ids.includes(c.id)) c.behavior = b;
  }

  /** Ordine d'attacco: marciare contro un edificio dell'avversario e assaltare il castello. */
  orderAttack(ids: string[], tx: number, tz: number): PlaceCheck {
    if (!this.others.length) return { ok: false, reason: 'Nessun castello nemico da attaccare' };
    const tb = this.buildingAt(Math.floor(tx), Math.floor(tz));
    if (tb?.owner !== undefined) {
      const lord = this.lord(tb.owner);
      if (lord && lord.status !== 'war') this.declareWar(lord, 'Hai attaccato il suo castello');
    }
    const list = this.own(ids);
    this.orderGroup(list, tx, tz, 'attack', false);
    for (const c of list) c.target = [tx, tz];
    return { ok: true };
  }

  orderHome(ids: string[]) {
    const [kx, kz] = this.keepCenter();
    for (const c of this.own(ids)) {
      this.route(c, kx, kz);
      c.order = 'home';
      c.target = undefined;
    }
  }

  orderStop(ids: string[]) {
    for (const c of this.own(ids)) {
      c.path = [];
      c.order = 'idle';
    }
  }

  /** Divide un reparto in due metà. */
  splitCompany(id: string): Company | null {
    const c = this.own([id])[0];
    if (!c) return null;
    const half: Force = { infantry: 0, archers: 0, cavalry: 0, rams: 0, trebuchets: 0 };
    for (const k of Object.keys(half) as Array<keyof Force>) {
      half[k] = Math.floor(c.troops[k] / 2);
      c.troops[k] -= half[k];
    }
    if (half.infantry + half.archers + half.cavalry === 0) {
      for (const k of Object.keys(half) as Array<keyof Force>) c.troops[k] += half[k];
      return null;
    }
    const n: Company = { id: `c${this.state.match?.slot ?? 0}-${this.state.nextUid++}`, troops: half, x: c.x + 0.6, z: c.z + 0.4, order: 'idle' };
    // I viveri si dividono: il nuovo reparto prende quanto entra nei suoi zaini
    const share = Math.min(c.food ?? 0, this.supplyCap(n));
    n.food = share;
    c.food = (c.food ?? 0) - share;
    this.companies().push(n);
    return n;
  }

  /** Reparto proprio più vicino a un punto (per la selezione). */
  companyAt(x: number, z: number, r = 0.9): Company | undefined {
    let best: Company | undefined;
    let bd = r;
    for (const c of this.companies()) {
      const d = Math.hypot(c.x - x, c.z - z);
      if (d < bd) {
        bd = d;
        best = c;
      }
    }
    return best;
  }

  /** Soldati nemici dentro il proprio territorio (per l'allarme). */
  enemiesInTerritory(): number {
    let n = 0;
    for (const c of this.enemyCompanies) {
      if (c.owner !== undefined && this.lord(c.owner)?.status !== 'war') continue;
      if (this.ownsTile(Math.floor(c.x), Math.floor(c.z))) n += c.troops.infantry + c.troops.archers + c.troops.cavalry;
    }
    return n;
  }

  /** Indice del sito di castello più vicino alla casella (divisione del territorio). */
  ownerAt(x: number, z: number): number {
    let best = 0;
    let bd = Infinity;
    this.terrain.sites.forEach(([sx, sz], i) => {
      const d = (x + 0.5 - sx) ** 2 + (z + 0.5 - sz) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }

  /** La casella è nel proprio territorio? */
  ownsTile(x: number, z: number): boolean {
    if (x < 0 || z < 0 || x >= this.terrain.size || z >= this.terrain.size) return false;
    if (this.terrain.sites.length <= 1) return true;
    return this.ownerAt(x, z) === (this.state.match?.slot ?? 0);
  }

  private nearHome(c: Company, r = 6): boolean {
    const [kx, kz] = this.keepCenter();
    return Math.hypot(c.x - kx, c.z - kz) <= r;
  }

  /** Chi difende il castello: la guarnigione e i reparti fermi vicino al mastio. */
  defendingTroops(): { infantry: number; archers: number; cavalry: number } {
    const t = { ...this.state.army };
    for (const c of this.state.companies ?? []) {
      if (c.engaged || c.order === 'attack' || !this.nearHome(c)) continue;
      t.infantry += c.troops.infantry;
      t.archers += c.troops.archers;
      t.cavalry += c.troops.cavalry;
    }
    return t;
  }

  private applyDefenderLosses(l: { infantry: number; archers: number; cavalry: number }) {
    const left = { ...l };
    for (const k of ['infantry', 'archers', 'cavalry'] as const) {
      const take = Math.min(this.state.army[k], left[k]);
      this.state.army[k] -= take;
      left[k] -= take;
    }
    for (const c of this.state.companies ?? []) {
      if (c.engaged || c.order === 'attack' || !this.nearHome(c)) continue;
      for (const k of ['infantry', 'archers', 'cavalry'] as const) {
        const take = Math.min(c.troops[k], left[k]);
        c.troops[k] -= take;
        left[k] -= take;
      }
    }
    this.pruneCompanies();
  }

  private pruneCompanies() {
    if (!this.state.companies) return;
    this.state.companies = this.state.companies.filter((c) => c.envoy || c.scout || c.troops.infantry + c.troops.archers + c.troops.cavalry > 0);
  }

  private stepCompanies(dt: number) {
    const list = this.state.companies;
    if (!list?.length) return;
    for (const c of [...list]) {
      if (c.engaged) continue;
      // Movimento lungo il percorso
      let budget = this.companySpeed(c) * dt;
      while (budget > 1e-6 && c.path?.length) {
        const [nx, nz] = c.path[0];
        const tx = nx + 0.5;
        const tz = nz + 0.5;
        const dx = tx - c.x;
        const dz = tz - c.z;
        const d = Math.hypot(dx, dz);
        const cost = c.envoy ? this.envoyMoveCost(nx, nz) : this.moveCost(nx, nz);
        if (!isFinite(cost)) {
          // Il percorso è stato chiuso (nuove mura): ricalcola
          if (c.order === 'attack' && c.target) this.route(c, c.target[0], c.target[1]);
          else c.path = [];
          break;
        }
        const step = budget / cost;
        if (step >= d) {
          c.x = tx;
          c.z = tz;
          c.path.shift();
          budget -= d * cost;
        } else {
          c.x += (dx / d) * step;
          c.z += (dz / d) * step;
          budget = 0;
        }
        if (d > 1e-6) c.heading = Math.atan2(-dz, dx);
      }
      const arrived = !c.path?.length;
      if (arrived) c.groupSpeed = undefined;
      // Comportamento aggressivo: da fermo insegue il nemico più vicino entro 6 caselle
      if (c.order === 'idle' && c.behavior === 'aggressive' && this.enemyCompanies.length) {
        let best: Company | null = null;
        let bd = 6;
        for (const e of this.enemyCompanies) {
          const d = Math.hypot(e.x - c.x, e.z - c.z);
          if (d < bd) {
            bd = d;
            best = e;
          }
        }
        if (best && bd > 1) {
          this.route(c, best.x, best.z);
          c.order = 'move';
          continue;
        }
      }
      if (c.envoy && c.order === 'move' && this.envoyArrived(c)) {
        this.resolveMission(c);
        continue;
      }
      if (c.order === 'home' && this.nearHome(c, 3.2)) {
        this.mergeHome(c);
        continue;
      }
      if (c.order === 'attack') {
        if (this.nearEnemyWalls(c)) {
          const l = this.state.match ? undefined : this.nearestLord(c.x, c.z);
          // Castello con la cinta chiusa: ci si accampa e si assedia; altrimenti assalto subito
          if (l && this.lordRingClosed(l) && (!this.state.offense || this.state.offense.lord === l.id)) this.joinOffense(c, l);
          else this.startAssault(c);
        } else if (arrived) c.order = 'idle';
      } else if (arrived && c.order === 'move') c.order = 'idle';
    }
  }

  private mergeHome(c: Company) {
    for (const k of ['infantry', 'archers', 'cavalry'] as const) this.state.army[k] += c.troops[k];
    // I carri tornano al castello e i viveri avanzati nei granai
    if (c.wagons) this.state.wagons = (this.state.wagons ?? 0) + c.wagons;
    if (c.cmd) {
      const vets = (this.state.veterans ??= []);
      vets.push(c.cmd);
      vets.sort((a, b) => b.skill - a.skill);
      vets.length = Math.min(vets.length, 6);
    }
    if (c.food) this.track('Viveri dei reparti', () => (this.state.resources.grain += c.food ?? 0));
    c.food = 0;
    for (const k of ['rams', 'trebuchets'] as const) this.engines()[k] += c.troops[k];
    const cap = this.storageCap();
    let goods = 0;
    for (const [id, n] of Object.entries(c.cargo ?? {})) {
      const rid = id as ResourceId;
      this.state.resources[rid] = rid === 'coins' ? this.state.resources[rid] + (n ?? 0) : Math.min(cap, this.state.resources[rid] + (n ?? 0));
      goods += n ?? 0;
    }
    this.state.companies = this.companies().filter((x) => x !== c);
    this.log(
      c.scout
        ? 'L\'esploratore è rientrato al castello.'
        : c.envoy
        ? `Il diplomatico è tornato al castello${goods ? ` con ${Math.round(goods)} monete di tributo` : ''}.`
        : `Un reparto è rientrato nel castello${goods ? ` con ${Math.round(goods)} unità di bottino` : ''}.`,
      'good',
    );
  }

  private nearEnemyWalls(c: Company): boolean {
    for (const b of this.others) {
      const def = getBuilding(b.defId);
      if (!def.fort || def.fort === 'moat') continue;
      const [w, d] = def.size;
      const dx = Math.max(b.x - c.x, 0, c.x - (b.x + w));
      const dz = Math.max(b.z - c.z, 0, c.z - (b.z + d));
      if (Math.hypot(dx, dz) <= (def.fort === 'keep' ? 3 : 2.2)) return true;
    }
    return false;
  }

  /** I reparti all'attacco vicini tra loro assaltano insieme il castello nemico. */
  private startAssault(lead: Company) {
    const group = this.companies().filter((c) => !c.engaged && c.order === 'attack' && Math.hypot(c.x - lead.x, c.z - lead.z) <= 8);
    const troops: Force = { infantry: 0, archers: 0, cavalry: 0, rams: 0, trebuchets: 0 };
    for (const c of group) for (const k of Object.keys(troops) as Array<keyof Force>) troops[k] += c.troops[k];
    const id = `${this.state.match?.id}:${this.state.match?.slot}:a${this.state.nextUid++}`;
    for (const c of group) {
      c.engaged = id;
      c.path = [];
    }
    const soldiers = Math.max(1, group.reduce((s, c) => s + c.troops.infantry + c.troops.archers + c.troops.cavalry, 0));
    const share = (fn: (c: Company) => number) => group.reduce((s, c) => s + fn(c) * (c.troops.infantry + c.troops.archers + c.troops.cavalry), 0) / soldiers;
    const a: IncomingAttack = {
      id,
      from: this.state.castleName,
      troops,
      stance: 'resolute',
      departDay: this.state.day,
      arriveDay: this.state.day,
      tactics: {
        arrows: share((c) => FORMATIONS[c.formation ?? 'line'].arrows),
        melee: share((c) => FORMATIONS[c.formation ?? 'line'].attack),
      },
    };
    this.log(`All'assalto! ${troops.infantry + troops.archers + troops.cavalry} soldati attaccano le mura nemiche.`, 'info');
    if (!this.state.match) {
      this.assaultLord(lead, a);
      return;
    }
    for (const fn of this.assaultListeners) fn(a);
  }

  /** Assalto concluso: le perdite si dividono tra i reparti, il bottino va nei carri. */
  private applyCompanyResult(r: AttackResult): boolean {
    const group = this.companies().filter((c) => c.engaged === r.id);
    if (!group.length) return false;
    const total: Force = { infantry: 0, archers: 0, cavalry: 0, rams: 0, trebuchets: 0 };
    for (const c of group) for (const k of Object.keys(total) as Array<keyof Force>) total[k] += c.troops[k];
    const soldiers = Math.max(1, r.survivors.infantry + r.survivors.archers + r.survivors.cavalry);
    for (const c of group) {
      for (const k of Object.keys(total) as Array<keyof Force>) {
        c.troops[k] = total[k] ? Math.round((c.troops[k] * r.survivors[k]) / total[k]) : 0;
      }
      const share = (c.troops.infantry + c.troops.archers + c.troops.cavalry) / soldiers;
      c.cargo ??= {};
      for (const [id, n] of Object.entries(r.loot)) c.cargo[id as ResourceId] = (c.cargo[id as ResourceId] ?? 0) + Math.floor((n ?? 0) * share);
      c.engaged = undefined;
      c.order = 'idle';
    }
    this.pruneCompanies();
    const names = { repelled: 'L\'assalto è stato respinto', held: 'Il borgo nemico è saccheggiato, ma il mastio resiste', sacked: 'Il castello nemico è espugnato' };
    const lootN = Object.values(r.loot).reduce((a, b) => a + (b ?? 0), 0);
    this.log(
      `${names[r.outcome]}! Caduti: ${r.attackerLosses}, nemici caduti: ${r.defenderLosses}${lootN ? `. Bottino nei carri: ${Math.round(lootN)} (riportalo al castello)` : ''}.`,
      r.outcome === 'repelled' ? 'bad' : 'good',
    );
    (this.state.campaignLog ??= []).push({ day: this.state.day, text: `Assalto: ${names[r.outcome].toLowerCase()}`, outcome: r.outcome, log: r.log });
    if (this.state.campaignLog.length > 10) this.state.campaignLog.shift();
    return true;
  }

  /**
   * Scontri in campo aperto tra reparti che si incontrano. Li calcola solo chi tiene l'orologio
   * (l'host), che applica le proprie perdite e restituisce quelle dell'avversario da inviargli.
   */
  fieldBattles(): Array<{ enemyLosses: Record<string, Force>; text: string }> {
    const out: Array<{ enemyLosses: Record<string, Force>; text: string }> = [];
    const mine = this.companies().filter((c) => !c.engaged && !c.envoy && !c.scout);
    const theirs = this.enemyCompanies.filter((c) => !c.engaged && !c.envoy && (c.owner === undefined || this.lord(c.owner)?.status === 'war'));
    const used = new Set<string>();
    for (const c of mine) {
      if (used.has(c.id)) continue;
      const foe = theirs.find((e) => !used.has(e.id) && Math.hypot(e.x - c.x, e.z - c.z) < 1.3);
      if (!foe) continue;
      const key = `${c.id}|${foe.id}`;
      if ((this.fieldCooldown.get(key) ?? -1) > this.state.day) continue;
      this.fieldCooldown.set(key, this.state.day + 1.5);
      const a = mine.filter((x) => !used.has(x.id) && Math.hypot(x.x - c.x, x.z - c.z) < 2.2);
      const b = theirs.filter((x) => !used.has(x.id) && Math.hypot(x.x - foe.x, x.z - foe.z) < 2.2);
      for (const x of [...a, ...b]) used.add(x.id);
      const pa = this.fieldStrength(a, b);
      const pb = this.fieldStrength(b, a);
      if (pa <= 0 || pb <= 0) continue;
      const winA = pa >= pb;
      const surv = Math.sqrt(Math.abs(pa * pa - pb * pb)) / Math.max(pa, pb);
      // Il vincitore perde in proporzione, lo sconfitto il 70% e le macchine
      const lossFor = (g: Company[], won: boolean) => {
        const m: Record<string, Force> = {};
        for (const x of g) {
          const q = won ? 1 - surv : 0.7;
          m[x.id] = {
            infantry: Math.round(x.troops.infantry * q),
            archers: Math.round(x.troops.archers * q),
            cavalry: Math.round(x.troops.cavalry * q),
            rams: won ? 0 : x.troops.rams,
            trebuchets: won ? 0 : x.troops.trebuchets,
          };
        }
        return m;
      };
      const mineLoss = lossFor(a, winA);
      const theirLoss = lossFor(b, !winA);
      this.commanderOutcome(a, winA, mineLoss);
      this.applyFieldLosses(mineLoss, winA ? 'Vittoria in campo aperto!' : 'Sconfitta in campo aperto: i nostri ripiegano.');
      out.push({ enemyLosses: theirLoss, text: winA ? 'Sconfitta in campo aperto: i nostri ripiegano.' : 'Vittoria in campo aperto!' });
    }
    return out;
  }

  /**
   * Forza di un gruppo in campo aperto contro un altro: formazione (attacco e tenuta), frecce
   * subite secondo la formazione nemica, cariche di cavalleria contro i quadrati, comportamento.
   */
  fieldStrength(g: Company[], foes: Company[]): number {
    const foeSoldiers = Math.max(1, foes.reduce((s, x) => s + x.troops.infantry + x.troops.archers + x.troops.cavalry, 0));
    const avg = (fn: (f: (typeof FORMATIONS)[Formation]) => number) =>
      foes.reduce((s, x) => s + fn(FORMATIONS[x.formation ?? 'line']) * (x.troops.infantry + x.troops.archers + x.troops.cavalry), 0) / foeSoldiers;
    const foeArrows = foes.length ? avg((f) => f.arrows) : 1;
    const foeVsCav = foes.length ? avg((f) => f.vsCavalry) : 1;
    let total = 0;
    const wx = weatherOf(this.state.day);
    for (const x of g) {
      const f = FORMATIONS[x.formation ?? 'line'];
      const tb = TERRAIN_BATTLE[tileAt(this.terrain, Math.floor(x.x), Math.floor(x.z)) ?? 0] ?? TERRAIN_BATTLE[0];
      // Pioggia: archi inzuppati e terreno fangoso per la cavalleria; neve: tutti più lenti e intirizziti
      const arch = wx === 'rain' ? 0.75 : 1;
      const cav = wx === 'rain' ? 0.8 : 1;
      const cold = wx === 'snow' ? 0.93 : 1;
      const atk =
        (x.troops.infantry * 3 * tb.inf + x.troops.archers * 2.5 * foeArrows * tb.arch * arch + ((x.troops.cavalry * 7) / foeVsCav) * tb.cav * cav) *
        f.attack *
        cold *
        (1 + (x.cmd?.skill ?? 0));
      const still = !x.path?.length;
      const stance = still && x.behavior === 'hold' ? 1.35 : still && x.behavior === 'defensive' ? 1.2 : 1;
      total += atk * f.defense * stance;
    }
    return total;
  }

  /** Applica perdite ai propri reparti (scontro in campo calcolato da questo o dall'altro giocatore). */
  applyFieldLosses(losses: Record<string, Force>, text?: string) {
    let dead = 0;
    for (const c of this.companies()) {
      const l = losses[c.id];
      if (!l) continue;
      for (const k of Object.keys(l) as Array<keyof Force>) {
        const n = Math.min(c.troops[k], l[k]);
        c.troops[k] -= n;
        if (k !== 'rams' && k !== 'trebuchets') dead += n;
      }
      c.path = [];
      c.order = 'idle';
    }
    this.pruneCompanies();
    if (text) {
      this.cue(text.startsWith('Vittoria') ? 'victory' : 'defeat');
      this.log(`${text} Caduti: ${dead}.`, text.startsWith('Vittoria') ? 'good' : 'bad');
    }
  }


  // ───────────── Signori rivali e diplomazia (giocatore singolo) ─────────────

  lords(): Lord[] {
    return this.state.lords ?? [];
  }

  lord(id: number): Lord | undefined {
    return this.state.lords?.find((l) => l.id === id);
  }

  /** Edifici e cantieri dei signori come "altri" sulla mappa. */
  private syncLords(force = false) {
    for (const l of this.lords()) {
      this.lordInit(l);
      const lv = this.lordLevelOf(l);
      if (lv !== l.level) {
        if (lv > l.level && l.level > 0) this.log(`🏰 ${l.name} ha ampliato ${l.castle}: castello al livello ${lv} (${CASTLE_LEVELS[lv].name}).`, 'info');
        l.level = lv;
        force = true;
      }
    }
    if (!force) return;
    for (const b of this.others) this.mark(b, 0);
    this.others = [];
    for (const l of this.lords()) {
      const busy = new Set(l.jobs!.filter((j) => j.kind !== 'build').map((j) => j.uid));
      for (const b of l.buildings) {
        const fb: PlacedBuilding = { ...b, uid: this.lordUid(l, b.uid), owner: l.id };
        if (busy.has(b.uid)) fb.site = 4;
        this.others.push(fb);
        this.mark(fb, fb.uid);
      }
      for (const j of l.jobs!) {
        if (j.kind !== 'build') continue;
        const fb: PlacedBuilding = { uid: this.lordUid(l, j.uid), defId: j.defId, x: j.x, z: j.z, upgrades: [], owner: l.id, site: Math.min(3, Math.floor((j.done / j.work) * 4)) };
        this.others.push(fb);
        this.mark(fb, fb.uid);
      }
    }
    this.changedVisual();
  }

  /** Solo per i test: costruisce subito i castelli dei signori come sarebbero nella loro epoca. */
  buildLordCastlesNow() {
    const year = this.date.year;
    for (const l of this.lords()) {
      const lv = lordLevel(year, l.personality);
      l.buildings = lordCastle(this.terrain, this.terrain.sites[l.id], lv, this.state.seed + l.id * 101);
      l.nextUid = Math.max(l.nextUid, ...l.buildings.map((b) => b.uid + 1));
      l.pop = Math.max(l.pop ?? 0, 30 + lv * 20);
      l.jobs = [];
    }
    this.syncLords(true);
  }

  // ───────────── Signori: economia e costruzioni ─────────────

  private lordUid(l: Lord, uid: number): number {
    return FOREIGN + l.id * 100000 + uid;
  }

  /** Livello del castello di un signore, dal suo mastio. */
  private lordLevelOf(l: Lord): number {
    const k = l.buildings.find((b) => getBuilding(b.defId).fort === 'keep');
    if (!k) return 0;
    const u = k.upgrades ?? [];
    if (k.defId === 'keep_wood') return u.includes('bailey') ? 2 : 1;
    return u.includes('palace') ? 5 : u.includes('great_hall') ? 4 : 3;
  }

  private lordInit(l: Lord) {
    if (!l.res) {
      // Salvataggi vecchi: il castello già costruito resta, si aggiunge l'economia
      l.res = { food: 200, wood: 200, stone: 100, lime: 20 };
      l.pop = 20 + l.level * 15;
      l.nextUid = Math.max(l.nextUid, 1, ...l.buildings.map((b) => b.uid + 1));
    }
    l.pop ??= 20;
    l.jobs ??= [];
  }

  private static readonly LORD_R = 6;
  /** Giorno fino a cui un signore non cerca nuovi lavori, e posti già cercati invano. */
  private lordIdle = new Map<number, number>();
  private lordNoSpot = new Map<string, number>();

  /** Il signore può costruire qui? (nel suo territorio, su caselle libere e adatte) */
  private lordCanPlace(l: Lord, def: BuildingDef, x: number, z: number): boolean {
    const [w, d] = def.size;
    const n = this.terrain.size;
    if (x < 1 || z < 1 || x + w >= n - 1 || z + d >= n - 1) return false;
    for (let dz = 0; dz < d; dz++) for (let dx = 0; dx < w; dx++) if (this.ownerAt(x + dx, z + dz) !== l.id) return false;
    return this.terrainCheck(def, x, z).ok;
  }

  /** Cerca un posto per un edificio: dentro la cinta (case) o fuori, a spirale. */
  private lordSpot(l: Lord, defId: string, inside: boolean): [number, number] | null {
    // Un posto cercato invano non si ricerca per un po' (la ricerca a spirale costa)
    const key = `${l.id}|${defId}|${inside}`;
    if ((this.lordNoSpot.get(key) ?? -1) > this.state.day) return null;
    const found = this.lordSpotSearch(l, defId, inside);
    if (!found) this.lordNoSpot.set(key, this.state.day + 90);
    return found;
  }

  private lordSpotSearch(l: Lord, defId: string, inside: boolean): [number, number] | null {
    const def = getBuilding(defId);
    const [cx, cz] = this.lordKeep(l);
    const R = Game.LORD_R;
    const rand = mulberry32(this.state.seed + l.id * 977 + l.nextUid * 13);
    const shuffle = <T,>(a: T[]) => {
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };
    if (inside) {
      const cands: Array<[number, number]> = [];
      for (let z = cz - R + 2; z + def.size[1] <= cz + R - 1; z += 2) {
        for (let x = cx - R + 2; x + def.size[0] <= cx + R - 1; x += 2) {
          if (x + def.size[0] > cx - 2 && x < cx + 3 && z + def.size[1] > cz - 2 && z < cz + 3) continue; // spazio attorno al mastio
          cands.push([x, z]);
        }
      }
      for (const [x, z] of shuffle(cands)) if (this.lordCanPlace(l, def, x, z)) return [x, z];
      return null;
    }
    for (let ring = R + 3; ring <= R + 26; ring++) {
      const cands: Array<[number, number]> = [];
      for (let i = -ring; i <= ring; i++) cands.push([cx + i, cz - ring], [cx + i, cz + ring], [cx - ring, cz + i], [cx + ring, cz + i]);
      for (const [x, z] of shuffle(cands)) if (this.lordCanPlace(l, def, x, z)) return [x, z];
    }
    return null;
  }

  private static readonly LORD_TIERS: Record<'wall' | 'tower' | 'gate', string[]> = {
    wall: ['palisade', 'palisade_double', 'wall_rubble', 'wall_stone', 'wall_curtain', 'wall_bastion'],
    tower: ['tower_wood', 'tower_square', 'tower_round', 'tower_bastion'],
    gate: ['gate_wood', 'gate_strong', 'gate_stone'],
  };

  private lordDefOk(l: Lord, def: BuildingDef, year: number): boolean {
    return year >= def.minYear && (def.maxYear === undefined || year < def.maxYear) && (def.minLevel ?? 0) <= l.level;
  }

  /** Il miglior tipo di mura, torre o porta che il signore sa costruire ora. */
  private lordTier(l: Lord, role: 'wall' | 'tower' | 'gate', year: number): string {
    const list = Game.LORD_TIERS[role];
    let best = list[0];
    for (const id of list) if (this.lordDefOk(l, getBuilding(id), year)) best = id;
    return best;
  }

  /** Posizioni della cinta: torri agli angoli, due porte, mura sul perimetro. */
  private lordRing(l: Lord): Array<{ role: 'wall' | 'tower' | 'gate'; x: number; z: number }> {
    const [cx, cz] = this.lordKeep(l);
    const R = Game.LORD_R;
    const out: Array<{ role: 'wall' | 'tower' | 'gate'; x: number; z: number }> = [];
    for (const [x, z] of [[cx - R - 1, cz - R - 1], [cx + R, cz - R - 1], [cx - R - 1, cz + R], [cx + R, cz + R]]) out.push({ role: 'tower', x, z });
    out.push({ role: 'gate', x: cx + R, z: cz }, { role: 'gate', x: cx - R, z: cz });
    const seen = new Set<string>();
    for (let i = -R + 1; i <= R - 1; i++) {
      for (const [x, z] of [[cx + i, cz - R], [cx + i, cz + R], [cx - R, cz + i], [cx + R, cz + i]]) {
        if (z === cz && (x === cx + R || x === cx - R)) continue;
        const k = `${x},${z}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ role: 'wall', x, z });
      }
    }
    return out;
  }

  /** Cinta chiusa: tutto il perimetro coperto da fortificazioni intatte o da acqua. */
  lordRingClosed(l: Lord): boolean {
    const [cx, cz] = this.lordKeep(l);
    const R = Game.LORD_R;
    const covered = new Set<number>();
    for (const b of l.buildings) {
      const def = getBuilding(b.defId);
      if (!def.fort || def.fort === 'moat' || (b.hp ?? 1) <= 0) continue;
      for (let dz = 0; dz < def.size[1]; dz++) for (let dx = 0; dx < def.size[0]; dx++) covered.add((b.z + dz) * this.terrain.size + b.x + dx);
    }
    for (let i = -R; i <= R; i++) {
      for (const [x, z] of [[cx + i, cz - R], [cx + i, cz + R], [cx - R, cz + i], [cx + R, cz + i]]) {
        if (!covered.has(z * this.terrain.size + x) && !isWater(tileAt(this.terrain, x, z))) return false;
      }
    }
    return true;
  }

  private lordCount(l: Lord, ...ids: string[]): number {
    return l.buildings.filter((b) => ids.includes(b.defId)).length + l.jobs!.filter((j) => j.kind === 'build' && ids.includes(j.defId)).length;
  }

  /** Quanto produce e consuma il feudo di un signore (al giorno). */
  private lordStats(l: Lord, si: number, avg = false) {
    let housing = BASE_HOUSING + CASTLE_LEVELS[l.level].housing;
    let storage = BASE_STORAGE + CASTLE_LEVELS[l.level].storage;
    let jobs = 0;
    let lodges = 0;
    for (const b of l.buildings) {
      const def = getBuilding(b.defId);
      const le = levelEffects(b.level ?? 1);
      housing += (def.housing ?? 0) * le.housing;
      storage += (def.storage ?? 0) * le.storage;
      jobs += def.workers * le.workers;
      if (def.builders) lodges++;
    }
    const soldiers = l.army.infantry + l.army.archers + l.army.cavalry;
    const builders = l.jobs!.length ? Math.max(2, Math.min(Math.floor(l.pop! * 0.3), BASE_BUILDERS + lodges * 6)) : 0;
    const staffing = jobs ? Math.min(1, Math.max(0, l.pop! - builders) / jobs) : 1;
    const prod = { food: 0, wood: 0, stone: 0, lime: 0, coins: 0 };
    const use = { food: 0, wood: 0, stone: 0, lime: 0, coins: 0 };
    const add = (o: typeof prod, id: string, v: number) => {
      if (RESOURCES[id as ResourceId]?.food) o.food += v;
      else if (id === 'wood' || id === 'stone' || id === 'lime') o[id] += v;
      else if (id === 'gold') o.coins += v * 40;
    };
    for (const b of l.buildings) {
      const def = getBuilding(b.defId);
      const k = staffing * (def.seasonal ? (avg ? def.seasonal.reduce((a, b) => a + b, 0) / 4 : def.seasonal[si]) : 1) * levelEffects(b.level ?? 1).production;
      const lfx = factionEffects(l.faction).produce ?? {};
      for (const [id, v] of Object.entries(def.produces ?? {})) add(prod, id, (v ?? 0) * k * (lfx[id as ResourceId] ?? 1));
      for (const [id, v] of Object.entries(def.consumes ?? {})) add(use, id, (v ?? 0) * k);
      if (def.herd) prod.food += 0.8;
    }
    // Senza una cava (niente roccia nei dintorni) la pietra si compra dai mercanti: un rivolo costante
    if (!l.buildings.some((b) => b.defId === 'quarry')) prod.stone += 0.3;
    use.food += l.pop! * FOOD_PER_PERSON + soldiers * SOLDIER_FOOD + builders * BUILDER_FOOD;
    return { housing, storage, builders, lodges, prod, use, soldiers };
  }

  /** Un giorno di economia del signore: produzione, cibo, tasse, popolazione, esercito. */
  private lordEconomy(l: Lord, year: number, si: number) {
    const r = l.res!;
    const p = PERSONALITIES[l.personality];
    const st = this.lordStats(l, si);
    // Produzione (le fornaci consumano pietra e legna solo se ci sono)
    const conv = Math.min(1, st.use.stone ? r.stone / st.use.stone : 1, st.use.wood ? (r.wood + st.prod.wood) / st.use.wood : 1);
    r.wood += st.prod.wood - st.use.wood * conv;
    r.stone += st.prod.stone - st.use.stone * conv;
    r.lime += st.prod.lime * conv;
    l.wealth += st.prod.coins + l.pop! * TAX_PER_PERSON * 1.1 * (factionEffects(l.faction).taxes ?? 1) - st.soldiers * 0.12 - st.builders * BUILDER_WAGE;
    if (l.wealth < 0) {
      l.wealth = 0;
      for (const k of ['infantry', 'archers', 'cavalry'] as const) l.army[k] *= 0.99;
    }
    // Cibo e popolazione (assediato da noi: i campi fuori dalle mura non rendono)
    const blockaded = this.state.offense?.lord === l.id;
    r.food += st.prod.food * (blockaded ? 0.15 : 1);
    const fed = st.use.food > 0 ? Math.min(1, r.food / st.use.food) : 1;
    r.food = Math.max(0, r.food - st.use.food);
    if (fed > 0.95 && l.pop! < st.housing) l.pop! += 0.006 + l.pop! * 0.00013; // come la nostra gente
    else if (fed < 0.8) l.pop! = Math.max(5, l.pop! - l.pop! * 0.012 * (1 - fed));
    l.pop! = Math.min(l.pop!, st.housing + 2);
    for (const k of ['food', 'wood', 'stone', 'lime'] as const) r[k] = Math.max(0, Math.min(st.storage, r[k]));
    l.wealth = Math.min(l.wealth, 4000 + l.level * 2000);
    // Arruolamento: costa monete e uomini
    // ...ma solo quanti ne può pagare con le tasse (più i bellicosi)
    const taxes = l.pop! * TAX_PER_PERSON * 1.1;
    const target = Math.min((3 + l.level * 8 + l.pop! * 0.12 + (year - 900) / 15) * p.army, (taxes * 0.45 * p.army) / 0.12 + 3);
    const total = st.soldiers;
    if (total < target && l.wealth > 80 + this.lordSaving(l) && l.pop! > 15 && fed > 0.8) {
      const add = Math.min(Math.max(0.05, (target - total) * 0.02), l.wealth / 12);
      l.army.infantry += add * 0.6;
      l.army.archers += add * 0.28;
      l.army.cavalry += add * 0.12;
      l.wealth -= add * 12;
      l.pop! -= add;
    }
    // Riparazioni dopo gli assedi
    for (const b of l.buildings) {
      const max = this.maxHp(b);
      if (max && (b.hp ?? max) < max && l.wealth > 5) {
        b.hp = Math.min(max, (b.hp ?? max) + max * 0.03);
        l.wealth -= 1;
      }
    }
    return { fed, builders: st.builders };
  }

  /** Monete da tenere da parte per il prossimo passo del castello (se il signore è pronto a farlo). */
  private lordSaving(l: Lord): number {
    const keep = l.buildings.find((b) => getBuilding(b.defId).fort === 'keep');
    if (!keep || l.jobs!.some((j) => j.uid === keep.uid)) return 0;
    const year = this.date.year;
    const pop = l.pop ?? 0;
    const u = keep.upgrades ?? [];
    if (keep.defId === 'keep_wood' && !u.includes('bailey') && pop >= 25) return UPGRADE_BY_ID.bailey.cost.coins ?? 0;
    if (keep.defId === 'keep_wood' && year >= KEEP_EVOLVE.minYear && pop >= KEEP_EVOLVE.minPop) return KEEP_EVOLVE.cost.coins ?? 0;
    if (keep.defId === 'keep_stone' && !u.includes('great_hall') && year >= 1150 && pop >= 60) return UPGRADE_BY_ID.great_hall.cost.coins ?? 0;
    if (keep.defId === 'keep_stone' && !u.includes('palace') && u.includes('great_hall') && year >= 1250 && pop >= 95) return UPGRADE_BY_ID.palace.cost.coins ?? 0;
    return 0;
  }

  /** Paga un costo con le scorte, comprando al mercato (a caro prezzo) quel che manca. */
  private lordPay(l: Lord, cost: Cost, dry = false, reserve = 20): boolean {
    const r = l.res!;
    let coins = cost.coins ?? 0;
    const take: Partial<Record<'wood' | 'stone' | 'lime', number>> = {};
    // Chi ha le casse piene compra i materiali che gli mancano a prezzo meno caro
    const prem = l.wealth > 2500 ? 1.6 : 2.5;
    for (const [id, n] of Object.entries(cost)) {
      const need = n ?? 0;
      if (id === 'coins') continue;
      if (id === 'wood' || id === 'stone' || id === 'lime') {
        const have = Math.min(r[id], need);
        take[id] = have;
        coins += (need - have) * RESOURCES[id].basePrice * prem;
      } else coins += need * RESOURCES[id as ResourceId].basePrice * prem;
    }
    // Tiene sempre una piccola riserva di monete
    if (coins > 0 && l.wealth - coins < reserve) return false;
    if (dry) return true;
    l.wealth -= coins;
    for (const [id, n] of Object.entries(take)) r[id as 'wood'] -= n ?? 0;
    return true;
  }

  /** Il prossimo lavoro che il signore vuole avviare, in ordine di urgenza. */
  private lordNextAction(l: Lord, year: number, si: number): { job: Omit<LordJob, 'done'>; cost: Cost } | null {
    const lv = l.level;
    const [cx, cz] = this.lordKeep(l);
    const pop = l.pop!;
    const st = this.lordStats(l, si, true);
    const busy = new Set(l.jobs!.map((j) => j.uid));
    const build = (defId: string, at: [number, number] | null) => {
      if (!at) return null;
      const def = getBuilding(defId);
      return { job: { kind: 'build' as const, uid: l.nextUid, defId, x: at[0], z: at[1], work: this.buildWork(def) }, cost: escalatedCost(def, this.lordCount(l, defId)) };
    };
    const keep = l.buildings.find((b) => getBuilding(b.defId).fort === 'keep');
    const keepJob = l.jobs!.find((j) => j.kind === 'build' && getBuilding(j.defId).fort === 'keep');
    const hungry = l.res!.food < st.use.food * 40;
    const farms = this.lordCount(l, 'field_grain', 'field_vegetables', 'fisher');
    // 0. Con le scorte basse si semina prima di tutto
    if (hungry && farms < 4) {
      const id = farms % 3 === 2 ? 'field_vegetables' : 'field_grain';
      const a = build(id, this.lordSpot(l, id, false));
      if (a) return a;
    }
    // 1. Il mastio
    if (!keep && !keepJob) {
      const id = year < 1150 ? 'keep_wood' : 'keep_stone';
      const def = getBuilding(id);
      return build(id, this.lordCanPlace(l, def, cx - 1, cz - 1) ? [cx - 1, cz - 1] : this.lordSpot(l, id, true));
    }
    // 2. Cibo
    // Cibo: produzione media dell'anno con margine per l'inverno (e scorte basse = urgenza)
    if ((st.prod.food < st.use.food * 1.5 || l.res!.food < st.use.food * 60) && this.lordCount(l, 'field_grain', 'field_vegetables', 'fisher') < 12 + lv * 5) {
      const fields = this.lordCount(l, 'field_grain', 'field_vegetables');
      if (fields >= 3 && this.lordCount(l, 'fisher') < 1) {
        const a = build('fisher', this.lordSpot(l, 'fisher', false));
        if (a) return a;
      }
      const id = fields % 3 === 2 ? 'field_vegetables' : 'field_grain';
      const a = build(id, this.lordSpot(l, id, false));
      if (a) return a;
    }
    // 3. Case
    if (st.housing < pop + 4 && this.lordCount(l, 'hut', 'house') < 20 + lv * 6) {
      const id = year >= 1150 ? 'house' : 'hut';
      const a = build(id, this.lordSpot(l, id, true)) ?? build(id, this.lordSpot(l, id, false));
      if (a) return a;
    }
    // 4. Legna
    if (this.lordCount(l, 'woodcutter') < 1 + Math.floor(lv / 2)) {
      const a = build('woodcutter', this.lordSpot(l, 'woodcutter', false));
      if (a) return a;
    }
    if (!keep) return null;
    // 5. Pietra e calce prima delle opere in muratura
    if (year >= 950 && this.lordCount(l, 'quarry') < 1) {
      const a = build('quarry', this.lordSpot(l, 'quarry', false));
      if (a) return a;
    }
    if (year >= 1000 && lv >= 2 && this.lordCount(l, 'lime_kiln') < 1) {
      const a = build('lime_kiln', this.lordSpot(l, 'lime_kiln', false));
      if (a) return a;
    }
    // La cinta: torri, porte, poi mura
    for (const role of ['tower', 'gate', 'wall'] as const) {
      for (const pos of this.lordRing(l)) {
        if (pos.role !== role) continue;
        const id = this.lordTier(l, role, year);
        if (this.lordCanPlace(l, getBuilding(id), pos.x, pos.z)) return build(id, [pos.x, pos.z]);
      }
    }
    // 6. Pietra, calce, costruttori
    if (year >= 950 && this.lordCount(l, 'quarry') < 1 + (lv >= 3 ? 1 : 0)) {
      const a = build('quarry', this.lordSpot(l, 'quarry', false));
      if (a) return a;
    }
    if (year >= 1000 && lv >= 2 && this.lordCount(l, 'lime_kiln') < (lv >= 3 ? 2 : 1)) {
      const a = build('lime_kiln', this.lordSpot(l, 'lime_kiln', false));
      if (a) return a;
    }
    if (pop >= 30 && this.lordCount(l, 'mason_lodge') < (lv >= 4 ? 2 : 1)) {
      const a = build('mason_lodge', this.lordSpot(l, 'mason_lodge', true) ?? this.lordSpot(l, 'mason_lodge', false));
      if (a) return a;
    }
    // 7. Evoluzione del castello
    if (!busy.has(keep.uid)) {
      const u = keep.upgrades ?? [];
      const up = (upId: string) => ({ job: { kind: 'upgrade' as const, uid: keep.uid, defId: keep.defId, x: keep.x, z: keep.z, upId, work: Game.workFor(UPGRADE_BY_ID[upId].cost) }, cost: UPGRADE_BY_ID[upId].cost });
      if (keep.defId === 'keep_wood' && !u.includes('bailey') && pop >= 25) return up('bailey');
      if (keep.defId === 'keep_wood' && u.includes('bailey') && year >= KEEP_EVOLVE.minYear && pop >= KEEP_EVOLVE.minPop) {
        return { job: { kind: 'evolve', uid: keep.uid, defId: keep.defId, x: keep.x, z: keep.z, to: 'keep_stone', work: Math.round(this.buildWork(getBuilding('keep_stone')) * 0.8) }, cost: KEEP_EVOLVE.cost };
      }
      if (keep.defId === 'keep_stone' && !u.includes('great_hall') && year >= 1150 && pop >= 70) return up('great_hall');
      if (keep.defId === 'keep_stone' && u.includes('great_hall') && !u.includes('palace') && year >= 1250 && pop >= 110) return up('palace');
    }
    // 8. Le fortificazioni evolvono (prima torri e porte)
    const ring = l.buildings.filter((b) => {
      const f = getBuilding(b.defId).fort;
      return (f === 'wall' || f === 'tower' || f === 'gate') && !busy.has(b.uid);
    });
    ring.sort((a, b) => (getBuilding(a.defId).fort === 'wall' ? 1 : 0) - (getBuilding(b.defId).fort === 'wall' ? 1 : 0));
    for (const b of ring) {
      const to = getBuilding(b.defId).evolvesTo;
      if (!to || !this.lordDefOk(l, getBuilding(to), year)) continue;
      const toDef = getBuilding(to);
      const cost: Cost = {};
      for (const [id, n] of Object.entries(toDef.cost)) cost[id as ResourceId] = Math.ceil((n ?? 0) * 0.85);
      return { job: { kind: 'evolve', uid: b.uid, defId: b.defId, x: b.x, z: b.z, to, work: Math.round(this.buildWork(toDef) * 0.8 * 10) / 10 }, cost };
    }
    // 9. Miglioramenti delle fortificazioni
    if (lv >= 2) {
      const prefs = ['earthbank', 'walkway', 'hoarding', 'portcullis', 'machicolation', 'thicken', 'tower_roof', 'hoarding_wall', 'cistern', 'armory'];
      for (const upId of prefs) {
        const u = UPGRADE_BY_ID[upId];
        if (year < u.minYear || (u.minPop && pop < u.minPop)) continue;
        for (const b of [...ring, keep]) {
          if (busy.has(b.uid) || !upgradesFor(b.defId).some((x) => x.id === upId) || b.upgrades?.includes(upId)) continue;
          if (u.requires && !b.upgrades?.includes(u.requires) && !getBuilding(b.defId).builtIn?.includes(u.requires)) continue;
          return { job: { kind: 'upgrade', uid: b.uid, defId: b.defId, x: b.x, z: b.z, upId, work: Game.workFor(u.cost) }, cost: u.cost };
        }
      }
    }
    // 10. Magazzini
    if (this.lordCount(l, 'granary') < Math.floor(lv / 2)) {
      const a = build('granary', this.lordSpot(l, 'granary', true) ?? this.lordSpot(l, 'granary', false));
      if (a) return a;
    }
    // 10b. Sviluppo: botteghe, allevamento, mercato, caserme e avvistamento man mano che il feudo cresce
    const wealthy = l.wealth > 150;
    const growth: Array<[string, number, boolean]> = [
      ['woodcutter', 1 + Math.floor(pop / 25), false],
      ['quarry', year >= 950 ? 1 + Math.floor(pop / 40) : 0, false],
      ['pasture_cattle', pop >= 20 ? 1 + Math.floor(lv / 2) : 0, false],
      ['hay_meadow', pop >= 24 ? 1 + Math.floor(lv / 2) : 0, false],
      ['hunter', pop >= 24 ? 1 : 0, false],
      ['dairy', this.lordCount(l, 'pasture_cattle') ? 1 : 0, true],
      ['smithy', lv >= 2 && pop >= 35 ? 1 : 0, true],
      ['market', lv >= 2 && pop >= 40 ? 1 : 0, true],
      ['barracks', lv >= 2 && pop >= 35 ? 1 + Math.floor(lv / 3) : 0, true],
      ['watchtower', lv >= 2 ? 1 + Math.floor(lv / 2) : 0, false],
      ['pasture_pigs', lv >= 2 && pop >= 45 ? 1 : 0, false],
      ['weaver', year >= 1000 && lv >= 2 && pop >= 50 ? 1 : 0, true],
      ['archery', lv >= 2 && pop >= 50 ? 1 : 0, true],
      ['stable', lv >= 3 && pop >= 70 ? 1 : 0, true],
      ['field_grain', pop >= 30 ? Math.floor(pop / 5) : 0, false],
      ['hut', Math.floor(pop / 2.2), true],
    ];
    if (wealthy) {
      for (const [id, target, inside] of growth) {
        if (!this.lordDefOk(l, getBuilding(id), year) || this.lordCount(l, id) >= target) continue;
        const a = build(id, inside ? this.lordSpot(l, id, true) ?? this.lordSpot(l, id, false) : this.lordSpot(l, id, false));
        if (a) return a;
      }
    }
    // 11. Migliora gli edifici civili, prima i più indietro (campi e case per primi)
    const cap = maxLevelFor(year);
    const civil = l.buildings
      .filter((b) => isLevelable(getBuilding(b.defId)) && (b.level ?? 1) < cap && !busy.has(b.uid))
      .sort((a, b) => (a.level ?? 1) - (b.level ?? 1) || (/field|hut|house/.test(b.defId) ? 1 : 0) - (/field|hut|house/.test(a.defId) ? 1 : 0));
    const b = civil[0];
    if (b) {
      const cost = levelUpCost(getBuilding(b.defId), b.level ?? 1);
      return { job: { kind: 'level', uid: b.uid, defId: b.defId, x: b.x, z: b.z, work: Game.workFor(cost) }, cost };
    }
    return null;
  }

  /** Un giorno di lavori del signore: avvia nuovi cantieri e fa avanzare quelli aperti. */
  private lordWorks(l: Lord, year: number, si: number, fed: number, builders: number): boolean {
    let dirty = false;
    // Nuovi lavori finché i costruttori non sono tutti impegnati
    let demand = l.jobs!.reduce((sum, j) => sum + this.crewCap(j.defId), 0);
    const want = Math.max(builders, 3);
    for (let i = 0; i < 4 && demand < want && (this.lordIdle.get(l.id) ?? -1) <= this.state.day; i++) {
      const a = this.lordNextAction(l, year, si);
      // I lavori del mastio usano i risparmi, gli altri no
      const castleStep = !!a && a.job.uid === l.buildings.find((b) => getBuilding(b.defId).fort === 'keep')?.uid;
      if (!a || !this.lordPay(l, a.cost, false, castleStep ? 20 : 20 + this.lordSaving(l))) {
        // Niente da fare o mancano i mezzi: riprova fra qualche giorno
        this.lordIdle.set(l.id, this.state.day + (a ? 3 : 10));
        break;
      }
      const job: LordJob = { ...a.job, done: 0 };
      if (job.kind === 'build') {
        l.nextUid++;
        // Segna subito il terreno, così il prossimo lavoro non lo sceglie di nuovo
        const fb: PlacedBuilding = { uid: this.lordUid(l, job.uid), defId: job.defId, x: job.x, z: job.z, upgrades: [], owner: l.id, site: 0 };
        this.mark(fb, fb.uid);
      }
      l.jobs!.push(job);
      demand += this.crewCap(job.defId);
      dirty = true;
    }
    // Avanzamento
    let free = builders;
    const finished: LordJob[] = [];
    for (const j of l.jobs!) {
      if (free <= 0) break;
      const crew = Math.min(free, this.crewCap(j.defId));
      free -= crew;
      const def = getBuilding(j.to ?? j.defId);
      const cost = j.upId ? UPGRADE_BY_ID[j.upId].cost : def.cost;
      const stone = (cost.stone ?? 0) + (cost.lime ?? 0) > 0;
      const rate = (0.3 + 0.7 * fed) * (si === 3 ? (stone ? 0.35 : 0.75) : 1);
      const before = Math.floor((j.done / j.work) * 4);
      j.done += crew * rate;
      if (j.done >= j.work) finished.push(j);
      else if (j.kind === 'build' && Math.floor((j.done / j.work) * 4) !== before) dirty = true;
    }
    for (const j of finished) {
      l.jobs = l.jobs!.filter((x) => x !== j);
      dirty = true;
      if (j.kind === 'build') {
        const def = getBuilding(j.defId);
        l.buildings.push({ uid: j.uid, defId: j.defId, x: j.x, z: j.z, upgrades: [], ...(def.hp ? { hp: def.hp } : {}) });
        continue;
      }
      const b = l.buildings.find((x) => x.uid === j.uid);
      if (!b) continue;
      if (j.kind === 'level') b.level = (b.level ?? 1) + 1;
      else if (j.kind === 'upgrade' && j.upId && !b.upgrades?.includes(j.upId)) {
        const before = this.maxHp(b);
        b.upgrades = [...(b.upgrades ?? []), j.upId];
        if (before) b.hp = (b.hp ?? before) + (this.maxHp(b) - before);
      } else if (j.kind === 'evolve' && j.to) {
        const to = getBuilding(j.to);
        b.defId = j.to;
        b.upgrades = (b.upgrades ?? []).filter((u) => UPGRADE_BY_ID[u]?.appliesTo.includes(j.to!) && !to.builtIn?.includes(u));
        b.hp = this.maxHp(b);
      }
    }
    return dirty;
  }

  /** Cosa sta costruendo un signore (per l'interfaccia). */
  lordActivity(l: Lord): string[] {
    return (l.jobs ?? []).map((j) => {
      const name = getBuilding(j.defId).name;
      if (j.kind === 'build') return name;
      if (j.kind === 'upgrade') return `${UPGRADE_BY_ID[j.upId ?? '']?.name ?? ''} (${name})`;
      if (j.kind === 'level') return `${name} (livello)`;
      return `${name} → ${getBuilding(j.to ?? j.defId).name}`;
    });
  }

  /** Il castello di un signore (il suo mastio). */
  lordKeep(l: Lord): [number, number] {
    return this.terrain.sites[l.id];
  }

  lordPower(l: Lord): number {
    return l.army.infantry * 4 + l.army.archers * 3 + l.army.cavalry * 7 + l.level * 25;
  }

  myPower(): number {
    return this.armyPower() + this.fortDefense() + (this.state.companies ?? []).reduce((s, c) => s + c.troops.infantry * 4 + c.troops.archers * 3 + c.troops.cavalry * 7, 0);
  }

  private declareWar(l: Lord, why: string) {
    if (l.status === 'war') return;
    const wasAlly = l.status === 'alliance' || l.status === 'pact';
    l.status = 'war';
    l.relation = Math.min(l.relation, -60);
    this.log(`⚔️ Guerra con ${l.name} di ${l.castle}! ${why}.`, 'bad');
    this.remember(l, wasAlly ? 'Ha tradito un patto con lui' : `Guerra: ${why.toLowerCase()}`, wasAlly ? -25 : -10);
    // Tradire un patto rovina la reputazione presso gli altri signori
    if (wasAlly) for (const o of this.lords()) if (o !== l) o.relation -= 15;
  }

  /** Alleati che mandano rinforzi quando il castello è assediato. */
  private withAllies(t: { infantry: number; archers: number; cavalry: number }) {
    const out = { ...t };
    for (const l of this.lords()) {
      if (l.status !== 'alliance') continue;
      out.infantry += Math.floor(l.army.infantry * 0.25);
      out.archers += Math.floor(l.army.archers * 0.25);
      out.cavalry += Math.floor(l.army.cavalry * 0.25);
    }
    return out;
  }

  private lordDay = -1;

  private stepLords(dt: number) {
    const s = this.state;
    const today = Math.floor(s.day);
    // Movimento dei loro eserciti a ogni passo
    for (const l of this.lords()) this.stepLordCompanies(l, dt);
    this.enemyCompanies = this.lords().flatMap((l) => l.companies.map((c) => ({ ...c, owner: l.id })));
    // Scontri in campo aperto con i nostri reparti
    for (const f of this.fieldBattles()) {
      for (const l of this.lords()) {
        for (const c of l.companies) {
          const loss = f.enemyLosses[c.id];
          if (!loss) continue;
          for (const k of Object.keys(loss) as Array<keyof Force>) c.troops[k] = Math.max(0, c.troops[k] - loss[k]);
          c.path = [];
        }
        l.companies = l.companies.filter((c) => c.troops.infantry + c.troops.archers + c.troops.cavalry > 0);
      }
    }
    if (today === this.lordDay) return;
    this.lordDay = today;
    this.syncLords();
    const year = this.date.year;
    const si = seasonIndex(this.date.season);
    let dirty = false;
    for (const l of this.lords()) {
      const p = PERSONALITIES[l.personality];
      // Il signore lavora come noi: produce, mangia, arruola e costruisce
      const eco = this.lordEconomy(l, year, si);
      if (!this.locked && this.lordWorks(l, year, si, eco.fed, eco.builders)) dirty = true;
      // Il rapporto torna lentamente verso il carattere del signore
      const base = (l.status === 'alliance' ? Math.max(p.base, 40) : l.status === 'war' ? Math.min(p.base, -40) : p.base) + this.memoryBias(l);
      l.relation += Math.sign(base - l.relation) * Math.min(Math.abs(base - l.relation), 0.08);
      l.relation = Math.max(-100, Math.min(100, l.relation));
      // Cambi di stato
      if (l.status !== 'war' && l.relation <= -60) this.declareWar(l, 'I rapporti sono precipitati');
      if (l.status === 'vassal') {
        const tribute = 1 + l.level;
        this.track('Tributi dei vassalli', () => (s.resources.coins += tribute));
        l.wealth = Math.max(0, l.wealth - tribute);
        if (l.relation < -80) {
          this.declareWar(l, 'Si è ribellato al tributo');
        }
      }
      // Intrighi e diplomazia tra i signori (e verso di noi)
      if (!this.locked && s.day >= (l.nextIntrigue ?? 0)) {
        l.nextIntrigue = s.day + 50 + this.random() * 70;
        this.intrigue(l);
      }
      // Decisioni periodiche
      if (s.day < l.nextAction || this.locked) continue;
      l.nextAction = s.day + 200 + this.random() * 400;
      const strong = this.lordPower(l) > this.myPower() * (l.personality === 'aggressive' ? 0.7 : 1.1);
      if (l.status === 'war' || (l.status === 'neutral' && l.personality === 'aggressive' && strong && l.relation < -20 && this.random() < 0.5)) {
        if (l.status !== 'war') this.declareWar(l, 'Ha scelto la via delle armi');
        this.launchLordRaid(l);
      } else if (l.status === 'alliance' && this.random() < 0.6) {
        const gift = Math.round(40 + l.level * 30);
        this.track('Doni degli alleati', () => (s.resources.coins += gift), 'event');
        l.wealth = Math.max(0, l.wealth - gift);
        this.log(`🎁 ${l.name}, nostro alleato, ci manda ${gift} monete.`, 'good');
      } else if (l.personality === 'greedy' && l.status === 'neutral' && strong && this.random() < 0.4) {
        l.relation -= 10;
        this.log(`💰 ${l.name} pretende un tributo e minaccia guerra: mandagli un diplomatico con un dono.`, 'bad');
      }
    }
    if (dirty) this.syncLords(true);
    this.watchtowerSkirmishes();
    this.expireProposals();
  }

  private launchLordRaid(l: Lord, targetLord?: number) {
    if (l.companies.length) return;
    const k = 0.55;
    const troops: Force = {
      infantry: Math.floor(l.army.infantry * k),
      archers: Math.floor(l.army.archers * k),
      cavalry: Math.floor(l.army.cavalry * k),
      rams: l.level >= 3 ? 1 + Math.floor(l.level / 3) : 0,
      trebuchets: l.level >= 4 ? 1 : 0,
    };
    if (troops.infantry + troops.archers + troops.cavalry < 3) return;
    l.army.infantry -= troops.infantry;
    l.army.archers -= troops.archers;
    l.army.cavalry -= troops.cavalry;
    const [sx, sz] = this.lordKeep(l);
    const c: Company = { id: `l${l.id}-${l.nextUid++}`, troops, x: sx + 0.5, z: sz + 4.5, order: 'attack', formation: 'line', behavior: 'aggressive' };
    const n = troops.infantry + troops.archers + troops.cavalry;
    const foe = targetLord !== undefined ? this.lord(targetLord) : undefined;
    if (foe) {
      // Contro un altro signore: si ferma davanti alle sue mura, poi assalta
      const [tx, tz] = this.lordKeep(foe);
      const d = Math.hypot(sx - tx, sz - tz) || 1;
      const ax = Math.round(tx + ((sx - tx) / d) * 9);
      const az = Math.round(tz + ((sz - tz) / d) * 9);
      c.targetLord = foe.id;
      c.path = findPath(this.terrain.size, [Math.floor(c.x), Math.floor(c.z)], [ax, az], (x, z) => this.lordMoveCost(x, z));
      l.companies.push(c);
      this.news(`${l.name} marcia con ${n} soldati contro ${foe.castle}, il castello di ${foe.name}.`);
      return;
    }
    const [kx, kz] = this.keepCenter();
    c.path = findPath(this.terrain.size, [Math.floor(c.x), Math.floor(c.z)], [Math.floor(kx), Math.floor(kz)], (x, z) => this.lordMoveCost(x, z));
    l.companies.push(c);
    this.cue('horn');
    this.log(`⚔️ ${l.name} marcia contro di noi con ${n} soldati${troops.rams + troops.trebuchets ? ' e macchine d\'assedio' : ''}!`, 'bad');
  }

  /** Costo di movimento per gli eserciti dei signori: le nostre mura li fermano. */
  private lordMoveCost(x: number, z: number): number {
    const t = tileAt(this.terrain, x, z);
    if (t === undefined) return Infinity;
    const b = this.buildingAt(x, z);
    if (b) {
      const def = getBuilding(b.defId);
      if (def.road) return 0.65;
      if (def.fort && def.fort !== 'moat') return this.isForeign(b) && def.fort === 'gate' ? 0.8 : this.hpState(b) === 'ruin' ? 1.6 : Infinity;
      if (def.fort === 'moat') return 3;
      return 1.2;
    }
    if (t === Tile.Sea) return Infinity;
    if (t === Tile.River) return 10;
    return t === Tile.Forest ? 2.2 : t === Tile.Rock || t === Tile.Gold ? 1.4 : 1;
  }

  /** Muove un reparto di un signore lungo il suo percorso. */
  private moveLordCompany(c: Company, dt: number) {
    let budget = this.companySpeed(c) * dt;
    while (budget > 1e-6 && c.path?.length) {
      const [nx, nz] = c.path[0];
      const dx = nx + 0.5 - c.x;
      const dz = nz + 0.5 - c.z;
      const d = Math.hypot(dx, dz);
      const cost = this.lordMoveCost(nx, nz);
      if (!isFinite(cost)) {
        c.path = [];
        break;
      }
      const step = budget / cost;
      if (step >= d) {
        c.x = nx + 0.5;
        c.z = nz + 0.5;
        c.path.shift();
        budget -= d * cost;
      } else {
        c.x += (dx / d) * step;
        c.z += (dz / d) * step;
        budget = 0;
      }
      if (d > 1e-6) c.heading = Math.atan2(-dz, dx);
    }
  }

  /** Un signore assalta il castello di un altro signore. */
  private lordVsLord(l: Lord, c: Company) {
    const foe = this.lord(c.targetLord!);
    c.targetLord = undefined;
    c.order = 'home';
    const [sx, sz] = this.lordKeep(l);
    c.path = findPath(this.terrain.size, [Math.floor(c.x), Math.floor(c.z)], [sx, sz + 4], (x, z) => this.lordMoveCost(x, z));
    if (!foe || !(l.foes ?? []).includes(foe.id)) return;
    const army: AttackerArmy = { name: `L'esercito di ${l.name}`, ...c.troops, morale: l.personality === 'aggressive' ? 0.65 : 0.55 };
    const res = resolveSiege(this.lordDefense(foe), army, this.random);
    for (const [uid, hp] of res.damage) {
      const b = foe.buildings.find((x) => x.uid === uid);
      if (b) b.hp = Math.max(0, Math.round(hp));
    }
    for (const k of ['infantry', 'archers', 'cavalry'] as const) {
      foe.army[k] = Math.max(0, foe.army[k] - res.defenderLosses[k]);
      c.troops[k] = Math.max(0, c.troops[k] - res.attackerLosses[k]);
    }
    if (res.outcome === 'repelled') {
      this.news(`${foe.name} ha respinto l'assalto di ${l.name} a ${foe.castle}.`);
    } else {
      const share = res.outcome === 'sacked' ? 0.4 : 0.15;
      const coins = Math.floor(foe.wealth * share);
      foe.wealth -= coins;
      l.wealth += coins;
      if (res.outcome === 'sacked') {
        // Il vinto diventa vassallo e la guerra finisce
        foe.liege = l.id;
        this.makePeace(l, foe);
        this.news(`${l.name} ha espugnato ${foe.castle}: ${foe.name} ora è suo vassallo!`);
      } else this.news(`${l.name} ha saccheggiato il borgo di ${foe.castle}, ma il mastio di ${foe.name} resiste.`);
    }
    this.syncLords(true);
  }

  private stepLordCompanies(l: Lord, dt: number) {
    for (const c of [...l.companies]) {
      if (c.order === 'siege') continue; // accampati: l'assedio decide
      if (c.order === 'attack' && c.targetLord !== undefined) {
        this.moveLordCompany(c, dt);
        if (!c.path?.length) this.lordVsLord(l, c);
        continue;
      }
      let budget = this.companySpeed(c) * dt;
      while (budget > 1e-6 && c.path?.length) {
        const [nx, nz] = c.path[0];
        const dx = nx + 0.5 - c.x;
        const dz = nz + 0.5 - c.z;
        const d = Math.hypot(dx, dz);
        const cost = this.lordMoveCost(nx, nz);
        if (!isFinite(cost)) {
          c.path = [];
          break;
        }
        const step = budget / cost;
        if (step >= d) {
          c.x = nx + 0.5;
          c.z = nz + 0.5;
          c.path.shift();
          budget -= d * cost;
        } else {
          c.x += (dx / d) * step;
          c.z += (dz / d) * step;
          budget = 0;
        }
        if (d > 1e-6) c.heading = Math.atan2(-dz, dx);
      }
      if (c.order === 'attack') {
        // Arrivati alle nostre mura (o alla fine del percorso): assedio
        const [kx, kz] = this.keepCenter();
        const nearWalls = this.state.buildings.some((b) => {
          const def = getBuilding(b.defId);
          if (!def.fort || def.fort === 'moat') return false;
          return Math.hypot(b.x + def.size[0] / 2 - c.x, b.z + def.size[1] / 2 - c.z) < 2.6;
        });
        const atKeep = Math.hypot(kx - c.x, kz - c.z) < 4;
        if (!nearWalls && !atKeep && !c.path?.length) {
          // Non riesce ad arrivare: rinuncia e torna
          c.order = 'home';
          const [sx, sz] = this.lordKeep(l);
          c.path = findPath(this.terrain.size, [Math.floor(c.x), Math.floor(c.z)], [sx, sz + 4], (x, z) => this.lordMoveCost(x, z));
        } else if (nearWalls || atKeep) {
          if (this.state.siege) {
            // C'è già un assedio: si unisce al campo
            const sg = this.state.siege;
            for (const k of Object.keys(sg.troops) as Array<keyof Force>) sg.troops[k] += c.troops[k];
            l.companies = l.companies.filter((x) => x !== c);
            continue;
          }
          // Non attacca subito: si accampa e comincia l'assedio
          c.order = 'siege';
          c.path = [];
          this.startSiege(`L'esercito di ${l.name}`, c.troops, [Math.floor(c.x), Math.floor(c.z)], l.personality === 'aggressive' ? 0.75 : 0.65, l.id, c.id);
          const [cx, cz] = this.state.siege!.camp;
          c.x = cx + 0.5;
          c.z = cz + 0.5;
          c.troops = this.state.siege!.troops;
        }
      } else if (c.order === 'home' && !c.path?.length) {
        l.army.infantry += c.troops.infantry;
        l.army.archers += c.troops.archers;
        l.army.cavalry += c.troops.cavalry;
        l.companies = l.companies.filter((x) => x !== c);
      }
      if (c.troops.infantry + c.troops.archers + c.troops.cavalry <= 0) l.companies = l.companies.filter((x) => x !== c);
    }
  }

  /** I nostri reparti assaltano il castello di un signore: l'assedio si risolve subito. */
  private nearestLord(x: number, z: number): Lord | undefined {
    let lord: Lord | undefined;
    let bd = Infinity;
    for (const l of this.lords()) {
      const [kx, kz] = this.lordKeep(l);
      const d = Math.hypot(kx - x, kz - z);
      if (d < bd) {
        bd = d;
        lord = l;
      }
    }
    return lord;
  }

  /** Le difese del castello di un signore, per un assalto. */
  private lordDefense(lord: Lord, extra: { ladders?: number; starving?: number } = {}): DefenderSnapshot {
    const segments: SiegeSegment[] = [];
    for (const b of lord.buildings) {
      const def = getBuilding(b.defId);
      if (!def.fort || def.fort === 'moat') continue;
      const max = this.maxHp(b);
      segments.push({ uid: b.uid, defId: b.defId, role: def.fort, hp: b.hp ?? max, maxHp: max, upgrades: [...(def.builtIn ?? []), ...(b.upgrades ?? [])], defense: def.defense ?? 0 });
    }
    return {
      segments,
      closed: this.lordRingClosed(lord),
      moat: { tiles: 0, coverage: 0, depth: 1, flooded: 0, stakes: 0 },
      army: { infantry: Math.round(lord.army.infantry), archers: Math.round(lord.army.archers), cavalry: Math.round(lord.army.cavalry) },
      armory: lord.level >= 4,
      cistern: lord.level >= 3,
      charcoal: lord.level >= 3 ? 20 : 0,
      ladders: extra.ladders,
      starving: extra.starving,
    };
  }

  private assaultLord(lead: Company, a: IncomingAttack, extra: { ladders?: number; starving?: number } = {}) {
    // Il signore è quello del castello più vicino
    const lord = this.nearestLord(lead.x, lead.z);
    if (!lord) return;
    if (lord.status !== 'war') this.declareWar(lord, 'Hai assaltato le sue mura');
    const snap = this.lordDefense(lord, extra);
    const army: AttackerArmy = { name: `L'esercito di ${this.state.castleName}`, ...a.troops, morale: 0.6, arrows: a.tactics?.arrows, melee: a.tactics?.melee };
    const res = resolveSiege(snap, army, this.random);
    for (const [uid, hp] of res.damage) {
      const b = lord.buildings.find((x) => x.uid === uid);
      if (b) b.hp = Math.max(0, Math.round(hp));
    }
    for (const k of ['infantry', 'archers', 'cavalry'] as const) lord.army[k] = Math.max(0, lord.army[k] - res.defenderLosses[k]);
    // Bottino dal tesoro del signore
    const share = res.outcome === 'sacked' ? 0.5 : res.outcome === 'held' ? 0.15 : 0;
    const coins = Math.floor(lord.wealth * share);
    lord.wealth -= coins;
    const loot: Cost = coins ? { coins, grain: Math.round(coins * 0.8), wood: Math.round(coins * 0.5) } : {};
    if (res.outcome === 'sacked') {
      lord.status = 'vassal';
      lord.relation = -40;
      this.log(`👑 ${lord.name} si sottomette: ${lord.castle} diventa nostra vassalla e ci pagherà un tributo.`, 'good');
    }
    const lost = res.attackerLosses;
    const survivors: Force = {
      infantry: Math.max(0, a.troops.infantry - lost.infantry),
      archers: Math.max(0, a.troops.archers - lost.archers),
      cavalry: Math.max(0, a.troops.cavalry - lost.cavalry),
      rams: res.outcome === 'repelled' ? Math.floor(a.troops.rams / 2) : a.troops.rams,
      trebuchets: res.outcome === 'repelled' ? Math.floor(a.troops.trebuchets / 2) : a.troops.trebuchets,
    };
    this.applyAttackResult({
      id: a.id,
      outcome: res.outcome,
      survivors,
      loot,
      log: res.log,
      attackerLosses: lost.infantry + lost.archers + lost.cavalry,
      defenderLosses: res.defenderLosses.infantry + res.defenderLosses.archers + res.defenderLosses.cavalry,
    });
    // I danni si vedono sul castello del signore
    this.syncLords(true);
  }

  // ───── Diplomatici ─────

  static readonly MISSIONS: Record<'alliance' | 'pact' | 'peace' | 'gift' | 'tribute' | 'war', { name: string; icon: string; description: string }> = {
    gift: { name: 'Dono', icon: '🎁', description: 'Porta un dono: migliora i rapporti.' },
    pact: { name: 'Patto di non aggressione', icon: '🤝', description: 'Nessuno attacca l\'altro. Serve un rapporto almeno neutrale.' },
    alliance: { name: 'Alleanza', icon: '🛡️', description: 'Aiuto reciproco: l\'alleato manda rinforzi e doni. Serve un buon rapporto.' },
    peace: { name: 'Pace', icon: '🕊️', description: 'Chiede la fine della guerra. Un dono aiuta.' },
    tribute: { name: 'Richiesta di tributo', icon: '💰', description: 'Se sei molto più forte paga, altrimenti si offende.' },
    war: { name: 'Dichiarazione di guerra', icon: '⚔️', description: 'Apre le ostilità.' },
  };

  canSendDiplomat(lordId: number, gift: Cost): PlaceCheck {
    if (this.locked) return { ok: false, reason: 'In attesa dell\'altro giocatore' };
    if (!this.lord(lordId)) return { ok: false, reason: 'Signore sconosciuto' };
    if (!this.ownKeep()) return { ok: false, reason: 'Serve un castello da cui partire' };
    const cost: Cost = { ...gift, coins: (gift.coins ?? 0) + 15 };
    if (!canAfford(this.state.resources, cost)) return { ok: false, reason: 'Risorse insufficienti (il viaggio costa 15 monete)' };
    if (this.companies().some((c) => c.envoy?.lord === lordId)) return { ok: false, reason: 'Un diplomatico è già in viaggio verso di lui' };
    return { ok: true };
  }

  /** Manda un diplomatico (a cavallo, col drappo bianco) al castello di un signore. */
  sendDiplomat(lordId: number, mission: keyof typeof Game.MISSIONS, gift: Cost = {}): Company | null {
    return this.track('Diplomazia', () => this.sendDiplomatImpl(lordId, mission, gift), 'event');
  }

  private sendDiplomatImpl(lordId: number, mission: keyof typeof Game.MISSIONS, gift: Cost): Company | null {
    if (!this.canSendDiplomat(lordId, gift).ok) return null;
    const l = this.lord(lordId)!;
    pay(this.state.resources, { ...gift, coins: (gift.coins ?? 0) + 15 });
    const [x, z] = this.spawnPoint();
    const c: Company = {
      id: `d-${this.state.nextUid++}`,
      troops: { infantry: 0, archers: 0, cavalry: 0, rams: 0, trebuchets: 0 },
      x,
      z,
      order: 'move',
      envoy: { lord: lordId, mission, gift },
    };
    const [kx, kz] = this.lordKeep(l);
    c.path = findPath(this.terrain.size, [Math.floor(x), Math.floor(z)], [kx, kz], (xx, zz) => this.envoyMoveCost(xx, zz));
    this.companies().push(c);
    this.log(`🕊️ Un diplomatico parte verso ${l.castle} (${Game.MISSIONS[mission].name.toLowerCase()}).`, 'info');
    return c;
  }

  /** I diplomatici passano dalle porte di tutti (sono ospiti). */
  private envoyMoveCost(x: number, z: number): number {
    const b = this.buildingAt(x, z);
    if (b && getBuilding(b.defId).fort === 'gate') return 0.8;
    return this.moveCost(x, z);
  }

  private envoyArrived(c: Company): boolean {
    const l = this.lord(c.envoy!.lord);
    if (!l) return true;
    const [kx, kz] = this.lordKeep(l);
    return Math.hypot(kx - c.x, kz - c.z) < 5 || !c.path?.length;
  }

  private resolveMission(c: Company) {
    const e = c.envoy!;
    const l = this.lord(e.lord);
    c.order = 'home';
    const [hx, hz] = this.keepCenter();
    c.path = findPath(this.terrain.size, [Math.floor(c.x), Math.floor(c.z)], [Math.floor(hx), Math.floor(hz)], (x, z) => this.envoyMoveCost(x, z));
    if (!l) return;
    const giftValue = Object.entries(e.gift ?? {}).reduce((s, [id, n]) => s + (n ?? 0) * RESOURCES[id as ResourceId].basePrice, 0);
    const bonus = Math.min(40, (giftValue / 12) * (this.fx().diplomacy ?? 1));
    const luck = this.random() * 20 - 10;
    // In guerra il diplomatico rischia la vita
    if (l.status === 'war' && e.mission !== 'peace' && this.random() < 0.25) {
      this.state.companies = this.companies().filter((x) => x !== c);
      this.log(`☠️ ${l.name} ha fatto imprigionare il nostro diplomatico.`, 'bad');
      return;
    }
    const say = (t: string, good: boolean) => this.log(`🕊️ ${l.castle}: ${t}`, good ? 'good' : 'bad');
    switch (e.mission) {
      case 'gift':
        l.relation = Math.min(100, l.relation + bonus);
        say(`${l.name} accetta il dono (rapporto +${Math.round(bonus)}).`, true);
        break;
      case 'pact':
        if (l.status === 'war') say('non si fanno patti con chi è in guerra: chiedi prima la pace.', false);
        else if (l.relation + bonus + luck >= -5) {
          l.status = l.status === 'alliance' ? 'alliance' : 'pact';
          l.relation = Math.min(100, l.relation + 10 + bonus / 2);
          say(`${l.name} firma un patto di non aggressione.`, true);
        } else {
          l.relation -= 3;
          say(`${l.name} rifiuta il patto.`, false);
        }
        break;
      case 'alliance':
        if (l.status === 'war') say('impossibile allearsi con un nemico in guerra.', false);
        else if (l.relation + bonus + luck >= 35 || (l.status === 'pact' && l.relation + bonus + luck >= 20)) {
          l.status = 'alliance';
          l.relation = Math.min(100, l.relation + 15);
          say(`${l.name} accetta l'alleanza! Ci manderà rinforzi e doni.`, true);
        } else {
          l.relation -= 2;
          say(`${l.name} non si fida ancora abbastanza (rapporto ${Math.round(l.relation)}).`, false);
        }
        break;
      case 'peace': {
        const fear = this.myPower() > this.lordPower(l) ? 15 : -10;
        if (l.status !== 'war') say('non siamo in guerra.', true);
        else if (l.relation + bonus + fear + luck >= -55) {
          l.status = 'neutral';
          l.relation = Math.max(l.relation, -25);
          l.companies.forEach((x) => (x.order = 'home'));
          say(`${l.name} accetta la pace.`, true);
        } else say(`${l.name} rifiuta la pace: la guerra continua.`, false);
        break;
      }
      case 'tribute':
        if (this.myPower() > this.lordPower(l) * 1.5) {
          const coins = Math.floor(l.wealth * 0.3);
          l.wealth -= coins;
          c.cargo = { coins };
          l.relation -= 20;
          say(`${l.name} paga un tributo di ${coins} monete, a denti stretti.`, true);
        } else {
          l.relation -= 15;
          say(`${l.name} ride della richiesta.`, false);
          if (l.personality === 'aggressive') this.declareWar(l, 'Ha preso la richiesta come un insulto');
        }
        break;
      case 'war':
        this.declareWar(l, 'Gli abbiamo dichiarato guerra');
        break;
    }
  }

  /** Testo breve per l'interfaccia. */
  lordStatusName(l: Lord): string {
    return STATUS_NAMES[l.status];
  }

  // ───────────── Tasse e contento ─────────────

  private lastFed = 1;
  private lastVariety = 3;

  taxLevel(): number {
    return Math.max(0, Math.min(TAX_LEVELS.length - 1, this.state.taxLevel ?? 2));
  }

  setTaxLevel(level: number) {
    this.state.taxLevel = Math.max(0, Math.min(TAX_LEVELS.length - 1, Math.round(level)));
  }

  /** Gettito giornaliero delle tasse. */
  taxPerDay(): number {
    return this.state.population * TAX_PER_PERSON * this.analysis().taxMul * TAX_LEVELS[this.taxLevel()].mul * (this.fx().taxes ?? 1);
  }

  /** Bilancio mensile delle monete: entrate, uscite, saldo e resa per abitante. */
  budget(): { taxes: number; tribute: number; army: number; engines: number; builders: number; net: number; perPerson: number } {
    const month = 30;
    const taxes = this.taxPerDay() * month;
    const tribute = this.lords().filter((l) => l.status === 'vassal').reduce((s, l) => s + (1 + l.level), 0) * month;
    const away = this.troopsAway();
    let army = 0;
    for (const id of Object.keys(UNITS) as UnitType[]) army += (UNITS[id].upkeep.coins ?? 0) * (this.state.army[id] + away[id]) * month;
    let engines = 0;
    for (const id of Object.keys(ENGINES) as EngineType[]) engines += (ENGINES[id].upkeep.coins ?? 0) * ((this.state.engines?.[id] ?? 0) + away[id]) * month;
    const perPerson = this.state.population > 0 ? taxes / this.state.population : TAX_PER_PERSON * TAX_LEVELS[this.taxLevel()].mul * month;
    const builders = this.lastBuilders * BUILDER_WAGE * month;
    return { taxes, tribute, army, engines, builders, net: taxes + tribute - army - engines - builders, perPerson };
  }

  happiness(): number {
    return this.state.happiness ?? 60;
  }

  /** Il contento verso cui tende la popolazione, voce per voce. */
  moodTarget(): { total: number; parts: Array<[string, number]> } {
    const a = this.analysis();
    const parts: Array<[string, number]> = [['Base', 55]];
    parts.push([`Tasse: ${TAX_LEVELS[this.taxLevel()].name.toLowerCase()}`, TAX_LEVELS[this.taxLevel()].mood]);
    parts.push(this.lastFed < 0.99 ? ['Fame', -30] : ['Cibo a sufficienza', 6]);
    if (this.lastVariety > 1) parts.push(['Dieta varia', Math.min(12, (this.lastVariety - 1) * 3)]);
    const crowd = this.state.population / Math.max(1, a.housing);
    if (crowd > 1) parts.push(['Sovraffollamento', -12]);
    else if (crowd < 0.85) parts.push(['Case spaziose', 4]);
    if (this.has((d) => !!d.market)) parts.push(['Mercato', 5]);
    if (this.fx().mood) parts.push([`${this.faction()!.name}`, this.fx().mood!]);
    if ((this.state.dynasty?.regencyUntil ?? 0) > this.state.day) parts.push(['Reggenza (erede bambino)', -8]);
    const ag = this.state.agitation;
    if (ag && this.state.day < ag.until) parts.push([`Agitatori di ${this.lord(ag.lord)?.name ?? 'un signore'}`, -10]);
    if (this.state.lastSiege && this.state.day - this.state.lastSiege.day < 120 && this.state.lastSiege.outcome !== 'repelled') {
      parts.push(['Saccheggio recente', -15]);
    }
    const total = Math.max(0, Math.min(100, parts.reduce((s, [, v]) => s + v, 0)));
    return { total, parts };
  }

  /** Moltiplicatore di produzione dovuto al contento (0,85 – 1,15). */
  productivity(): number {
    return 0.85 + 0.3 * (this.happiness() / 100);
  }

  // ───────────── Livelli del castello ─────────────

  ownKeep(): PlacedBuilding | undefined {
    return this.state.buildings.find((b) => getBuilding(b.defId).fort === 'keep');
  }

  castleLevel(): number {
    if (this.levelOverride !== undefined) return this.levelOverride;
    const k = this.ownKeep();
    if (!k) return 0;
    const u = k.upgrades ?? [];
    if (k.defId === 'keep_wood') return u.includes('bailey') ? 2 : 1;
    return u.includes('palace') ? 5 : u.includes('great_hall') ? 4 : 3;
  }

  /** Si può trasformare la motta in mastio di pietra (dal livello 2 al 3)? */
  canEvolveKeep(): PlaceCheck {
    const k = this.ownKeep();
    if (!k || k.defId !== 'keep_wood') return { ok: false, reason: 'Serve la motta' };
    return this.canEvolve(k);
  }

  /** La motta diventa mastio di pietra, sullo stesso posto (cisterna e armeria restano). */
  evolveKeep(): boolean {
    const k = this.ownKeep();
    return !!k && this.evolve(k);
  }

  // ───────────── Evoluzione delle fortificazioni ─────────────

  /** In cosa si trasforma l'edificio, se può evolvere. */
  evolveTarget(b: PlacedBuilding): BuildingDef | undefined {
    const to = getBuilding(b.defId).evolvesTo;
    return to ? getBuilding(to) : undefined;
  }

  /** Costo dell'evoluzione: si riusa parte del vecchio materiale. */
  evolveCost(b: PlacedBuilding): Cost {
    if (b.defId === 'keep_wood') return this.scaleCost(KEEP_EVOLVE.cost, this.fx().stoneFortCost ?? 1);
    const to = this.evolveTarget(b);
    if (!to) return {};
    const out: Cost = {};
    for (const [id, n] of Object.entries(this.costOf(to))) out[id as ResourceId] = Math.ceil((n ?? 0) * 0.85);
    return out;
  }

  /** Giornate di lavoro dell'evoluzione. */
  evolveWork(b: PlacedBuilding): number {
    const to = this.evolveTarget(b);
    return to ? Math.max(1, Math.round(this.buildWork(to) * 0.8 * 10) / 10) : 0;
  }

  canEvolve(b: PlacedBuilding): PlaceCheck {
    if (this.isForeign(b)) return { ok: false, reason: 'Appartiene all\'altro giocatore' };
    if (this.locked) return { ok: false, reason: 'In attesa dell\'altro giocatore' };
    const to = this.evolveTarget(b);
    if (!to) return { ok: false, reason: 'Non può evolvere' };
    if (this.jobFor(b.uid)) return { ok: false, reason: 'Lavori già in corso' };
    if (this.date.year < to.minYear) return { ok: false, reason: `Disponibile dal ${to.minYear}` };
    if (b.defId === 'keep_wood') {
      if (!b.upgrades?.includes('bailey')) return { ok: false, reason: 'Prima il cortile fortificato (livello 2)' };
      if (this.state.population < KEEP_EVOLVE.minPop) return { ok: false, reason: `Servono ${KEEP_EVOLVE.minPop} abitanti` };
    } else if (to.minLevel && this.castleLevel() < to.minLevel) {
      return { ok: false, reason: `Richiede il castello al livello ${to.minLevel} (${CASTLE_LEVELS[to.minLevel].name})` };
    }
    if (this.hpState(b) === 'ruin') return { ok: false, reason: 'Prima va riparato' };
    if (!canAfford(this.state.resources, this.evolveCost(b))) return { ok: false, reason: 'Risorse insufficienti' };
    return { ok: true };
  }

  evolve(b: PlacedBuilding): boolean {
    return this.track('Evoluzione delle fortificazioni', () => {
      if (!this.startEvolve(b)) return false;
      this.changed();
      return true;
    }, 'event');
  }

  /** Fa evolvere tutti gli edifici dello stesso tipo, finché bastano le risorse. */
  evolveAll(defId: string): number {
    return this.track('Evoluzione delle fortificazioni', () => {
      let n = 0;
      for (const b of this.state.buildings) if (b.defId === defId && this.startEvolve(b)) n++;
      if (n) this.changed();
      return n;
    }, 'event');
  }

  private startEvolve(b: PlacedBuilding): boolean {
    if (!this.canEvolve(b).ok) return false;
    const cost = this.evolveCost(b);
    const to = this.evolveTarget(b)!;
    pay(this.state.resources, cost);
    if (this.instantBuild) this.applyEvolution(b, to.id);
    else this.jobs().push({ id: this.newJobId(), kind: 'evolve', uid: b.uid, to: to.id, work: this.evolveWork(b), done: 0, cost });
    return true;
  }

  private applyEvolution(b: PlacedBuilding, to: string) {
    const def = getBuilding(to);
    b.defId = to;
    b.upgrades = (b.upgrades ?? []).filter((u) => UPGRADE_BY_ID[u]?.appliesTo.includes(to) && !def.builtIn?.includes(u));
    b.hp = this.maxHp(b);
    if (def.fort === 'keep') this.log(`Il castello sale al livello 3: la motta è diventata un ${CASTLE_LEVELS[3].name.toLowerCase()}!`, 'good');
  }

  // ───────────── Visibilità: nebbia di guerra, esploratori e torri di avvistamento ─────────────

  private visibleGrid?: Uint8Array;
  private exploredGrid?: Uint8Array;
  /** Cresce quando si scopre un edificio straniero (la scena lo mostra). */
  revealVersion = 0;
  private alerted = new Set<string>();

  fogGrids(): { vis: Uint8Array; exp: Uint8Array } {
    const n = this.terrain.size * this.terrain.size;
    if (!this.exploredGrid || this.exploredGrid.length !== n) {
      this.exploredGrid = new Uint8Array(n);
      this.visibleGrid = new Uint8Array(n);
      const enc = this.state.explored;
      if (enc) {
        try {
          const bin = atob(enc);
          for (let i = 0; i < n; i++) if (bin.charCodeAt(i >> 3) & (1 << (i & 7))) this.exploredGrid[i] = 1;
        } catch {
          /* salvataggio vecchio o rovinato: si riparte da zero */
        }
      }
    }
    return { vis: this.visibleGrid!, exp: this.exploredGrid };
  }

  isVisible(x: number, z: number): boolean {
    const n = this.terrain.size;
    if (x < 0 || z < 0 || x >= n || z >= n) return false;
    return this.fogGrids().vis[Math.floor(z) * n + Math.floor(x)] === 1;
  }

  isExplored(x: number, z: number): boolean {
    const n = this.terrain.size;
    if (x < 0 || z < 0 || x >= n || z >= n) return false;
    return this.fogGrids().exp[Math.floor(z) * n + Math.floor(x)] === 1;
  }

  /** Un edificio straniero si vede se è stato scoperto, o se è di un alleato o vassallo. */
  isRevealed(b: PlacedBuilding): boolean {
    if (!this.isForeign(b)) return true;
    if (b.owner !== undefined) {
      const st = this.lord(b.owner)?.status;
      if (st === 'alliance' || st === 'vassal') return true;
    }
    const [w, d] = getBuilding(b.defId).size;
    return this.isExplored(b.x + w / 2, b.z + d / 2);
  }

  /** Raggio di avvistamento di una torre (cresce con le guardie e il fuoco di segnalazione). */
  visionOf(b: PlacedBuilding): number {
    const def = getBuilding(b.defId);
    if (!def.vision || this.hpState(b) === 'ruin') return 0;
    const g = b.garrison ? b.garrison.infantry + b.garrison.archers : 0;
    return def.vision + Math.min(6, g) + (b.upgrades?.includes('signal_fire') ? 4 : 0);
  }

  /** Fonti di vista: edifici, reparti, esploratori, torri, alleati. */
  private visionSources(): Array<[number, number, number]> {
    const out: Array<[number, number, number]> = [];
    for (const b of this.state.buildings) {
      const def = getBuilding(b.defId);
      const [w, d] = def.size;
      const r = def.vision ? this.visionOf(b) : def.fort === 'keep' ? 12 : def.fort === 'tower' ? 7 : def.fort === 'gate' ? 5 : 3;
      out.push([b.x + w / 2, b.z + d / 2, r]);
    }
    for (const b of this.sites()) out.push([b.x + 0.5, b.z + 0.5, 2]);
    for (const c of this.companies()) out.push([c.x, c.z, c.scout ? 9 : c.envoy ? 4 : 5]);
    // Dalle mura si vede bene il campo degli assedianti
    if (this.state.siege) out.push([this.state.siege.camp[0] + 0.5, this.state.siege.camp[1] + 0.5, 6]);
    if (!this.state.buildings.length) {
      const [hx, hz] = this.homeSite();
      out.push([hx, hz, 10]);
    }
    for (const l of this.lords()) {
      if (l.status !== 'alliance' && l.status !== 'vassal') continue;
      for (const b of l.buildings) out.push([b.x + 0.5, b.z + 0.5, 4]);
      for (const c of l.companies) out.push([c.x, c.z, 5]);
    }
    return out;
  }

  /** Ricalcola cosa si vede; segna le caselle esplorate e dà l'allarme sui nemici avvistati. */
  updateVision(): boolean {
    const { vis, exp } = this.fogGrids();
    const n = this.terrain.size;
    vis.fill(0);
    let grew = false;
    for (const [cx, cz, r] of this.visionSources()) {
      const r2 = r * r;
      for (let z = Math.max(0, Math.floor(cz - r)); z <= Math.min(n - 1, Math.ceil(cz + r)); z++) {
        for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(n - 1, Math.ceil(cx + r)); x++) {
          const dx = x + 0.5 - cx;
          const dz = z + 0.5 - cz;
          if (dx * dx + dz * dz > r2) continue;
          const k = z * n + x;
          vis[k] = 1;
          if (!exp[k]) {
            exp[k] = 1;
            grew = true;
          }
        }
      }
    }
    if (grew || this.forceExploredSave) {
      this.forceExploredSave = false;
      // Salva le caselle esplorate e mostra gli edifici stranieri appena scoperti
      const bytes = new Uint8Array(Math.ceil((n * n) / 8));
      for (let i = 0; i < n * n; i++) if (exp[i]) bytes[i >> 3] |= 1 << (i & 7);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      this.state.explored = btoa(bin);
      const key = this.others.filter((b) => this.isRevealed(b)).length;
      if (key !== this.lastRevealed) {
        this.lastRevealed = key;
        this.revealVersion++;
      }
    }
    // Allarme: truppe nemiche avvistate (dalle torri o dai reparti)
    const alive = new Set<string>();
    for (const c of this.enemyCompanies) {
      if (c.envoy) continue;
      alive.add(c.id);
      if (this.alerted.has(c.id) || !this.isVisible(c.x, c.z)) continue;
      this.alerted.add(c.id);
      const l = c.owner !== undefined ? this.lord(c.owner) : undefined;
      if (l && l.status !== 'war') continue;
      const n2 = Math.round(c.troops.infantry + c.troops.archers + c.troops.cavalry);
      const tower = this.state.buildings.some((b) => this.visionOf(b) > 0 && Math.hypot(b.x + 0.5 - c.x, b.z + 0.5 - c.z) <= this.visionOf(b));
      this.log(`${tower ? '🔭 Le vedette hanno avvistato' : '👁️ Avvistato'} ${l ? `l'esercito di ${l.name}` : 'un esercito nemico'}: ${n2} soldati in marcia!`, 'bad');
    }
    for (const id of this.alerted) if (!alive.has(id)) this.alerted.delete(id);
    return grew;
  }
  private lastRevealed = -1;

  /** Mette (o toglie) soldati di guardia in una torre di avvistamento: prima gli arcieri. */
  setGarrison(b: PlacedBuilding, n: number): number {
    const def = getBuilding(b.defId);
    if (!def.garrison || this.isForeign(b) || this.siteByUid(b.uid)) return 0;
    const cur = b.garrison ?? { infantry: 0, archers: 0 };
    // Rientrano tutti, poi si assegnano i nuovi
    this.state.army.infantry += cur.infantry;
    this.state.army.archers += cur.archers;
    const want = Math.max(0, Math.min(def.garrison, Math.round(n)));
    const archers = Math.min(want, Math.floor(this.state.army.archers));
    const infantry = Math.min(want - archers, Math.floor(this.state.army.infantry));
    this.state.army.archers -= archers;
    this.state.army.infantry -= infantry;
    b.garrison = archers + infantry ? { infantry, archers } : undefined;
    return archers + infantry;
  }

  /** Forma un esploratore a cavallo: vede lontano, non combatte. */
  canSendScout(): PlaceCheck {
    if (this.locked) return { ok: false, reason: 'In attesa dell\'altro giocatore' };
    if (!this.ownKeep()) return { ok: false, reason: 'Serve prima il castello' };
    if (this.companies().filter((c) => c.scout).length >= 3) return { ok: false, reason: 'Al massimo tre esploratori' };
    if (this.state.resources.coins < 15) return { ok: false, reason: 'Servono 15 monete' };
    return { ok: true };
  }

  sendScout(tx?: number, tz?: number): Company | null {
    return this.track('Esploratori', () => {
      if (!this.canSendScout().ok) return null;
      this.state.resources.coins -= 15;
      const [sx, sz] = this.spawnPoint();
      const c: Company = {
        id: `s${this.state.nextUid++}`,
        troops: { infantry: 0, archers: 0, cavalry: 0, rams: 0, trebuchets: 0 },
        x: sx + 0.5,
        z: sz + 0.5,
        order: 'idle',
        scout: true,
        formation: 'column',
        behavior: 'hold',
      };
      (this.state.companies ??= []).push(c);
      if (tx !== undefined && tz !== undefined) this.route(c, tx, tz);
      this.log('🐎 Un esploratore a cavallo è partito: selezionalo e mandalo dove vuoi vedere (tasto destro).', 'info');
      return c;
    }, 'event');
  }

  /** Le incursioni nemiche che passano vicino a una torre di avvistamento la attaccano. */
  private watchtowerSkirmishes() {
    for (const l of this.lords()) {
      if (l.status !== 'war') continue;
      for (const c of l.companies) {
        for (const b of this.state.buildings) {
          if (!getBuilding(b.defId).vision || this.hpState(b) === 'ruin') continue;
          if (Math.hypot(b.x + 0.5 - c.x, b.z + 0.5 - c.z) > 1.8) continue;
          const key = `${c.id}|${b.uid}`;
          if (this.alerted.has(key)) continue;
          this.alerted.add(key);
          const g = b.garrison ?? { infantry: 0, archers: 0 };
          const protect = 1 + (b.upgrades?.includes('watch_fence') ? 0.6 : 0) + (b.upgrades?.includes('watch_wall') ? 0.8 : 0) + (b.defId === 'watchtower_stone' ? 0.5 : 0);
          const def = (g.archers * 1.3 + g.infantry + 0.5) * protect * 3;
          const atk = c.troops.infantry + c.troops.archers * 0.6 + c.troops.cavalry * 1.4;
          const name = getBuilding(b.defId).name.toLowerCase();
          if (atk > def) {
            b.hp = 0;
            const lost = g.infantry + g.archers;
            b.garrison = undefined;
            this.log(`🔥 ${l.name} ha incendiato una ${name}${lost ? ` (${lost} guardie cadute)` : ''}. Va riparata.`, 'bad');
            this.changed();
          } else {
            const kill = Math.min(atk, def * 0.25);
            const tot = Math.max(1, atk);
            c.troops.infantry = Math.max(0, c.troops.infantry - kill * (c.troops.infantry / tot));
            c.troops.archers = Math.max(0, c.troops.archers - kill * (c.troops.archers * 0.6 / tot));
            c.troops.cavalry = Math.max(0, c.troops.cavalry - kill * (c.troops.cavalry * 1.4 / tot));
            this.log(`🛡️ Le guardie della ${name} hanno respinto l'avanguardia di ${l.name} (circa ${Math.round(kill)} nemici a terra).`, 'good');
          }
        }
      }
    }
  }

  // ───────────── Livelli degli edifici civili ─────────────

  /** Capi che un recinto può ospitare (cresce con il livello). */
  herdCapacity(b: PlacedBuilding): number {
    const def = getBuilding(b.defId);
    return def.herd ? Math.round(def.herd.capacity * levelEffects(b.level ?? 1).herd) : 0;
  }

  levelOf(b: PlacedBuilding): number {
    return b.level ?? 1;
  }

  /** Livello massimo per l'epoca attuale (4 per epoca). */
  maxLevel(): number {
    return maxLevelFor(this.date.year);
  }

  levelCost(b: PlacedBuilding): Cost {
    return levelUpCost(getBuilding(b.defId), this.levelOf(b));
  }

  canLevelUp(b: PlacedBuilding): PlaceCheck {
    const def = getBuilding(b.defId);
    if (!isLevelable(def)) return { ok: false, reason: 'Non si migliora a livelli' };
    if (this.isForeign(b)) return { ok: false, reason: 'Appartiene a un altro signore' };
    if (this.locked) return { ok: false, reason: 'In attesa dell\'altro giocatore' };
    if (this.siteByUid(b.uid)) return { ok: false, reason: 'Ancora in costruzione' };
    if (this.jobFor(b.uid)) return { ok: false, reason: 'Lavori già in corso' };
    const lv = this.levelOf(b);
    if (lv >= this.maxLevel()) {
      const next = ERAS[Math.min(ERAS.length - 1, eraIndexOf(this.date.year) + 1)];
      return { ok: false, reason: lv >= ERAS.length * 4 ? 'Livello massimo' : `Altri livelli dal ${next.fromYear} (${next.name})` };
    }
    if (!canAfford(this.state.resources, this.levelCost(b))) return { ok: false, reason: 'Risorse insufficienti' };
    return { ok: true };
  }

  levelUp(b: PlacedBuilding): boolean {
    return this.track('Miglioramento degli edifici', () => {
      if (!this.startLevelUp(b)) return false;
      this.changed();
      return true;
    }, 'event');
  }

  /** Migliora tutti gli edifici dello stesso tipo e livello, finché bastano le risorse. */
  levelUpAll(defId: string, level: number): number {
    return this.track('Miglioramento degli edifici', () => {
      let n = 0;
      for (const b of this.state.buildings) if (b.defId === defId && this.levelOf(b) === level && this.startLevelUp(b)) n++;
      if (n) this.changed();
      return n;
    }, 'event');
  }

  private startLevelUp(b: PlacedBuilding): boolean {
    if (!this.canLevelUp(b).ok) return false;
    const cost = this.levelCost(b);
    pay(this.state.resources, cost);
    if (this.instantBuild) b.level = this.levelOf(b) + 1;
    else this.jobs().push({ id: this.newJobId(), kind: 'level', uid: b.uid, work: Game.workFor(cost), done: 0, cost });
    return true;
  }

  // ───────────── Cantieri e costruttori ─────────────

  sites(): PlacedBuilding[] {
    return (this.state.sites ??= []);
  }

  jobs(): BuildJob[] {
    return (this.state.jobs ??= []);
  }

  private newJobId(): number {
    const id = this.state.nextJobId ?? 1;
    this.state.nextJobId = id + 1;
    return id;
  }

  siteByUid(uid: number): PlacedBuilding | undefined {
    return this.sites().find((b) => b.uid === uid);
  }

  siteAt(x: number, z: number): PlacedBuilding | undefined {
    if (x < 0 || z < 0 || x >= this.terrain.size || z >= this.terrain.size) return undefined;
    const uid = this.occupancy[z * this.terrain.size + x];
    return uid && uid < FOREIGN ? this.siteByUid(uid) : undefined;
  }

  /** Edificio finito o cantiere sulla casella. */
  structureAt(x: number, z: number): PlacedBuilding | undefined {
    return this.buildingAt(x, z) ?? this.siteAt(x, z);
  }

  /** Lavoro in corso su un edificio o cantiere. */
  jobFor(uid: number): BuildJob | undefined {
    return this.jobs().find((j) => j.uid === uid);
  }

  /** Giornate di lavoro necessarie per dei materiali. */
  static workFor(cost: Cost): number {
    let w = 0;
    for (const [id, n] of Object.entries(cost)) w += (n ?? 0) * (WORK_PER_UNIT[id as ResourceId] ?? 1);
    return Math.max(1, Math.round(w * 10) / 10);
  }

  buildWork(def: BuildingDef): number {
    return def.work ?? Game.workFor(def.cost);
  }

  /** Quanti costruttori possono lavorare insieme sullo stesso edificio. */
  crewCap(defId: string): number {
    const [w, d] = getBuilding(defId).size;
    return 2 + 2 * w * d;
  }

  private lodges(): number {
    return this.count('mason_lodge');
  }

  /** Posti per costruttori: pochi senza loggia dei muratori. */
  builderCap(): number {
    let n = BASE_BUILDERS;
    for (const b of this.state.buildings) n += getBuilding(b.defId).builders ?? 0;
    return n;
  }

  /** Costruttori che si vogliono impiegare (al massimo metà della popolazione). */
  desiredBuilders(): number {
    return Math.max(0, Math.min(this.state.builders ?? Infinity, this.builderCap(), Math.floor(this.state.population * 0.5)));
  }

  setBuilders(n: number | undefined) {
    this.state.builders = n === undefined ? undefined : Math.max(0, Math.min(500, Math.round(n)));
  }

  /** Giornate di lavoro che un costruttore svolge in un giorno, con le cause. */
  builderRate(stone: boolean): { rate: number; parts: Array<[string, number]> } {
    const parts: Array<[string, number]> = [];
    const lodge = 1 + 0.1 * Math.min(3, this.lodges());
    if (lodge > 1) parts.push(['Loggia dei muratori', lodge]);
    const fed = 0.3 + 0.7 * this.lastFed;
    if (fed < 0.99) parts.push(['Poco cibo', fed]);
    const prod = this.productivity();
    parts.push(['Contento', prod]);
    if (this.state.resources.coins < 1) parts.push(['Senza paga', 0.5]);
    const fb = this.fx().builders;
    if (fb && this.date.year >= fb.from) parts.push([`${this.faction()!.name}`, fb.mul]);
    if (seasonIndex(this.date.season) === 3) parts.push([stone ? 'Inverno: la malta gela' : 'Inverno', stone ? 0.35 : 0.75]);
    return { rate: parts.reduce((r, [, v]) => r * v, 1), parts };
  }

  jobDef(j: BuildJob): string | undefined {
    if (j.kind === 'build') return this.siteByUid(j.uid)?.defId;
    return this.byUid(j.uid)?.defId;
  }

  private isStoneJob(j: BuildJob): boolean {
    return (j.cost.stone ?? 0) + (j.cost.lime ?? 0) > 0;
  }

  /** Avanza i lavori nell'ordine della coda; restituisce i costruttori impiegati. */
  private stepJobs(dt: number): number {
    const jobs = this.jobs();
    this.lastCrew.clear();
    if (!jobs.length) {
      this.lastBuilders = 0;
      return 0;
    }
    let free = this.desiredBuilders();
    const rateStone = this.builderRate(true).rate;
    const rateWood = this.builderRate(false).rate;
    let used = 0;
    const finished: BuildJob[] = [];
    const lodges = this.state.buildings.filter((b) => b.defId === 'mason_lodge');
    for (const j of jobs) {
      if (free <= 0) break;
      const defId = this.jobDef(j);
      if (!defId) {
        finished.push(j);
        continue;
      }
      if (j.paused) continue;
      const crew = Math.min(free, this.crewCap(defId), j.crew ?? Infinity);
      free -= crew;
      used += crew;
      this.lastCrew.set(j.id, crew);
      // Vicino a una loggia dei muratori si lavora più in fretta (attrezzi e argani a portata di mano)
      const at = lodges.length ? this.byUid(j.uid) ?? this.siteByUid(j.uid) : undefined;
      const near = at && lodges.some((l) => Math.abs(l.x - at.x) + Math.abs(l.z - at.z) <= 14) ? 1.15 : 1;
      j.done += crew * (this.isStoneJob(j) ? rateStone : rateWood) * near * dt;
      if (j.done >= j.work) finished.push(j);
      else {
        const stage = Math.min(3, Math.floor((j.done / j.work) * 4));
        if (this.siteStage.get(j.uid) !== stage) {
          this.siteStage.set(j.uid, stage);
          if (j.kind === 'build') this.stageDirty = true;
        }
      }
    }
    for (const j of finished) this.finishJob(j);
    this.lastBuilders = used;
    return used;
  }

  private finishJob(j: BuildJob) {
    this.state.jobs = this.jobs().filter((x) => x !== j);
    this.lastCrew.delete(j.id);
    this.siteStage.delete(j.uid);
    this.visualDirty = true;
    if (j.kind === 'build') {
      const b = this.siteByUid(j.uid);
      if (!b) return;
      this.state.sites = this.sites().filter((x) => x !== b);
      const def = getBuilding(b.defId);
      if (def.hp) b.hp = this.maxHp(b);
      this.state.buildings.push(b);
      if (!def.draggable) this.log(`🏗️ Costruzione completata: ${def.name}.`, 'good');
      else if (!this.jobs().some((x) => x.kind === 'build' && this.siteByUid(x.uid)?.defId === def.id)) this.log(`🏗️ Completato il tratto di ${def.name.toLowerCase()}.`, 'good');
      return;
    }
    const b = this.byUid(j.uid);
    if (!b) return;
    if (j.kind === 'level') {
      b.level = this.levelOf(b) + 1;
      if (!getBuilding(b.defId).draggable) this.log(`🏗️ ${getBuilding(b.defId).name} migliorato al livello ${b.level}.`, 'good');
    } else if (j.kind === 'upgrade' && j.upId) {
      this.applyUpgrade(b, j.upId);
      if (!getBuilding(b.defId).draggable) this.log(`🏗️ Completato: ${UPGRADE_BY_ID[j.upId].name} (${getBuilding(b.defId).name}).`, 'good');
    } else if (j.kind === 'evolve' && j.to) {
      const from = getBuilding(b.defId);
      this.applyEvolution(b, j.to);
      if (!from.draggable) this.log(`🏗️ ${from.name} → ${getBuilding(j.to).name}: lavori completati.`, 'good');
      else if (!this.jobs().some((x) => x.kind === 'evolve' && x.to === j.to)) this.log(`🏗️ Tratto di mura trasformato in ${getBuilding(j.to).name.toLowerCase()}.`, 'good');
    }
  }

  /** Avanzamento (0-1) del lavoro su un edificio o cantiere. */
  progressOf(uid: number): number | undefined {
    const j = this.jobFor(uid);
    return j ? Math.min(1, j.done / j.work) : undefined;
  }

  /** Stadio visivo del cantiere (0-3). */
  siteStageOf(uid: number): number {
    const p = this.progressOf(uid) ?? 0;
    return Math.min(3, Math.floor(p * 4));
  }

  /** Stima dei giorni per finire un lavoro, tenendo conto della coda. */
  jobEta(j: BuildJob): number | null {
    const rate = (this.isStoneJob(j) ? this.builderRate(true) : this.builderRate(false)).rate;
    const crew = this.lastCrew.get(j.id) ?? 0;
    if (crew > 0) return (j.work - j.done) / (crew * rate);
    const total = this.desiredBuilders();
    if (!total || rate <= 0) return null;
    let before = 0;
    for (const x of this.jobs()) {
      before += x.work - x.done;
      if (x === j) break;
    }
    return before / (total * rate);
  }

  /** Giorni stimati per costruire un edificio con i costruttori attuali (se non c'è coda). */
  estimateDays(defId: string): number {
    const def = getBuilding(defId);
    return this.daysFor(this.buildWork(def), defId, (def.cost.stone ?? 0) + (def.cost.lime ?? 0) > 0);
  }

  /** Giorni per svolgere un certo lavoro su un edificio, se i costruttori sono liberi. */
  daysFor(work: number, defId: string, stone: boolean): number {
    const crew = Math.max(1, Math.min(this.desiredBuilders(), this.crewCap(defId)));
    return work / (crew * Math.max(0.05, this.builderRate(stone).rate));
  }

  /** Nome leggibile del lavoro. */
  jobName(j: BuildJob): string {
    const defId = this.jobDef(j);
    const name = defId ? getBuilding(defId).name : '?';
    if (j.kind === 'build') return `${defId ? getBuilding(defId).icon : ''} ${name}`;
    if (j.kind === 'upgrade') return `${UPGRADE_BY_ID[j.upId ?? '']?.icon ?? ''} ${UPGRADE_BY_ID[j.upId ?? '']?.name ?? ''} · ${name}`;
    if (j.kind === 'level') return `⬆️ ${name} → livello ${(this.byUid(j.uid)?.level ?? 1) + 1}`;
    return `⬆️ ${name} → ${getBuilding(j.to ?? defId ?? '').name}`;
  }

  /** Annulla un lavoro: rimborso pieno se non è iniziato, metà dei materiali se è finito a metà. */
  cancelJob(id: number): boolean {
    return this.track('Lavori annullati (rimborso)', () => this.cancelJobImpl(id), 'event');
  }

  private cancelJobImpl(id: number): boolean {
    if (this.locked) return false;
    const j = this.jobs().find((x) => x.id === id);
    if (!j) return false;
    const keep = 1 - 0.5 * Math.min(1, j.done / j.work);
    for (const [rid, n] of Object.entries(j.cost)) this.state.resources[rid as ResourceId] += Math.floor((n ?? 0) * keep);
    this.state.jobs = this.jobs().filter((x) => x !== j);
    this.siteStage.delete(j.uid);
    if (j.kind === 'build') {
      const b = this.siteByUid(j.uid);
      if (b) {
        this.mark(b, 0);
        this.state.sites = this.sites().filter((x) => x !== b);
      }
    }
    this.changed();
    return true;
  }

  /** Squadra di un lavoro: limita i costruttori che ci lavorano (undefined = quanti ne servono). */
  setJobCrew(id: number, crew: number | undefined) {
    const j = this.jobs().find((x) => x.id === id);
    if (!j) return;
    const cap = this.crewCap(this.jobDef(j) ?? '');
    if (crew === undefined || crew >= cap) delete j.crew;
    else j.crew = Math.max(1, Math.floor(crew));
  }

  setJobPaused(id: number, paused: boolean) {
    const j = this.jobs().find((x) => x.id === id);
    if (!j) return;
    if (paused) j.paused = true;
    else delete j.paused;
  }

  // ───────────── Piani di evoluzione delle mura ─────────────

  plans(): WallPlan[] {
    return this.state.plans ?? [];
  }

  /** Attiva o spegne il piano "evolvi da solo questo tipo di mura quando ci sono i materiali". */
  togglePlan(defId: string): boolean {
    const plans = (this.state.plans ??= []);
    const i = plans.findIndex((p) => p.defId === defId);
    if (i >= 0) plans.splice(i, 1);
    else plans.push({ defId });
    return i < 0;
  }

  private stepPlans() {
    for (const p of this.plans()) {
      const n = this.evolveAll(p.defId);
      if (n > 0) this.log(`📋 Piano di cantiere: avviata la trasformazione di ${n} ${getBuilding(p.defId).name.toLowerCase()} (${getBuilding(getBuilding(p.defId).evolvesTo ?? p.defId).name.toLowerCase()}).`, 'info');
    }
  }

  /** Porta un lavoro in cima alla coda. */
  prioritizeJob(id: number) {
    const j = this.jobs().find((x) => x.id === id);
    if (!j) return;
    this.state.jobs = [j, ...this.jobs().filter((x) => x !== j)];
  }

  /** Porta in cima alla coda tutti i lavori dello stesso tipo (es. un intero tratto di mura). */
  prioritizeSimilar(id: number) {
    const j = this.jobs().find((x) => x.id === id);
    if (!j) return;
    const key = (x: BuildJob) => `${x.kind}|${this.jobDef(x)}|${x.upId ?? ''}|${x.to ?? ''}`;
    const k = key(j);
    const same = this.jobs().filter((x) => key(x) === k);
    this.state.jobs = [...same, ...this.jobs().filter((x) => key(x) !== k)];
  }

  /** Giorni al prossimo assalto (per l'interfaccia). */
  daysToRaid(): number {
    return Math.max(0, this.state.nextRaidDay - this.state.day);
  }
}
