import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { migrateState, type GameState, type PlacedBuilding } from '../game/sim/state';
import type { PresetId } from '../game/world/presets';

/**
 * Partite a due giocatori su una mappa condivisa.
 *
 * - Chi crea la partita ("host") tiene l'orologio: il tempo scorre solo quando sono online entrambi.
 * - Ogni giocatore simula il proprio castello e invia all'altro i propri edifici.
 * - Lo stato di ciascuno si salva nel database (tabella match_players), il giorno nella partita.
 *
 * Due implementazioni con la stessa interfaccia: Supabase (online) e locale (tra schede dello
 * stesso browser, per provare senza account).
 */

export interface MatchInfo {
  id: string;
  name: string;
  preset: PresetId;
  seed: number;
  hostId: string;
  hostName: string;
  guestId: string | null;
  guestName: string | null;
  status: 'waiting' | 'active';
  day: number;
  updatedAt: string;
}

export interface Me {
  id: string;
  name: string;
}

export interface ClockMsg {
  day: number;
  speed: number;
}

export interface MatchRoom {
  /** Id dei giocatori collegati in questo momento (incluso sé stessi). */
  readonly online: Set<string>;
  onPresence(fn: (online: Set<string>) => void): void;
  onClock(fn: (c: ClockMsg) => void): void;
  onBuildings(fn: (from: string, list: PlacedBuilding[], castle: string) => void): void;
  onSpeedRequest(fn: (speed: number) => void): void;
  sendClock(c: ClockMsg): void;
  sendBuildings(list: PlacedBuilding[], castle: string): void;
  requestSpeed(speed: number): void;
  leave(): Promise<void>;
}

export interface MatchService {
  readonly kind: 'online' | 'local';
  readonly me: Me;
  listMine(): Promise<MatchInfo[]>;
  listOpen(): Promise<MatchInfo[]>;
  create(name: string, preset: PresetId): Promise<MatchInfo>;
  join(id: string): Promise<MatchInfo>;
  get(id: string): Promise<MatchInfo | null>;
  loadState(matchId: string): Promise<GameState | null>;
  saveState(matchId: string, state: GameState): Promise<void>;
  connect(match: MatchInfo): Promise<MatchRoom>;
}

/** Forma compatta degli edifici da inviare in rete. */
export function packBuildings(list: PlacedBuilding[]): PlacedBuilding[] {
  return list.map((b) => ({
    uid: b.uid,
    defId: b.defId,
    x: b.x,
    z: b.z,
    ...(b.hp !== undefined ? { hp: Math.round(b.hp) } : {}),
    ...(b.upgrades?.length ? { upgrades: b.upgrades } : {}),
    ...(b.herd !== undefined ? { herd: Math.round(b.herd) } : {}),
  }));
}

const randomSeed = () => Math.floor(Math.random() * 2 ** 31);

// ───────────── Supabase ─────────────

interface MatchRow {
  id: string;
  name: string;
  preset: PresetId;
  seed: number;
  host_id: string;
  host_name: string;
  guest_id: string | null;
  guest_name: string | null;
  status: 'waiting' | 'active';
  day: number;
  updated_at: string;
}

const fromRow = (r: MatchRow): MatchInfo => ({
  id: r.id,
  name: r.name,
  preset: r.preset,
  seed: r.seed,
  hostId: r.host_id,
  hostName: r.host_name,
  guestId: r.guest_id,
  guestName: r.guest_name,
  status: r.status,
  day: r.day,
  updatedAt: r.updated_at,
});

export class SupabaseMatchService implements MatchService {
  readonly kind = 'online' as const;

  constructor(private db: SupabaseClient, readonly me: Me) {}

  async listMine() {
    const { data, error } = await this.db
      .from('matches')
      .select('*')
      .or(`host_id.eq.${this.me.id},guest_id.eq.${this.me.id}`)
      .order('updated_at', { ascending: false })
      .limit(20);
    if (error) throw error;
    return (data as MatchRow[]).map(fromRow);
  }

  async listOpen() {
    const { data, error } = await this.db
      .from('matches')
      .select('*')
      .eq('status', 'waiting')
      .is('guest_id', null)
      .neq('host_id', this.me.id)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw error;
    return (data as MatchRow[]).map(fromRow);
  }

  async create(name: string, preset: PresetId) {
    const { data, error } = await this.db
      .from('matches')
      .insert({ name, preset, seed: randomSeed(), host_id: this.me.id, host_name: this.me.name, status: 'waiting' })
      .select()
      .single();
    if (error) throw error;
    return fromRow(data as MatchRow);
  }

  async join(id: string) {
    const { data, error } = await this.db
      .from('matches')
      .update({ guest_id: this.me.id, guest_name: this.me.name, status: 'active', updated_at: new Date().toISOString() })
      .eq('id', id)
      .is('guest_id', null)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('La partita è già al completo.');
    return fromRow(data as MatchRow);
  }

  async get(id: string) {
    const { data, error } = await this.db.from('matches').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data ? fromRow(data as MatchRow) : null;
  }

