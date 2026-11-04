import { supabase } from '../config/supabase';
import { createInitialState, type GameState } from '../game/sim/state';
import { PRESET_LIST, type PresetId } from '../game/world/presets';
import { localIdentity, LocalMatchService, SupabaseMatchService, type MatchInfo, type MatchService } from '../net/match';
import { CloudSaveStore, LocalSaveStore, type SaveStore } from '../save/store';
import { el } from './dom';
import { showLobby } from './lobby';

export interface Session {
  userId: string | null;
  name: string;
  store: SaveStore;
}

export interface StartResult {
  session: Session;
  state: GameState;
  /** Presente nelle partite multigiocatore. */
  match?: { info: MatchInfo; service: MatchService };
}

/** Schermata iniziale: accesso (o ospite), poi continua o nuova partita. */
export function showStartScreen(root: HTMLElement): Promise<StartResult> {
  return new Promise((resolve) => {
    const overlay = el('div', { class: 'start' });
    const card = el('div', { class: 'start-card' });
    overlay.append(card);
    root.append(overlay);

    const finish = (r: StartResult) => {
      overlay.remove();
      resolve(r);
    };

    const header = () =>
      el(
        'div',
        { class: 'start-header' },
        el('h1', { text: 'Medieval' }),
        el('p', { class: 'muted', text: 'Costruisci e governa un castello dal 900 al 1400.' }),
      );

    const showError = (msg: string) => {
      card.querySelector('.error')?.remove();
      card.append(el('p', { class: 'error', text: msg }));
    };

    /** Prima scelta dopo l'accesso: giocatore singolo o multigiocatore. */
    function chooseGame(session: Session) {
      card.classList.remove('wide');
      const single = el(
        'button',
        { class: 'mode' },
        el('span', { class: 'icon', text: '🏰' }),
        el('strong', { text: 'Giocatore singolo' }),
        el('span', { class: 'small muted', text: 'Il tuo castello contro i predoni, al tuo ritmo.' }),
      );
      single.onclick = () => void singlePlayer(session);
      const multi = el(
        'button',
        { class: 'mode' },
        el('span', { class: 'icon', text: '⚔️' }),
        el('strong', { text: 'Multigiocatore' }),
        el('span', { class: 'small muted', text: 'Due signori sulla stessa mappa: si gioca quando siete online entrambi.' }),
      );
      multi.onclick = () => void openLobby(session);
      const items: Node[] = [
        header(),
        el('p', { text: `Ciao ${session.name}! Come vuoi giocare?` }),
        el('div', { class: 'modes' }, single, multi),
      ];
      if (session.userId && supabase) {
        const out = el('button', { class: 'link', text: 'Esci dall\'account' });
        out.onclick = async () => {
          await supabase!.auth.signOut();
          showLogin();
        };
        items.push(out);
      }
      card.replaceChildren(...items);
    }

    async function singlePlayer(session: Session) {
      card.replaceChildren(header(), el('p', { class: 'muted', text: 'Caricamento…' }));
      let existing: GameState | null = null;
      try {
        existing = await session.store.load();
      } catch (e) {
        showError(`Impossibile leggere il salvataggio: ${(e as Error).message}`);
      }
      const nameInput = el('input', { type: 'text', placeholder: 'Nome del castello', maxlength: '40', value: 'Rocca di ' + session.name });
      const mapSelect = el('select');
      for (const p of PRESET_LIST) mapSelect.append(el('option', { value: p.id, text: `${p.icon} ${p.name} — ${p.description}` }));
      const newBtn = el('button', { class: 'primary', text: 'Nuova partita in solitario' });
      newBtn.onclick = () => {
        if (existing && !confirm('Iniziare una nuova partita sovrascriverà il salvataggio attuale. Continuare?')) return;
        const seed = Math.floor(Math.random() * 2 ** 31);
        finish({ session, state: createInitialState(seed, nameInput.value.trim() || 'Castello senza nome', { preset: mapSelect.value as PresetId }) });
      };
      const back = el('button', { class: 'link', text: '← Indietro' });
      back.onclick = () => chooseGame(session);
      const items: Node[] = [
        el('div', { class: 'row' }, el('h2', { text: '🏰 Giocatore singolo' }), el('span', { class: 'spacer' }), back),
        el('p', { class: 'small muted', text: `I salvataggi sono su: ${session.store.label}.` }),
      ];
      if (existing) {
        const year = 900 + Math.floor(existing.day / 360);
        const cont = el('button', { class: 'primary', text: `Continua: ${existing.castleName} (anno ${year})` });
        cont.onclick = () => finish({ session, state: existing! });
        items.push(cont, el('hr'));
      }
      items.push(el('label', { text: 'Nuovo castello' }), nameInput, el('label', { text: 'Mappa' }), mapSelect, newBtn);
      card.replaceChildren(...items);
    }

    async function openLobby(session: Session) {
      const service: MatchService =
        session.userId && supabase
          ? new SupabaseMatchService(supabase, { id: session.userId, name: session.name })
          : new LocalMatchService(localIdentity(session.name === 'Ospite' ? `Ospite ${Math.floor(Math.random() * 90 + 10)}` : session.name));
      const choice = await showLobby(card, service, () => chooseGame(session));
      card.replaceChildren(header(), el('p', { class: 'muted', text: 'Caricamento della partita…' }));
      const info = choice.match;
      let state: GameState | null = null;
      try {
        state = await service.loadState(info.id);
      } catch (e) {
        showError(`Impossibile leggere la partita: ${(e as Error).message}`);
        return;
      }
      const slot: 0 | 1 = info.hostId === service.me.id ? 0 : 1;
      state ??= createInitialState(info.seed, choice.castleName, { preset: info.preset, match: { id: info.id, slot } });
      // Chi si unisce più tardi parte dal giorno della partita
      if (slot === 1 && state.day < info.day) state.day = info.day;
      finish({ session: { ...session, name: service.me.name }, state, match: { info, service } });
    }

    function guest() {
      chooseGame({ userId: null, name: 'Ospite', store: new LocalSaveStore() });
    }

    async function fromUser(userId: string, email: string | undefined, meta: Record<string, unknown>) {
      let name = (meta.username as string) || email?.split('@')[0] || 'Signore';
      const { data } = await supabase!.from('profiles').select('username').eq('id', userId).maybeSingle();
      if (data?.username) name = data.username;
      chooseGame({ userId, name, store: new CloudSaveStore(supabase!, userId) });
    }

    function showLogin() {
      if (!supabase) {
        card.replaceChildren(
          header(),
          el('p', {
            class: 'muted',
            text: 'Supabase non è configurato (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY): si gioca offline, con salvataggio nel browser.',
          }),
        );
        const b = el('button', { class: 'primary', text: 'Gioca offline' });
        b.onclick = guest;
        card.append(b);
        return;
      }
      let mode: 'login' | 'signup' = 'login';
      const email = el('input', { type: 'email', placeholder: 'Email', autocomplete: 'email' });
      const password = el('input', { type: 'password', placeholder: 'Password (min. 6 caratteri)', autocomplete: 'current-password' });
      const username = el('input', { type: 'text', placeholder: 'Nome del signore', maxlength: '24' });
      const submit = el('button', { class: 'primary', type: 'submit' });
      const toggle = el('button', { class: 'link', type: 'button' });
      const guestBtn = el('button', { type: 'button', text: 'Gioca come ospite (salvataggio nel browser)' });
      guestBtn.onclick = guest;
      const form = el('form', { class: 'auth-form' });
      const render = () => {
        submit.textContent = mode === 'login' ? 'Accedi' : 'Crea account';
        toggle.textContent = mode === 'login' ? 'Non hai un account? Registrati' : 'Hai già un account? Accedi';
        password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
        form.replaceChildren(...(mode === 'signup' ? [username] : []), email, password, submit);
      };
      toggle.onclick = () => {
        mode = mode === 'login' ? 'signup' : 'login';
        render();
      };
      form.onsubmit = async (e) => {
        e.preventDefault();
        submit.disabled = true;
        try {
          if (mode === 'login') {
            const { data, error } = await supabase!.auth.signInWithPassword({ email: email.value, password: password.value });
            if (error) throw error;
            await fromUser(data.user.id, data.user.email, data.user.user_metadata);
          } else {
            const { data, error } = await supabase!.auth.signUp({
              email: email.value,
              password: password.value,
              options: { data: { username: username.value.trim() || email.value.split('@')[0] }, emailRedirectTo: location.origin },
            });
            if (error) throw error;
            if (data.session && data.user) await fromUser(data.user.id, data.user.email, data.user.user_metadata);
            else showError('Controlla la tua email per confermare l\'account, poi accedi.');
          }
        } catch (err) {
          showError((err as Error).message);
        } finally {
          submit.disabled = false;
        }
      };
      render();
      card.replaceChildren(header(), form, toggle, el('hr'), guestBtn);
    }

    if (supabase) {
      card.replaceChildren(header(), el('p', { class: 'muted', text: 'Connessione…' }));
      supabase.auth
        .getSession()
        .then(({ data }) => {
          const u = data.session?.user;
          if (u) fromUser(u.id, u.email, u.user_metadata);
          else showLogin();
        })
        .catch(() => showLogin());
    } else {
      showLogin();
    }
  });
}
