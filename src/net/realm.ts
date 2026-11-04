import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import type { Cost } from '../game/data/resources';

/** Quello che gli altri giocatori vedono del tuo castello. */
export interface RealmPlayer {
  id: string;
  name: string;
  castle: string;
  year: number;
  population: number;
  power: number;
}

export interface ChatMessage {
  fromId: string;
  fromName: string;
  text: string;
  at: number;
}

export interface Caravan {
  fromId: string;
  fromName: string;
  toId: string;
  goods: Cost;
}

/**
 * Livello di rete del multiplayer. Oggi è implementato con Supabase Realtime;
 * per un server autoritativo (es. Colyseus) basta una seconda implementazione.
 */
export interface RealmTransport {
  join(realm: string, me: RealmPlayer): Promise<void>;
  update(me: RealmPlayer): Promise<void>;
  sendChat(text: string): Promise<void>;
  sendCaravan(toId: string, goods: Cost): Promise<void>;
  leave(): Promise<void>;
  onPlayers(fn: (players: RealmPlayer[]) => void): void;
  onChat(fn: (m: ChatMessage) => void): void;
  onCaravan(fn: (c: Caravan) => void): void;
  readonly connected: boolean;
}

export class SupabaseRealm implements RealmTransport {
  private channel: RealtimeChannel | null = null;
  private me: RealmPlayer | null = null;
  private playersFn: (p: RealmPlayer[]) => void = () => {};
  private chatFn: (m: ChatMessage) => void = () => {};
  private caravanFn: (c: Caravan) => void = () => {};

  constructor(private db: SupabaseClient) {}

  get connected() {
    return this.channel !== null;
  }

  onPlayers(fn: (p: RealmPlayer[]) => void) {
    this.playersFn = fn;
  }
  onChat(fn: (m: ChatMessage) => void) {
    this.chatFn = fn;
  }
  onCaravan(fn: (c: Caravan) => void) {
    this.caravanFn = fn;
  }

  async join(realm: string, me: RealmPlayer) {
    await this.leave();
    this.me = me;
    const channel = this.db.channel(`realm:${realm}`, {
      config: { presence: { key: me.id }, broadcast: { self: true } },
    });
    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState<RealmPlayer>();
        const players = Object.values(state)
          .map((entries) => entries[entries.length - 1])
          .filter(Boolean)
          .map(({ id, name, castle, year, population, power }) => ({ id, name, castle, year, population, power }));
        this.playersFn(players);
      })
      .on('broadcast', { event: 'chat' }, ({ payload }) => this.chatFn(payload as ChatMessage))
      .on('broadcast', { event: 'caravan' }, ({ payload }) => {
        const c = payload as Caravan;
        if (this.me && c.toId === this.me.id && c.fromId !== this.me.id) this.caravanFn(c);
      });
    await new Promise<void>((resolve, reject) => {
      channel.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await channel.track(me);
          resolve();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          reject(new Error(`Connessione al regno fallita (${status})`));
        }
      });
    });
    this.channel = channel;
  }

  async update(me: RealmPlayer) {
    this.me = me;
    await this.channel?.track(me);
  }

  async sendChat(text: string) {
    if (!this.channel || !this.me) return;
    const msg: ChatMessage = { fromId: this.me.id, fromName: this.me.name, text: text.slice(0, 300), at: Date.now() };
    await this.channel.send({ type: 'broadcast', event: 'chat', payload: msg });
  }

  async sendCaravan(toId: string, goods: Cost) {
    if (!this.channel || !this.me) return;
    const c: Caravan = { fromId: this.me.id, fromName: this.me.name, toId, goods };
    await this.channel.send({ type: 'broadcast', event: 'caravan', payload: c });
  }

  async leave() {
    if (this.channel) {
      await this.channel.unsubscribe();
      await this.db.removeChannel(this.channel);
    }
    this.channel = null;
  }
}
