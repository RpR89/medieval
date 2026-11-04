import { PRESETS } from '../game/world/presets';
import type { Game } from '../game/sim/game';
import { el, escapeHtml } from '../ui/dom';
import { packBuildings, type MatchInfo, type MatchRoom, type MatchService } from './match';

/**
 * Gestisce una partita in corso tra due giocatori:
 * - finché non sono online entrambi il gioco è bloccato (niente tempo, niente costruzioni);
 * - chi ha creato la partita tiene l'orologio e la velocità, l'altro si allinea;
 * - ognuno invia all'altro i propri edifici;
 * - se uno esce, la partita si salva e si mette in pausa finché non torna.
 */
export class MatchSession {
  readonly isHost: boolean;
  private bothOnline = false;
  private everMet: boolean;
  private overlay: HTMLElement;
  private hostDay: number;
  private hostSpeed = 1;
  private lastClock = 0;
  private lastSent = 0;
  private lastKey = '';
  private saving: Promise<void> | null = null;
  private onStatus: (text: string, kind: 'good' | 'bad' | 'info') => void;

  constructor(
    private game: Game,
    private info: MatchInfo,
    private service: MatchService,
    private room: MatchRoom,
    root: HTMLElement,
    onStatus: (text: string, kind: 'good' | 'bad' | 'info') => void,
  ) {
    this.onStatus = onStatus;
    this.isHost = info.hostId === service.me.id;
    this.everMet = !!info.guestId;
    this.hostDay = game.state.day;
    this.overlay = el('div', { class: 'match-wait' });
    root.append(this.overlay);
    game.locked = true;

    room.onPresence((online) => void this.presenceChanged(online));
    room.onClock((c) => {
      if (this.isHost) return;
      this.hostDay = c.day;
      this.hostSpeed = c.speed;
      // L'ospite si allinea al giorno dell'host (recupera se è indietro)
      const gap = c.day - this.game.state.day;
      if (gap > 0.3) this.game.advance(Math.min(gap, 400));
    });
    room.onBuildings((_from, list) => game.setOthers(list));
    room.onSpeedRequest((s) => {
      if (this.isHost) this.hostSpeed = s;
    });
    this.render();
    void this.presenceChanged(room.online);
  }

  private get opponentName(): string {
    return (this.isHost ? this.info.guestName : this.info.hostName) ?? 'l\'avversario';
  }

  private async presenceChanged(online: Set<string>) {
    const others = [...online].filter((id) => id !== this.service.me.id);
    const was = this.bothOnline;
    this.bothOnline = others.length > 0;
    if (this.bothOnline && !was) {
      // Aggiorna le informazioni (nome dell'avversario appena entrato)
      const fresh = await this.service.get(this.info.id).catch(() => null);
      if (fresh) this.info = fresh;
      this.everMet = true;
      this.sendBuildings(true);
      if (this.isHost) this.room.sendClock({ day: this.game.state.day, speed: this.hostSpeed });
      this.onStatus(`${this.opponentName} è online: la partita riprende!`, 'good');
    } else if (!this.bothOnline && was) {
      this.onStatus(`${this.opponentName} è uscito: partita salvata e in pausa.`, 'bad');
      void this.save();
    }
    this.game.locked = !this.bothOnline;
    this.render();
  }

  private render() {
    const p = PRESETS[this.info.preset] ?? PRESETS.classica;
    this.overlay.classList.toggle('hidden', this.bothOnline);
    if (this.bothOnline) return;
    const waitingFirst = !this.everMet && this.isHost;
    this.overlay.innerHTML = waitingFirst
      ? `<h3>In attesa del secondo giocatore<span class="dots"></span></h3>
         <p>La partita <strong>${escapeHtml(this.info.name)}</strong> (${p.icon} ${escapeHtml(p.name)}) è pronta.</p>
         <p class="small muted">L'altro giocatore la trova tra le <em>Partite aperte</em>. Intanto puoi esplorare la mappa: si comincia quando entra.</p>`
      : `<h3>${escapeHtml(this.opponentName)} non è online<span class="dots"></span></h3>
         <p>La partita <strong>${escapeHtml(this.info.name)}</strong> è salvata.</p>
         <p class="small muted">Riprenderà quando sarete di nuovo connessi entrambi.</p>`;
  }

  /** Velocità effettiva del gioco: zero se manca un giocatore, altrimenti quella dell'host. */
  speed(local: number): number {
    if (!this.bothOnline) return 0;
    if (this.isHost) {
      this.hostSpeed = local;
      return local;
    }
    // L'ospite non può andare più avanti dell'host
    if (this.game.state.day > this.hostDay + 1) return 0;
    return this.hostSpeed;
  }

  /** L'ospite chiede all'host di cambiare velocità. */
  requestSpeed(s: number) {
    if (!this.isHost) this.room.requestSpeed(s);
  }

  get displaySpeed(): number {
    return this.bothOnline ? this.hostSpeed : 0;
  }

  /** Da chiamare a ogni fotogramma. */
  tick(now: number) {
    if (!this.bothOnline) return;
    if (this.isHost && now - this.lastClock > 1000) {
      this.lastClock = now;
      this.room.sendClock({ day: this.game.state.day, speed: this.hostSpeed });
    }
    if (now - this.lastSent > 500) {
      this.lastSent = now;
      this.sendBuildings(now % 10000 < 500);
    }
  }

  private sendBuildings(force: boolean) {
    const b = this.game.state.buildings;
    let hp = 0;
    let ups = 0;
    for (const x of b) {
      hp += Math.round(x.hp ?? 0);
      ups += x.upgrades?.length ?? 0;
    }
    const key = `${b.length}:${this.game.state.nextUid}:${hp}:${ups}`;
    if (!force && key === this.lastKey) return;
    this.lastKey = key;
    this.room.sendBuildings(packBuildings(b), this.game.state.castleName);
  }

  save(): Promise<void> {
    if (this.saving) return this.saving;
    this.saving = this.service
      .saveState(this.info.id, this.game.state)
      .catch((e) => this.onStatus(`Salvataggio della partita fallito: ${(e as Error).message}`, 'bad'))
      .finally(() => {
        this.saving = null;
      });
    return this.saving;
  }

  async leave() {
    await this.save();
    await this.room.leave();
  }
}
