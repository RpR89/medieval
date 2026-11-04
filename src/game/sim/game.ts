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
import {
  generateTerrain,
  isBuildableLand,
  isWater,
  Tile,
  tileAt,
  type Terrain,
} from '../world/terrain';
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
}

type Listener = () => void;

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
  /** Cresce a ogni costruzione/demolizione: la grafica lo usa per sapere cosa ricostruire. */
  structureVersion = 0;

  constructor(public state: GameState, private random: () => number = Math.random) {
    this.terrain = generateTerrain(state.seed);
    this.occupancy = new Int32Array(this.terrain.size * this.terrain.size);
    for (const b of state.buildings) this.mark(b, b.uid);
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

  buildingAt(x: number, z: number): PlacedBuilding | undefined {
    if (x < 0 || z < 0 || x >= this.terrain.size || z >= this.terrain.size) return undefined;
    const uid = this.occupancy[z * this.terrain.size + x];
    return uid ? this.state.buildings.find((b) => b.uid === uid) : undefined;
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
    return this.state.buildings.filter((b) => b.defId.startsWith('tower_') || b.defId === 'gatehouse').length;
  }

  storageCap(): number {
    let cap = BASE_STORAGE;
    for (const { def } of this.defsPlaced()) cap += def.storage ?? 0;
    return cap;
  }

  fortDefense(): number {
    let d = 0;
    for (const { def } of this.defsPlaced()) d += def.defense ?? 0;
    return d;
  }

  armyPower(): number {
    const towerMul = 1 + Math.min(2, this.towers() * (UNITS.archers.towerBonus ?? 0));
    let p = 0;
    for (const id of Object.keys(UNITS) as UnitType[]) {
      const u = UNITS[id];
      const mul = id === 'archers' ? towerMul : 1;
      p += this.state.army[id] * (u.defense * mul + u.attack * 0.5);
    }
    return p;
  }

  summary(): Summary {
    const date = this.date;
    let housing = BASE_HOUSING;
    let jobs = 0;
    for (const { def } of this.defsPlaced()) {
      housing += def.housing ?? 0;
      jobs += def.workers;
    }
    const pop = this.state.population;
    return {
      date,
      eraName: eraForYear(date.year).name,
      population: pop,
      housing,
      jobs,
      staffing: jobs > 0 ? Math.min(1, pop / jobs) : 1,
      soldiers: this.soldiers(),
      storage: this.storageCap(),
      foodPerDay: pop * FOOD_PER_PERSON + this.soldiers() * SOLDIER_FOOD,
      defense: this.fortDefense(),
      armyPower: this.armyPower(),
      hasMarket: this.has((d) => !!d.market),
    };
  }

  availableBuildings(): BuildingDef[] {
    const year = this.date.year;
    return BUILDINGS.filter((b) => isAvailable(b, year));
  }

  // ───────────── Costruzione ─────────────

  canPlace(defId: string, x: number, z: number): PlaceCheck {
    const def = getBuilding(defId);
    if (!isAvailable(def, this.date.year)) {
      return { ok: false, reason: `Disponibile dal ${def.minYear}` };
    }
    if (def.unique && this.count(def.id) > 0) return { ok: false, reason: 'Ne puoi avere uno solo' };
    const [w, d] = def.size;
    let rock = 0;
    let gold = 0;
    for (let dz = 0; dz < d; dz++) {
      for (let dx = 0; dx < w; dx++) {
        const t = tileAt(this.terrain, x + dx, z + dz);
        if (t === undefined) return { ok: false, reason: 'Fuori dalla mappa' };
        if (this.occupancy[(z + dz) * this.terrain.size + x + dx]) return { ok: false, reason: 'Spazio occupato' };
        if (isWater(t)) return { ok: false, reason: 'Non si costruisce sull\'acqua' };
        if (t === Tile.Rock) rock++;
        if (t === Tile.Gold) gold++;
        if (def.placement !== 'rock' && def.placement !== 'goldVein' && !isBuildableLand(t)) {
          return { ok: false, reason: t === Tile.Forest ? 'C\'è il bosco' : 'Terreno roccioso' };
        }
      }
    }
    const area = w * d;
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

  place(defId: string, x: number, z: number): PlacedBuilding | null {
    const check = this.canPlace(defId, x, z);
    if (!check.ok) return null;
    const def = getBuilding(defId);
    pay(this.state.resources, def.cost);
    const b: PlacedBuilding = { uid: this.state.nextUid++, defId, x, z };
    if (def.herd) b.herd = def.herd.start;
    this.state.buildings.push(b);
    this.mark(b, b.uid);
    this.structureVersion++;
    this.emit();
    return b;
  }

  demolish(uid: number): boolean {
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
    this.structureVersion++;
    this.emit();
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

    const sum = this.summary();
    const staffing = sum.staffing;

    // Produzione degli edifici
    for (const { b, def } of this.defsPlaced()) {
      if (def.produces) {
        let factor = staffing * (def.seasonal ? def.seasonal[si] : 1) * dt;
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
    let need = sum.foodPerDay * dt;
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
    } else if (pop < sum.housing) {
      const growth = (0.03 + pop * 0.0008) * (1 + 0.08 * Math.max(0, variety - 1));
      s.population = Math.min(sum.housing, pop + growth * dt);
    }
    if (s.population > sum.housing) s.population -= (s.population - sum.housing) * 0.02 * dt;
    s.population = Math.max(0, s.population);

    // Tasse
    let taxMul = 1;
    for (const { def } of this.defsPlaced()) taxMul += def.taxBonus ?? 0;
    r.coins += s.population * TAX_PER_PERSON * taxMul * dt;

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
    const cap = sum.storage;
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
    const care = 0.4 + 0.6 * staffing;

    for (const [id, v] of Object.entries(a.daily)) {
      r[id as ResourceId] += (v ?? 0) * a.dailySeasonal[si] * n * care * dt;
    }

    if (si === 3) {
      // Inverno: foraggio dalle scorte
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

    if (n >= 2) n += (n * a.birthRate[si] * care * dt) / DAYS_PER_SEASON;
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

  private resolveRaid() {
    const s = this.state;
    const year = this.date.year;
    const name =
      year < 960
        ? 'Razziatori ungari'
        : year < 1070
          ? 'Predoni vichinghi'
          : year < 1250
            ? 'L\'esercito di un barone rivale'
            : 'Una compagnia di ventura';
    const wealth = s.resources.coins / 120 + s.population * 0.25;
    const strength = Math.round((10 + (year - 900) * 0.12 + wealth) * (0.7 + this.random() * 0.6));
    const defense = Math.round(this.fortDefense() * 0.8 + this.armyPower());
    s.nextRaidDay = s.day + 300 + this.random() * 300;

    if (defense >= strength) {
      const loss = Math.min(0.5, (strength / Math.max(1, defense)) * 0.15);
      let lost = 0;
      for (const id of Object.keys(s.army) as UnitType[]) {
        const l = Math.floor(s.army[id] * loss);
        s.army[id] -= l;
        lost += l;
      }
      const loot = Math.round(strength * 2);
      s.resources.coins += loot;
      this.log(
        `${name} (forza ${strength}) respinti dalle difese (${defense})! Bottino: ${loot} monete${lost ? `, caduti: ${lost}` : ''}.`,
        'good',
      );
    } else {
      const ratio = Math.min(0.6, 0.2 + (strength - defense) / Math.max(1, strength) * 0.4);
      for (const id of RESOURCE_IDS) s.resources[id] *= 1 - ratio;
      const dead = Math.floor(s.population * ratio * 0.3);
      s.population -= dead;
      for (const id of Object.keys(s.army) as UnitType[]) s.army[id] = Math.floor(s.army[id] * 0.6);
      this.log(
        `${name} (forza ${strength}) hanno superato le difese (${defense})! Perso il ${Math.round(ratio * 100)}% delle scorte e ${dead} abitanti.`,
        'bad',
      );
    }
  }

  /** Giorni al prossimo assalto (per l'interfaccia). */
  daysToRaid(): number {
    return Math.max(0, this.state.nextRaidDay - this.state.day);
  }
}