  async loadState(matchId: string) {
    const { data, error } = await this.db
      .from('match_players')
      .select('state')
      .eq('match_id', matchId)
      .eq('user_id', this.me.id)
      .maybeSingle();
    if (error) throw error;
    return data ? migrateState(data.state) : null;
  }

  async saveState(matchId: string, state: GameState) {
    const now = new Date().toISOString();
    const { error } = await this.db
      .from('match_players')
      .upsert({ match_id: matchId, user_id: this.me.id, state, updated_at: now }, { onConflict: 'match_id,user_id' });
    if (error) throw error;
    if (state.match?.slot === 0) {
      await this.db.from('matches').update({ day: state.day, updated_at: now }).eq('id', matchId).eq('host_id', this.me.id);
    }
  }

  async connect(match: MatchInfo): Promise<MatchRoom> {
    const channel = this.db.channel(`match:${match.id}`, {
      config: { presence: { key: this.me.id }, broadcast: { self: false } },
    });
    const room = new SupabaseRoom(channel, this.me);
    await room.start();
    return room;
  }
}

class Emitter<T extends unknown[]> {
  private fns: Array<(...a: T) => void> = [];
  on(fn: (...a: T) => void) {
    this.fns.push(fn);
  }
  emit(...a: T) {
    for (const f of this.fns) f(...a);
  }
}

class SupabaseRoom implements MatchRoom {
  readonly online = new Set<string>();
  private presence = new Emitter<[Set<string>]>();
  private clock = new Emitter<[ClockMsg]>();
  private buildings = new Emitter<[string, PlacedBuilding[], string]>();
  private speed = new Emitter<[number]>();

  constructor(private channel: RealtimeChannel, private me: Me) {}

  async start() {
    const ch = this.channel;
    ch.on('presence', { event: 'sync' }, () => {
      this.online.clear();
      for (const key of Object.keys(ch.presenceState())) this.online.add(key);
      this.online.add(this.me.id);
      this.presence.emit(new Set(this.online));
    })
      .on('broadcast', { event: 'clock' }, ({ payload }) => this.clock.emit(payload as ClockMsg))
      .on('broadcast', { event: 'buildings' }, ({ payload }) => {
        const p = payload as { from: string; list: PlacedBuilding[]; castle: string };
        if (p.from !== this.me.id) this.buildings.emit(p.from, p.list, p.castle);
      })
      .on('broadcast', { event: 'speed' }, ({ payload }) => this.speed.emit((payload as { speed: number }).speed));
    await new Promise<void>((resolve, reject) => {
      ch.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await ch.track({ id: this.me.id, name: this.me.name, at: Date.now() });
          resolve();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          reject(new Error(`Connessione alla partita fallita (${status})`));
        }
      });
    });
  }

  onPresence(fn: (o: Set<string>) => void) {
    this.presence.on(fn);
  }
  onClock(fn: (c: ClockMsg) => void) {
    this.clock.on(fn);
  }
  onBuildings(fn: (from: string, list: PlacedBuilding[], castle: string) => void) {
    this.buildings.on(fn);
  }
  onSpeedRequest(fn: (s: number) => void) {
    this.speed.on(fn);
  }
  sendClock(c: ClockMsg) {
    void this.channel.send({ type: 'broadcast', event: 'clock', payload: c });
  }
  sendBuildings(list: PlacedBuilding[], castle: string) {
    void this.channel.send({ type: 'broadcast', event: 'buildings', payload: { from: this.me.id, list, castle } });
  }
  requestSpeed(speed: number) {
    void this.channel.send({ type: 'broadcast', event: 'speed', payload: { speed } });
  }
  async leave() {
    await this.channel.untrack();
    await this.channel.unsubscribe();
  }
}

// ───────────── Locale (tra schede dello stesso browser) ─────────────

const LOCAL_MATCHES = 'medieval.local.matches';
const localStateKey = (matchId: string, userId: string) => `medieval.local.state.${matchId}.${userId}`;

function readMatches(): MatchInfo[] {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_MATCHES) ?? '[]') as MatchInfo[];
  } catch {
    return [];
  }
}

function writeMatches(list: MatchInfo[]) {
  try {
    localStorage.setItem(LOCAL_MATCHES, JSON.stringify(list));
  } catch {
    /* storage non disponibile */
  }
}

/** Identità del giocatore locale: una per scheda (sessionStorage), così due schede sono due giocatori. */
export function localIdentity(name: string): Me {
  let id: string | null = null;
  try {
    id = sessionStorage.getItem('medieval.local.player');
    if (!id) {
      id = `local-${Math.random().toString(36).slice(2, 10)}`;
      sessionStorage.setItem('medieval.local.player', id);
    }
  } catch {
    id = `local-${Math.random().toString(36).slice(2, 10)}`;
  }
  return { id, name };
}

export class LocalMatchService implements MatchService {
  readonly kind = 'local' as const;

  constructor(readonly me: Me) {}

