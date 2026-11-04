import { ANIMALS } from '../data/animals';
import {
  BUILDINGS,
  getBuilding,
  isAvailable,
  seasonIndex,
  type BuildingDef,
  type UnitType,
} from '../data/buildings';
import { dateFromDays, DAYS_PER_SEASON, SEASON_NAMES, type GameDate } from '../data/calendar';
import { eraForYear } from '../data/eras';
import {
  canAfford,
  FOOD_IDS,
  pay,
  RESOURCE_IDS,
  RESOURCES,
  type Cost,
  type ResourceId,
} from '../data/resources';
import { SOLDIER_FOOD, UNITS } from '../data/units';
import { UPGRADE_BY_ID, upgradesFor, type UpgradeDef } from '../data/upgrades';
import {
  generateTerrain,
  isBuildableLand,
  isWater,
  Tile,
  tileAt,
  type Terrain,
} from '../world/terrain';
import { resolveSiege, type AttackerArmy, type DefenderSnapshot, type SiegeSegment } from './siege';
import {
  BASE_HOUSING,
  BASE_STORAGE,
  FOOD_PER_PERSON,
  TAX_PER_PERSON,
  type EventKind,
  type GameState,
  type PlacedBuilding,
} from './state';

/** Ordine in cui si mangia il cibo: prima quello che deperisce. */
const EATING_ORDER: ResourceId[] = [...FOOD_IDS].sort(
  (a, b) => (RESOURCES[b].spoilage ?? 0) - (RESOURCES[a].spoilage ?? 0),
);

const MAX_LOG = 60;

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
  flooded: Set<number>;
  connected: Map<number, number>;
  housing: number;
  jobs: number;
  storage: number;
  taxMul: number;
}

type Listener = () => void;

const D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
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
export class Game {
  readonly terrain: Terrain;
  /** uid dell'edificio che occupa ogni casella (0 = libera). */
  readonly occupancy: Int32Array;
  private listeners = new Set<Listener>();
  private eventListeners = new Set<(e: { text: string; kind: EventKind }) => void>();
  private lastSeasonIndex: number;
  private lastYear: number;
  private cache: Analysis | null = null;
  /** Cresce a ogni cambiamento visibile (costruzioni, demolizioni, miglioramenti, danni). */
  structureVersion = 0;
  /** Edifici dell'altro giocatore (solo da guardare: non entrano nella nostra economia). */
  others: PlacedBuilding[] = [];
  /** Bloccato: in multigiocatore finché non sono online entrambi i giocatori. */
  locked = false;

  constructor(public state: GameState, private random: () => number = Math.random) {
    this.terrain = generateTerrain(state.seed, { preset: state.preset, players: state.match ? 2 : 1 });
    this.occupancy = new Int32Array(this.terrain.size * this.terrain.size);
    for (const b of state.buildings) {
      this.mark(b, b.uid);
      const def = getBuilding(b.defId);
      if (def.hp && b.hp === undefined) b.hp = this.maxHp(b);
      b.upgrades ??= [];
    }
    const d = dateFromDays(state.day);
    this.lastSeasonIndex = seasonIndex(d.season);
    this.lastYear = d.year;
  }

