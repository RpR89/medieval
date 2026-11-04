import type { SupabaseClient } from '@supabase/supabase-js';
import { migrateState, type GameState } from '../game/sim/state';

export interface SaveStore {
  readonly label: string;
  load(): Promise<GameState | null>;
  save(state: GameState): Promise<void>;
  clear(): Promise<void>;
}

const LOCAL_KEY = 'medieval.save.v1';

/** Salvataggio nel browser, per gli ospiti o senza connessione. */
export class LocalSaveStore implements SaveStore {
  readonly label = 'questo browser';

  async load(): Promise<GameState | null> {
    try {
      const raw = localStorage.getItem(LOCAL_KEY);
      return raw ? migrateState(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }

  async save(state: GameState): Promise<void> {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(state));
    } catch {
      // Storage pieno o bloccato: si continua a giocare senza salvare.
    }
  }

  async clear(): Promise<void> {
    try {
      localStorage.removeItem(LOCAL_KEY);
    } catch {
      /* ignora */
    }
  }
}

/** Salvataggio nel cloud: tabella `saves` su Supabase (vedi supabase/migrations). */
export class CloudSaveStore implements SaveStore {
  readonly label = 'cloud';

  constructor(private db: SupabaseClient, private userId: string, private slot = 1) {}

  async load(): Promise<GameState | null> {
    const { data, error } = await this.db
      .from('saves')
      .select('data')
      .eq('user_id', this.userId)
      .eq('slot', this.slot)
      .maybeSingle();
    if (error) throw error;
    return data ? migrateState(data.data) : null;
  }

  async save(state: GameState): Promise<void> {
    const year = 900 + Math.floor(state.day / 360);
    const { error } = await this.db.from('saves').upsert(
      {
        user_id: this.userId,
        slot: this.slot,
        castle_name: state.castleName,
        game_year: year,
        data: state,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,slot' },
    );
    if (error) throw error;
  }

  async clear(): Promise<void> {
    const { error } = await this.db.from('saves').delete().eq('user_id', this.userId).eq('slot', this.slot);
    if (error) throw error;
  }
}
