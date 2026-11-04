import { PRESET_LIST, PRESETS, type PresetId } from '../game/world/presets';
import type { MatchInfo, MatchService } from '../net/match';
import { el } from './dom';

export interface LobbyChoice {
  match: MatchInfo;
  castleName: string;
}

/**
 * Lobby multigiocatore: le proprie partite (da riprendere), quelle aperte (a cui unirsi)
 * e la creazione di una nuova partita scegliendo la mappa.
 */
export function showLobby(card: HTMLElement, service: MatchService, onBack: () => void): Promise<LobbyChoice> {
  return new Promise((resolve) => {
    let preset: PresetId = 'montana';
    let timer: ReturnType<typeof setInterval> | null = null;
    const done = (c: LobbyChoice) => {
      if (timer) clearInterval(timer);
      resolve(c);
    };

    const castle = el('input', { type: 'text', maxlength: '40', value: `Rocca di ${service.me.name}` });
    const matchName = el('input', { type: 'text', maxlength: '60', value: `Sfida di ${service.me.name}` });
    const mine = el('div', { class: 'lobby-list' });
    const open = el('div', { class: 'lobby-list' });
    const error = el('p', { class: 'error' });
    const presets = el('div', { class: 'presets' });
    const renderPresets = () => {
      presets.replaceChildren(
        ...PRESET_LIST.map((p) => {
          const b = el(
            'button',
            { class: `preset ${p.id === preset ? 'active' : ''}`, type: 'button', title: p.description },
            el('span', { class: 'icon', text: p.icon }),
            el('strong', { text: p.name }),
            el('span', { class: 'small', text: p.description }),
          );
          b.onclick = () => {
            preset = p.id;
            renderPresets();
          };
          return b;
        }),
      );
    };
    renderPresets();

    const create = el('button', { class: 'primary', text: 'Crea la partita e aspetta l\'avversario' });
    create.onclick = async () => {
      create.disabled = true;
      error.textContent = '';
      try {
        const m = await service.create(matchName.value.trim() || 'Partita', preset);
        done({ match: m, castleName: castle.value.trim() || 'Castello' });
      } catch (e) {
        error.textContent = (e as Error).message;
        create.disabled = false;
      }
    };

    const row = (m: MatchInfo, action: 'resume' | 'join') => {
      const p = PRESETS[m.preset] ?? PRESETS.classica;
      const isHost = m.hostId === service.me.id;
      const opponent = isHost ? m.guestName : m.hostName;
      const year = 900 + Math.floor(m.day / 360);
      const btn = el('button', { class: action === 'join' ? 'primary' : '', text: action === 'join' ? 'Unisciti' : 'Riprendi' });
      btn.onclick = async () => {
        btn.disabled = true;
        error.textContent = '';
        try {
          const match = action === 'join' ? await service.join(m.id) : m;
          done({ match, castleName: castle.value.trim() || 'Castello' });
        } catch (e) {
          error.textContent = (e as Error).message;
          btn.disabled = false;
        }
      };
      return el(
        'div',
        { class: 'lobby-row' },
        el('span', { class: 'icon', text: p.icon }),
        el(
          'div',
          { class: 'grow' },
          el('strong', { text: m.name }),
          el('div', {
            class: 'small muted',
            text:
              action === 'join'
                ? `${p.name} · creata da ${m.hostName}`
                : `${p.name} · anno ${year} · ${opponent ? `contro ${opponent}` : 'in attesa di un avversario'}`,
          }),
        ),
        btn,
      );
    };

    let lastKey = '';
    const refresh = async () => {
      try {
        const [a, b] = await Promise.all([service.listMine(), service.listOpen()]);
        // Ridisegna solo se qualcosa è cambiato (i pulsanti non si spostano sotto il mouse)
        const key = JSON.stringify([a, b]);
        if (key === lastKey) return;
        lastKey = key;
        mine.replaceChildren(...(a.length ? a.map((m) => row(m, 'resume')) : [el('p', { class: 'small muted', text: 'Nessuna partita.' })]));
        open.replaceChildren(...(b.length ? b.map((m) => row(m, 'join')) : [el('p', { class: 'small muted', text: 'Nessuna partita aperta: creane una!' })]));
      } catch (e) {
        error.textContent = `Impossibile leggere le partite: ${(e as Error).message}`;
      }
    };
    void refresh();
    timer = setInterval(refresh, 4000);

    const back = el('button', { class: 'link', text: '← Indietro' });
    back.onclick = () => {
      if (timer) clearInterval(timer);
      onBack();
    };
    card.classList.add('wide');
    card.replaceChildren(
      el('div', { class: 'row' }, el('h2', { text: '⚔️ Multigiocatore' }), el('span', { class: 'spacer' }), back),
      el('p', {
        class: 'small muted',
        text:
          service.kind === 'local'
            ? 'Modalità locale di prova: apri il gioco in un\'altra scheda di questo browser per avere il secondo giocatore. Con un account si gioca online.'
            : 'Due giocatori sulla stessa mappa, ognuno con il suo territorio. Il tempo scorre solo quando siete online entrambi; se uno esce la partita si salva e si mette in pausa.',
      }),
      el('label', { text: 'Il tuo castello' }),
      castle,
      el('h4', { text: 'Le tue partite' }),
      mine,
      el('h4', { text: 'Partite aperte' }),
      open,
      el('h4', { text: 'Nuova partita' }),
      el('label', { text: 'Nome della partita' }),
      matchName,
      el('label', { text: 'Mappa' }),
      presets,
      create,
      error,
    );
  });
}