  // ───────────── Eventi ─────────────

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onEvent(fn: (e: { text: string; kind: EventKind }) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  private changed() {
    this.structureVersion++;
    this.cache = null;
    this.emit();
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

  /** Territorio in cui si può costruire: in multigiocatore, la propria metà della mappa. */
  territory(): { x0: number; x1: number; z0: number; z1: number } {
    const n = this.terrain.size;
    if (!this.state.match) return { x0: 0, x1: n, z0: 0, z1: n };
    return this.state.match.slot === 0 ? { x0: 0, x1: Math.floor(n / 2), z0: 0, z1: n } : { x0: Math.floor(n / 2), x1: n, z0: 0, z1: n };
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
    this.changed();
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
    return this.analysis().storage;
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

  availableBuildings(): BuildingDef[] {
    const year = this.date.year;
    return BUILDINGS.filter((b) => isAvailable(b, year));
  }

  // ───────────── Analisi della cinta, dei fossati e delle strade ─────────────

  private tileIndex(x: number, z: number) {
    return z * this.terrain.size + x;
  }

  /** Blocca il passaggio degli assalitori: mura, torri, porte, mastio (non in rovina) e acqua senza ponte. */
  private blocks(x: number, z: number): boolean {
    const b = this.buildingAt(x, z);
    if (b) {
      const def = getBuilding(b.defId);
      if (def.fort && def.fort !== 'moat') return this.hpState(b) !== 'ruin';
      if (def.id === 'bridge') return false;
    }
    return isWater(tileAt(this.terrain, x, z));
  }

  analysis(): Analysis {
    if (this.cache && this.cache.version === this.structureVersion) return this.cache;
    const size = this.terrain.size;
    let housing = BASE_HOUSING;
    let jobs = 0;
    let storage = BASE_STORAGE;
    let taxMul = 1;
    for (const { def } of this.defsPlaced()) {
      housing += def.housing ?? 0;
      jobs += def.workers;
      storage += def.storage ?? 0;
      taxMul += def.taxBonus ?? 0;
    }

    // Riempimento dal bordo della mappa: ciò che non si raggiunge è dentro la cinta
    const outside = new Uint8Array(size * size);
    const queue: number[] = [];
    const push = (x: number, z: number) => {
      if (x < 0 || z < 0 || x >= size || z >= size) return;
      const k = this.tileIndex(x, z);
      if (outside[k] || this.blocks(x, z)) return;
      outside[k] = 1;
      queue.push(k);
    };
    for (let i = 0; i < size; i++) {
      push(i, 0);
      push(i, size - 1);
      push(0, i);
      push(size - 1, i);
    }
    while (queue.length) {
      const k = queue.pop()!;
      const x = k % size;
      const z = (k - x) / size;
      for (const [dx, dz] of D4) push(x + dx, z + dz);
    }
    let closed = false;
    for (const b of this.state.buildings) {
      const def = getBuilding(b.defId);
      if (def.fort !== 'keep' || this.hpState(b) === 'ruin') continue;
      const [w, d] = def.size;
      // La cinta è chiusa se accanto al mastio c'è terreno libero non raggiungibile da fuori
      for (let z = b.z - 1; z <= b.z + d && !closed; z++) {
        for (let x = b.x - 1; x <= b.x + w && !closed; x++) {
          if (x < 0 || z < 0 || x >= size || z >= size) continue;
          if (x >= b.x && x < b.x + w && z >= b.z && z < b.z + d) continue;
          if (!this.blocks(x, z) && !outside[this.tileIndex(x, z)]) closed = true;
        }
      }
    }

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
      return def.road || def.fort === 'gate' ? def : null;
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

    this.cache = { version: this.structureVersion, closed, outside, flooded, connected, housing, jobs, storage, taxMul };
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
    if (this.date.year < u.minYear) return { ok: false, reason: `Disponibile dal ${u.minYear}` };
    if (u.requires && !b.upgrades?.includes(u.requires)) {
      return { ok: false, reason: `Richiede: ${UPGRADE_BY_ID[u.requires].name}` };
    }
    if (u.needsMoat && !this.gateHasMoat(b)) return { ok: false, reason: 'Serve un fossato davanti alla porta' };
    if (this.hpState(b) === 'ruin') return { ok: false, reason: 'Prima va riparato' };
    if (!canAfford(this.state.resources, u.cost)) return { ok: false, reason: 'Risorse insufficienti' };
    return { ok: true };
  }

  upgrade(b: PlacedBuilding, upId: string): boolean {
    if (!this.canUpgrade(b, upId).ok) return false;
    const before = this.maxHp(b);
    pay(this.state.resources, UPGRADE_BY_ID[upId].cost);
    b.upgrades = [...(b.upgrades ?? []), upId];
    // I punti vita in più si aggiungono a quelli attuali
    if (before) b.hp = (b.hp ?? before) + (this.maxHp(b) - before);
    this.changed();
    return true;
  }

  /** Applica il miglioramento a tutti gli edifici dello stesso tipo, finché bastano le risorse. */
  upgradeAll(defId: string, upId: string): number {
    let n = 0;
    for (const b of this.state.buildings) {
      if (b.defId !== defId || !this.canUpgrade(b, upId).ok) continue;
      const before = this.maxHp(b);
      pay(this.state.resources, UPGRADE_BY_ID[upId].cost);
      b.upgrades = [...(b.upgrades ?? []), upId];
      if (before) b.hp = (b.hp ?? before) + (this.maxHp(b) - before);
      n++;
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
      cost[id as ResourceId] = Math.ceil((n ?? 0) * 0.6 * missing);
    }
    return cost;
  }

  repair(b: PlacedBuilding): boolean {
    if (this.isForeign(b) || this.locked) return false;
    const cost = this.repairCost(b);
    if (!Object.keys(cost).length || !canAfford(this.state.resources, cost)) return false;
    const was = this.hpState(b);
    pay(this.state.resources, cost);
    b.hp = this.maxHp(b);
    if (was !== 'ok') this.changed();
    else this.emit();
    return true;
  }

  repairAll(): number {
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
    else if (n) this.emit();
    return n;
  }

  // ───────────── Costruzione ─────────────

  canPlace(defId: string, x: number, z: number): PlaceCheck {
    const def = getBuilding(defId);
    if (!isAvailable(def, this.date.year)) {
      return { ok: false, reason: `Disponibile dal ${def.minYear}` };
    }
    if (this.locked) return { ok: false, reason: 'In attesa dell\'altro giocatore' };
    if (def.unique && this.count(def.id) > 0) return { ok: false, reason: 'Ne puoi avere uno solo' };
    const [w, d] = def.size;
    const t = this.territory();
    if (x < t.x0 || z < t.z0 || x + w > t.x1 || z + d > t.z1) return { ok: false, reason: 'Fuori dal tuo territorio' };
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
    if (!canAfford(this.state.resources, def.cost)) return { ok: false, reason: 'Risorse insufficienti' };
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
    pay(this.state.resources, def.cost);
    const b: PlacedBuilding = { uid: this.state.nextUid++, defId, x, z, upgrades: [] };
    if (def.herd) b.herd = def.herd.start;
    if (def.hp) b.hp = def.hp;
    this.state.buildings.push(b);
    this.mark(b, b.uid);
    return b;
  }

  place(defId: string, x: number, z: number): PlacedBuilding | null {
    const b = this.placeQuiet(defId, x, z);
    if (b) this.changed();
    return b;
  }

  /** Costruisce lungo una fila di caselle (mura, fossati, strade). */
  placeLine(defId: string, tiles: Array<[number, number]>): { placed: number; reason?: string } {
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
    if (this.locked) return false;
    const i = this.state.buildings.findIndex((b) => b.uid === uid);
    if (i < 0) return false;
    const b = this.state.buildings[i];
    const def = getBuilding(b.defId);
    for (const [id, n] of Object.entries(def.cost)) {
      this.state.resources[id as ResourceId] += Math.floor((n ?? 0) * 0.5);
    }
    if (def.herd && b.herd) this.slaughter(def.herd.species, Math.floor(b.herd));
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
    if (!canAfford(this.state.resources, UNITS[unit].cost)) return { ok: false, reason: 'Risorse insufficienti' };
    return { ok: true };
  }

  recruit(unit: UnitType, n = 1): number {
    let done = 0;
    for (let i = 0; i < n && this.canRecruit(unit).ok; i++) {
      pay(this.state.resources, UNITS[unit].cost);
      this.state.population -= 1;
      this.state.army[unit] += 1;
      done++;
    }
    if (done) this.emit();
    return done;
  }

  dismiss(unit: UnitType, n = 1): number {
    const done = Math.min(n, this.state.army[unit]);
    this.state.army[unit] -= done;
    this.state.population += done;
    if (done) this.emit();
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
    return Math.ceil(this.price(id) * 1.25 * 10) / 10;
  }

  sellPrice(id: ResourceId): number {
    return Math.floor(this.price(id) * 0.8 * 10) / 10;
  }

  trade(id: ResourceId, amount: number): PlaceCheck {
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
    this.emit();
    return { ok: true };
  }

  /** Riceve una carovana da un altro giocatore. */
  receive(goods: Cost, from: string) {
    const cap = this.storageCap();
    for (const [id, n] of Object.entries(goods)) {
      const rid = id as ResourceId;
      if (!RESOURCE_IDS.includes(rid) || !n || n <= 0) continue;
      this.state.resources[rid] = rid === 'coins' ? this.state.resources[rid] + n : Math.min(cap, this.state.resources[rid] + n);
    }
    this.log(`Carovana ricevuta da ${from}.`, 'good');
    this.emit();
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
    this.emit();
  }

  private step(dt: number) {
    const s = this.state;
    const r = s.resources;
    s.day += dt;
    const date = dateFromDays(s.day);
    const si = seasonIndex(date.season);

    if (date.year !== this.lastYear) this.onNewYear(date.year);
    if (si !== this.lastSeasonIndex) this.onNewSeason(si);

    const a = this.analysis();
    const pop0 = s.population;
    const staffing = a.jobs > 0 ? Math.min(1, pop0 / a.jobs) : 1;

    // Produzione degli edifici (le strade aumentano la resa)
    for (const { b, def } of this.defsPlaced()) {
      if (def.produces) {
        let factor = staffing * (def.seasonal ? def.seasonal[si] : 1) * dt * (a.connected.get(b.uid) ?? 1);
        if (def.consumes) {
          for (const [id, n] of Object.entries(def.consumes)) {
            const need = (n ?? 0) * factor;
            if (need > 0) factor *= Math.min(1, r[id as ResourceId] / need);
          }
          for (const [id, n] of Object.entries(def.consumes)) r[id as ResourceId] -= (n ?? 0) * factor;
        }
        for (const [id, n] of Object.entries(def.produces)) r[id as ResourceId] += (n ?? 0) * factor;
      }
      if (def.herd && b.herd !== undefined) this.stepHerd(b, def, si, staffing, dt);
    }

    // Alimentazione
    const pop = s.population;
    let need = (pop * FOOD_PER_PERSON + this.soldiers() * SOLDIER_FOOD) * dt;
    const needed = need;
    let variety = 0;
    for (const id of EATING_ORDER) {
      if (r[id] > 0.5) variety++;
      const eat = Math.min(r[id], need);
      r[id] -= eat;
      need -= eat;
    }
    const fed = needed > 0 ? 1 - need / needed : 1;

    // Popolazione
    if (fed < 0.99) {
      s.population -= pop * 0.01 * (1 - fed) * dt;
    } else if (pop < a.housing) {
      const growth = (0.03 + pop * 0.0008) * (1 + 0.08 * Math.max(0, variety - 1));
      s.population = Math.min(a.housing, pop + growth * dt);
    }
    if (s.population > a.housing) s.population -= (s.population - a.housing) * 0.02 * dt;
    s.population = Math.max(0, s.population);

    // Tasse
    r.coins += s.population * TAX_PER_PERSON * a.taxMul * dt;

    // Mantenimento dell'esercito
    for (const id of Object.keys(UNITS) as UnitType[]) {
      const n = s.army[id];
      if (!n) continue;
      let ok = true;
      for (const [res, u] of Object.entries(UNITS[id].upkeep)) {
        const cost = (u ?? 0) * n * dt;
        const rid = res as ResourceId;
        if (r[rid] < cost) ok = false;
        r[rid] = Math.max(0, r[rid] - cost);
      }
      if (!ok && this.random() < 0.05 * dt) {
        s.army[id] -= 1;
        this.log(`Un soldato (${UNITS[id].name}) ha disertato: paga o rifornimenti mancanti.`, 'bad');
      }
    }

    // Deperimento e magazzini
    const cap = a.storage;
    for (const id of RESOURCE_IDS) {
      const sp = RESOURCES[id].spoilage;
      if (sp) r[id] -= r[id] * sp * dt;
      if (id !== 'coins' && r[id] > cap) r[id] = cap;
      if (r[id] < 0) r[id] = 0;
    }

    if (s.day >= s.nextRaidDay) this.resolveRaid();
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
    if (n > herd.capacity) {
      const extra = Math.floor(n - herd.capacity);
      if (extra > 0) this.slaughter(herd.species, extra);
      n = Math.min(n, herd.capacity);
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
      this.log(`Nuova epoca: ${after.name}. ${after.description}`, 'good');
    }
  }

  // ───────────── Assedi ─────────────

  /** Fotografia delle difese, usata dalla simulazione dell'assedio (anche per gli attacchi tra giocatori). */
  siegeSnapshot(): DefenderSnapshot {
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
      if (def.fort === 'moat') {
        moatTiles++;
        depth += this.moatDepth(b);
        if (a.flooded.has(b.uid)) flooded++;
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
        upgrades: [...(b.upgrades ?? [])],
        defense: def.defense ?? 0,
        moatAhead: def.fort === 'gate' ? this.gateHasMoat(b) : undefined,
      });
    }
    return {
      segments,
      closed: a.closed,
      moat: {
        tiles: moatTiles,
        coverage: Math.min(1, moatTiles / Math.max(8, ring * 0.8)),
        depth: moatTiles ? depth / moatTiles : 1,
        flooded: moatTiles ? flooded / moatTiles : 0,
        stakes: moatTiles ? stakes / moatTiles : 0,
      },
      army: { ...this.state.army },
      armory: this.state.buildings.some((b) => b.upgrades?.includes('armory')),
      cistern: this.state.buildings.some((b) => b.upgrades?.includes('cistern')),
      charcoal: this.state.resources.charcoal,
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
    const size = Math.round((8 + (year - 900) / 14 + wealth * 0.5) * (0.8 + this.random() * 0.4));
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
    };
  }

  private resolveRaid() {
    const s = this.state;
    const army = this.raiderArmy();
    s.nextRaidDay = s.day + 300 + this.random() * 300;
    this.besiege(army);
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
    for (const k of ['infantry', 'archers', 'cavalry'] as const) {
      s.army[k] = Math.max(0, s.army[k] - result.defenderLosses[k]);
    }
    s.resources.charcoal = Math.max(0, s.resources.charcoal - result.charcoalUsed);
    const cistern = this.state.buildings.some((b) => b.upgrades?.includes('cistern'));
    let loot = 0;
    const atkLost = result.attackerLosses.infantry + result.attackerLosses.archers + result.attackerLosses.cavalry;
    const defLost = result.defenderLosses.infantry + result.defenderLosses.archers + result.defenderLosses.cavalry;
    if (result.outcome === 'repelled') {
      loot = Math.round(atkLost * 3);
      s.resources.coins += loot;
      this.log(`${army.name} respinti! Nemici caduti: ${atkLost}, nostri caduti: ${defLost}. Bottino: ${loot} monete.`, 'good');
    } else {
      const ratio = result.outcome === 'held' ? 0.15 : 0.45;
      for (const id of RESOURCE_IDS) s.resources[id] *= 1 - ratio;
      const dead = Math.floor(s.population * (result.outcome === 'held' ? 0.04 : 0.15) * (cistern ? 0.5 : 1));
      s.population -= dead;
      this.log(
        result.outcome === 'held'
          ? `${army.name} hanno saccheggiato il borgo (−${Math.round(ratio * 100)}% scorte, ${dead} morti), ma il mastio ha resistito.`
          : `${army.name} hanno espugnato il castello! Perse il ${Math.round(ratio * 100)}% delle scorte e ${dead} abitanti.`,
        'bad',
      );
    }
    s.lastSiege = {
      day: s.day,
      attacker: army.name,
      outcome: result.outcome,
      log: result.log,
      attackerLosses: atkLost,
      defenderLosses: defLost,
      loot,
    };
    if (visual) this.changed();
    else this.emit();
    return result;
  }

  /** Giorni al prossimo assalto (per l'interfaccia). */
  daysToRaid(): number {
    return Math.max(0, this.state.nextRaidDay - this.state.day);
  }
}