  async listMine() {
    return readMatches()
      .filter((m) => m.hostId === this.me.id || m.guestId === this.me.id)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async listOpen() {
    return readMatches().filter((m) => m.status === 'waiting' && !m.guestId && m.hostId !== this.me.id);
  }

  async create(name: string, preset: PresetId) {
    const m: MatchInfo = {
      id: `m-${Math.random().toString(36).slice(2, 10)}`,
      name,
      preset,
      seed: randomSeed(),
      hostId: this.me.id,
      hostName: this.me.name,
      guestId: null,
      guestName: null,
      status: 'waiting',
      day: 0,
      updatedAt: new Date().toISOString(),
    };
    writeMatches([...readMatches(), m]);
    return m;
  }

  async join(id: string) {
    const list = readMatches();
    const m = list.find((x) => x.id === id);
    if (!m) throw new Error('Partita non trovata.');
    if (m.guestId && m.guestId !== this.me.id) throw new Error('La partita è già al completo.');
    m.guestId = this.me.id;
    m.guestName = this.me.name;
    m.status = 'active';
    m.updatedAt = new Date().toISOString();
    writeMatches(list);
    return m;
  }

  async get(id: string) {
    return readMatches().find((m) => m.id === id) ?? null;
  }

  async loadState(matchId: string) {
    try {
      const raw = localStorage.getItem(localStateKey(matchId, this.me.id));
      return raw ? migrateState(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }

  async saveState(matchId: string, state: GameState) {
    try {
      localStorage.setItem(localStateKey(matchId, this.me.id), JSON.stringify(state));
    } catch {
      /* ignora */
    }
    const list = readMatches();
    const m = list.find((x) => x.id === matchId);
    if (m) {
      if (m.hostId === this.me.id) m.day = state.day;
      m.updatedAt = new Date().toISOString();
      writeMatches(list);
    }
  }

  async connect(match: MatchInfo): Promise<MatchRoom> {
    return new LocalRoom(match.id, this.me);
  }
}

/** Presenza e messaggi via BroadcastChannel, con battito ogni secondo. */
class LocalRoom implements MatchRoom {
  readonly online = new Set<string>();
  private seen = new Map<string, number>();
  private bc: BroadcastChannel;
  private timer: ReturnType<typeof setInterval>;
  private presence = new Emitter<[Set<string>]>();
  private clock = new Emitter<[ClockMsg]>();
  private buildings = new Emitter<[string, PlacedBuilding[], string]>();
  private speed = new Emitter<[number]>();
  private onUnload = () => this.bc.postMessage({ t: 'bye', id: this.me.id });

  constructor(matchId: string, private me: Me) {
    this.online.add(me.id);
    this.bc = new BroadcastChannel(`medieval-match-${matchId}`);
    this.bc.onmessage = (e) => {
      const m = e.data as { t: string; id: string; [k: string]: unknown };
      if (m.id === this.me.id) return;
      if (m.t === 'hb') this.beat(m.id);
      else if (m.t === 'bye') this.drop(m.id);
      else if (m.t === 'clock') this.clock.emit(m.c as ClockMsg);
      else if (m.t === 'buildings') this.buildings.emit(m.id, m.list as PlacedBuilding[], m.castle as string);
      else if (m.t === 'speed') this.speed.emit(m.speed as number);
    };
    const tick = () => {
      this.bc.postMessage({ t: 'hb', id: this.me.id });
      const now = Date.now();
      for (const [id, at] of this.seen) if (now - at > 3500) this.drop(id);
    };
    tick();
    this.timer = setInterval(tick, 1000);
    window.addEventListener('beforeunload', this.onUnload);
  }

  private beat(id: string) {
    const isNew = !this.seen.has(id);
    this.seen.set(id, Date.now());
    if (isNew) {
      this.online.add(id);
      // Risponde subito, così chi è appena arrivato vede la nostra presenza
      this.bc.postMessage({ t: 'hb', id: this.me.id });
      this.presence.emit(new Set(this.online));
    }
  }

  private drop(id: string) {
    if (!this.seen.delete(id)) return;
    this.online.delete(id);
    this.presence.emit(new Set(this.online));
  }

  onPresence(fn: (o: Set<string>) => void) {
    this.presence.on(fn);
    fn(new Set(this.online));
  }
  onClock(fn: (c: ClockMsg) => void) {
    this.clock.on(fn);
  }
  onBuildings(fn: (from: string, list: PlacedBuilding[], castle: string) => void) {
    this.buildings.on(fn);
  }
  onSpeedRequest(fn: (s: number) => void) {
    this.speed.on(fn);
  }
  sendClock(c: ClockMsg) {
    this.bc.postMessage({ t: 'clock', id: this.me.id, c });
  }
  sendBuildings(list: PlacedBuilding[], castle: string) {
    this.bc.postMessage({ t: 'buildings', id: this.me.id, list, castle });
  }
  requestSpeed(speed: number) {
    this.bc.postMessage({ t: 'speed', id: this.me.id, speed });
  }
  async leave() {
    clearInterval(this.timer);
    window.removeEventListener('beforeunload', this.onUnload);
    this.bc.postMessage({ t: 'bye', id: this.me.id });
    this.bc.close();
  }
}
