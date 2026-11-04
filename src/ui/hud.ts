import {
  BUILDINGS,
  CATEGORY_NAMES,
  getBuilding,
  isAvailable,
  SPECIES_NAMES,
  type BuildingCategory,
  type UnitType,
} from '../game/data/buildings';
import { formatDate } from '../game/data/calendar';
import { eraForYear } from '../game/data/eras';
import { canAfford, formatCost, RESOURCE_IDS, RESOURCES, type ResourceId } from '../game/data/resources';
import { UNITS } from '../game/data/units';
import type { Game } from '../game/sim/game';
import type { PlacedBuilding } from '../game/sim/state';
import type { ChatMessage, RealmPlayer } from '../net/realm';
import { el, escapeHtml, fmt } from './dom';

export interface HudCallbacks {
  onTool(defId: string | null): void;
  onDeselect(): void;
  onSpeed(speed: number): void;
  onSave(): void;
  onExit(): void;
  /** Passa al livello di qualità grafica successivo e ne restituisce il nome. */
  onQuality(): string;
  qualityLabel: string;
  /** null se il multiplayer non è disponibile (ospite o Supabase non configurato). */
  realm: null | {
    join(name: string): Promise<void>;
    leave(): Promise<void>;
    chat(text: string): Promise<void>;
    caravan(toId: string, res: ResourceId, amount: number): Promise<void>;
  };
}

type Tab = 'castle' | 'army' | 'market' | 'realm';
const SPEEDS = [0, 1, 2, 4, 8];

export class Hud {
  private top: HTMLElement;
  private dateEl: HTMLElement;
  private eraEl: HTMLElement;
  private raidEl: HTMLElement;
  private saveEl: HTMLElement;
  private speedBtns: HTMLButtonElement[] = [];
  private resEls = new Map<ResourceId, HTMLElement>();
  private buildList: HTMLElement;
  private buildBtns = new Map<string, HTMLButtonElement>();
  private category: BuildingCategory = 'fortification';
  private catBtns = new Map<BuildingCategory, HTMLButtonElement>();
  private panel: HTMLElement;
  private panelBody: HTMLElement;
  private tabBtns = new Map<Tab, HTMLButtonElement>();
  private refreshTab: () => void = () => {};
  private selPanel: HTMLElement;
  selected: PlacedBuilding | null = null;
  private logEl: HTMLElement;
  private logKey = '';
  private toastEl: HTMLElement;
  private hintEl: HTMLElement;
  private activeTool: string | null = null;
  private players: RealmPlayer[] = [];
  private chat: ChatMessage[] = [];
  private realmName = 'regno-1';
  private realmJoined = false;

  constructor(root: HTMLElement, private game: Game, private cb: HudCallbacks, accountLabel: string) {
    // ───── Barra superiore ─────
    this.dateEl = el('span', { class: 'date' });
    this.eraEl = el('span', { class: 'era' });
    this.raidEl = el('span', { class: 'raid' });
    this.saveEl = el('span', { class: 'muted small' });
    const speeds = el('div', { class: 'speeds' });
    SPEEDS.forEach((s) => {
      const b = el('button', { text: s === 0 ? '⏸' : `${s}×`, title: s === 0 ? 'Pausa (spazio)' : `Velocità ${s}×` });
      b.onclick = () => cb.onSpeed(s);
      this.speedBtns.push(b);
      speeds.append(b);
    });
    const saveBtn = el('button', { text: '💾', title: 'Salva ora' });
    saveBtn.onclick = () => cb.onSave();
    const qualityBtn = el('button', { text: `🎨 ${cb.qualityLabel}`, title: 'Qualità grafica (clic per cambiare)' });
    qualityBtn.onclick = () => {
      qualityBtn.textContent = `🎨 ${cb.onQuality()}`;
    };
    const exitBtn = el('button', { text: '⎋', title: 'Torna al menu' });
    exitBtn.onclick = () => cb.onExit();
    const resBar = el('div', { class: 'resources' });
    for (const id of RESOURCE_IDS) {
      const v = el('span', { class: 'v' });
      const item = el('span', { class: 'res', title: RESOURCES[id].name }, RESOURCES[id].icon, v);
      this.resEls.set(id, v);
      resBar.append(item);
    }
    this.top = el(
      'header',
      { class: 'top' },
      el(
        'div',
        { class: 'row' },
        el('strong', { class: 'castle', text: game.state.castleName }),
        this.dateEl,
        this.eraEl,
        this.raidEl,
        el('span', { class: 'spacer' }),
        speeds,
        this.saveEl,
        saveBtn,
        qualityBtn,
        el('span', { class: 'muted small', text: accountLabel }),
        exitBtn,
      ),
      resBar,
    );

    // ───── Menu costruzioni ─────
    const cats = el('div', { class: 'cats' });
    for (const c of Object.keys(CATEGORY_NAMES) as BuildingCategory[]) {
      const b = el('button', { text: CATEGORY_NAMES[c].split(' ')[0], title: CATEGORY_NAMES[c] });
      b.onclick = () => {
        this.category = c;
        this.renderBuildList();
      };
      this.catBtns.set(c, b);
      cats.append(b);
    }
    this.buildList = el('div', { class: 'build-list' });
    const build = el('aside', { class: 'build panel' }, el('h3', { text: 'Costruisci' }), cats, this.buildList);

    // ───── Pannello laterale ─────
    const tabs = el('div', { class: 'tabs' });
    const tabNames: Record<Tab, string> = { castle: '🏰 Castello', army: '⚔️ Esercito', market: '⚖️ Mercato', realm: '👥 Regno' };
    for (const t of Object.keys(tabNames) as Tab[]) {
      const b = el('button', { text: tabNames[t] });
      b.onclick = () => this.setTab(t);
      this.tabBtns.set(t, b);
      tabs.append(b);
    }
    this.panelBody = el('div', { class: 'panel-body' });
    this.panel = el('aside', { class: 'side panel' }, tabs, this.panelBody);
    this.selPanel = el('div', { class: 'selection panel hidden' });

    this.logEl = el('div', { class: 'log panel' });
    this.toastEl = el('div', { class: 'toasts' });
    this.hintEl = el('div', {
      class: 'hint',
      text: 'Trascina: sposta · Tasto destro: ruota · Rotella: zoom · WASD: muovi · Spazio: pausa',
    });

    root.append(this.top, build, this.panel, this.selPanel, this.logEl, this.toastEl, this.hintEl);
    this.renderBuildList();
    this.setTab('castle');
    game.onEvent((e) => {
      if (e.kind !== 'info') this.toast(e.text, e.kind);
    });
  }

  // ───────────── Costruzioni ─────────────

  private renderBuildList() {
    for (const [c, b] of this.catBtns) b.classList.toggle('active', c === this.category);
    this.buildList.replaceChildren();
    this.buildBtns.clear();
    const year = this.game.date.year;
    for (const def of BUILDINGS.filter((b) => b.category === this.category)) {
      if (def.maxYear !== undefined && year >= def.maxYear) continue;
      const btn = el(
        'button',
        { class: 'build-item', title: def.description },
        el('span', { class: 'name', text: def.name }),
        el('span', { class: 'cost', text: formatCost(def.cost) }),
        el('span', { class: 'meta', text: this.metaFor(def.id) }),
      );
      btn.onclick = () => {
        if (btn.classList.contains('locked')) return;
        this.cb.onTool(this.activeTool === def.id ? null : def.id);
      };
      this.buildBtns.set(def.id, btn);
      this.buildList.append(btn);
    }
    this.refreshBuildList();
  }

  private metaFor(id: string): string {
    const d = getBuilding(id);
    const parts = [`${d.size[0]}×${d.size[1]}`];
    if (d.workers) parts.push(`👷${d.workers}`);
    if (d.housing) parts.push(`🛏️${d.housing}`);
    if (d.defense) parts.push(`🛡️${d.defense}`);
    if (d.produces) parts.push('→ ' + Object.keys(d.produces).map((r) => RESOURCES[r as ResourceId].icon).join(''));
    if (d.herd) parts.push(`${SPECIES_NAMES[d.herd.species]} max ${d.herd.capacity}`);
    return parts.join(' · ');
  }

  private refreshBuildList() {
    const year = this.game.date.year;
    for (const [id, btn] of this.buildBtns) {
      const def = getBuilding(id);
      const locked = !isAvailable(def, year);
      btn.classList.toggle('locked', locked);
      btn.classList.toggle('poor', !locked && !canAfford(this.game.state.resources, def.cost));
      btn.classList.toggle('active', this.activeTool === id);
      btn.classList.toggle('done', !!def.unique && this.game.count(id) > 0);
      const meta = btn.querySelector('.meta')!;
      const text = locked ? `🔒 Dal ${def.minYear}` : this.metaFor(id);
      if (meta.textContent !== text) meta.textContent = text;
    }
  }

  setTool(defId: string | null) {
    this.activeTool = defId;
    this.refreshBuildList();
    this.hintEl.textContent = defId
      ? `Costruisci: ${getBuilding(defId).name} — ${getBuilding(defId).draggable ? 'clic, oppure trascina per tracciare una linea (anche in diagonale)' : 'clic per piazzare'} · Esc o tasto destro: annulla`
      : 'Trascina: sposta · Tasto destro: ruota · Rotella: zoom · WASD: muovi · Spazio: pausa';
  }

  // ───────────── Selezione ─────────────

  private selDyn: HTMLElement = el('div');
  private selKey = '';

  select(b: PlacedBuilding | null) {
    this.selected = b;
    this.selKey = '';
    this.selPanel.classList.toggle('hidden', !b);
    if (!b) return;
    const def = getBuilding(b.defId);
    const demolish = el('button', { class: 'danger', text: 'Demolisci (rimborso 50%)' });
    demolish.onclick = () => {
      this.game.demolish(b.uid);
      this.cb.onDeselect();
    };
    const close = el('button', { class: 'link', text: '✕' });
    close.onclick = () => this.cb.onDeselect();
    const lines: string[] = [def.description];
    const list = (o: Partial<Record<string, number>>) =>
      Object.entries(o).map(([r, n]) => `${RESOURCES[r as ResourceId].icon} ${n}`).join(', ');
    if (def.produces) lines.push('Produce al giorno: ' + list(def.produces));
    if (def.consumes) lines.push('Consuma al giorno: ' + list(def.consumes));
    if (def.seasonal) {
      const s = def.seasonal.map((v) => `${Math.round(v * 100)}%`);
      lines.push(`Resa stagionale: 🌸${s[0]} ☀️${s[1]} 🍂${s[2]} ❄️${s[3]}`);
    }
    if (def.workers) lines.push(`Lavoratori: ${def.workers}`);
    if (def.housing) lines.push(`Alloggi: ${def.housing}`);
    this.selDyn = el('div', { class: 'sel-dyn' });
    const foreign = this.game.isForeign(b);
    this.selPanel.replaceChildren(
      el('div', { class: 'row' }, el('h3', { text: def.name }), el('span', { class: 'spacer' }), close),
      ...(foreign ? [el('p', { class: 'bad small', text: '🔵 Appartiene all\'altro giocatore' })] : []),
      ...lines.map((l) => el('p', { class: 'small', text: l })),
      this.selDyn,
      ...(foreign ? [] : [demolish]),
    );
    this.refreshSelection();
  }

  private refreshSelection() {
    const b = this.selected;
    if (!b) return;
    if (!this.game.byUid(b.uid)) {
      this.cb.onDeselect();
      return;
    }
    const g = this.game;
    const def = getBuilding(b.defId);
    const ups = g.upgradeOptions(b);
    const checks = ups.map((u) => g.canUpgrade(b, u.id));
    const repairCost = g.repairCost(b);
    const key = JSON.stringify([
      Math.round(b.hp ?? 0), b.upgrades, Math.round(b.herd ?? 0), checks.map((c) => c.ok),
      canAfford(g.state.resources, repairCost), g.structureVersion,
    ]);
    if (key === this.selKey) return;
    this.selKey = key;
    const parts: Node[] = [];
    if (def.herd) parts.push(el('p', { text: `${SPECIES_NAMES[def.herd.species]}: ${Math.round(b.herd ?? 0)} / ${def.herd.capacity} capi` }));
    if (!def.fort && !def.road && (def.produces || def.herd)) {
      const bonus = g.roadBonus(b);
      parts.push(
        el('p', {
          class: bonus > 1 ? 'good small' : 'bad small',
          text: bonus > 1 ? `🛣️ Collegato alla rete stradale: produzione +${Math.round((bonus - 1) * 100)}%` : '🛣️ Non collegato: costruisci una strada fino al castello o al mercato (+15%)',
        }),
      );
    }
    if (def.fort) {
      const max = g.maxHp(b);
      if (max) {
        const hp = Math.max(0, Math.round(b.hp ?? max));
        const st = g.hpState(b);
        const pct = Math.round((hp / max) * 100);
        parts.push(
          el('div', { class: 'hp' }, el('div', { class: `hp-bar ${st}`, style: `width:${pct}%` })),
          el('p', { class: 'small', text: `Punti vita ${hp} / ${max}${st === 'ruin' ? ' — IN ROVINA: la cinta ha una breccia!' : st === 'damaged' ? ' — danneggiato' : ''}` }),
        );
        if (Object.keys(repairCost).length) {
          const rb = el('button', { text: `🔨 Ripara (${formatCost(repairCost)})` });
          rb.disabled = !canAfford(g.state.resources, repairCost);
          rb.onclick = () => g.repair(b);
          parts.push(rb);
        }
      }
      if (def.fort === 'moat') {
        parts.push(el('p', { class: 'small', text: `Profondità ${g.moatDepth(b)}/3 · ${g.moatFlooded(b) ? '💧 Allagato (difesa ×1,6)' : 'Asciutto'}` }));
      }
      parts.push(el('p', { class: 'small', text: `🛡️ Difesa: ${fmt(g.defenseOf(b))}${!g.analysis().closed && def.fort !== 'keep' && def.fort !== 'moat' ? ' (dimezzata: cinta aperta)' : ''}` }));
    }
    if (ups.length) {
      parts.push(el('h4', { text: 'Miglioramenti' }));
      ups.forEach((u, i) => {
        const done = b.upgrades?.includes(u.id);
        const c = checks[i];
        const row = el('div', { class: `upgrade ${done ? 'done' : ''}` });
        row.append(
          el('div', { class: 'row' }, el('strong', { text: `${u.icon} ${u.name}` }), el('span', { class: 'spacer' }), el('span', { class: 'small', text: done ? '✓' : formatCost(u.cost) })),
          el('div', { class: 'small muted', text: u.description }),
        );
        if (!done) {
          const btns = el('div', { class: 'row' });
          const one = el('button', { text: 'Costruisci' });
          one.disabled = !c.ok;
          one.onclick = () => g.upgrade(b, u.id);
          btns.append(one);
          const same = g.state.buildings.filter((x) => x.defId === b.defId && !x.upgrades?.includes(u.id)).length;
          if (same > 1) {
            const all = el('button', { text: `Su tutti (${same})` });
            all.disabled = !c.ok;
            all.onclick = () => {
              const n = g.upgradeAll(b.defId, u.id);
              this.toast(`${u.name}: applicato a ${n} ${def.name.toLowerCase()}.`, 'good');
            };
            btns.append(all);
          }
          if (!c.ok && c.reason) btns.append(el('span', { class: 'small muted', text: c.reason }));
          row.append(btns);
        }
        parts.push(row);
      });
    }
    this.selDyn.replaceChildren(...parts);
  }

  // ───────────── Pannelli ─────────────

  private setTab(t: Tab) {
    for (const [k, b] of this.tabBtns) b.classList.toggle('active', k === t);
    this.panelBody.replaceChildren();
    if (t === 'castle') this.buildCastleTab();
    else if (t === 'army') this.buildArmyTab();
    else if (t === 'market') this.buildMarketTab();
    else this.buildRealmTab();
  }

  private buildCastleTab() {
    const defense = el('div');
    const repairAll = el('button', { text: '🔨 Ripara tutte le fortificazioni' });
    repairAll.onclick = () => {
      const n = this.game.repairAll();
      this.toast(n ? `Riparate ${n} fortificazioni.` : 'Niente da riparare (o risorse insufficienti).', n ? 'good' : 'info');
    };
    const siege = el('div');
    const body = el('div');
    this.panelBody.append(defense, repairAll, siege, body);
    let lastSiege = -1;
    this.refreshTab = () => {
      const g = this.game;
      const s = g.summary();
      const d = g.defenseBreakdown();
      const era = eraForYear(s.date.year);
      defense.innerHTML = `
        <h4>🏰 Difese</h4>
        <p class="${d.closed ? 'good' : 'bad'}">${d.closed
          ? '✓ Cinta muraria chiusa attorno al mastio'
          : '✗ Cinta aperta: il nemico entra senza assaltare le mura (difese dimezzate). Chiudi l\'anello di mura, torri e porte attorno al mastio; fiumi e mare fanno da barriera.'}</p>
        <table>
          <tr><td>Mura</td><td>${fmt(d.walls)}</td></tr>
          <tr><td>Torri</td><td>${fmt(d.towers)}</td></tr>
          <tr><td>Porte</td><td>${fmt(d.gates)}</td></tr>
          <tr><td>Fossati</td><td>${fmt(d.moats)}</td></tr>
          <tr><td>Mastio</td><td>${fmt(d.keep)}</td></tr>
          <tr><td>⚔️ Guarnigione</td><td>${fmt(d.army)} (${s.soldiers} soldati)</td></tr>
        </table>
        ${d.damaged || d.ruined ? `<p class="bad small">Danneggiate: ${d.damaged} · In rovina: ${d.ruined}</p>` : ''}`;
      repairAll.classList.toggle('hidden', !d.damaged && !d.ruined && !g.state.buildings.some((b) => (b.hp ?? 0) < g.maxHp(b)));
      const ls = g.state.lastSiege;
      if (ls && ls.day !== lastSiege) {
        lastSiege = ls.day;
        const title = { repelled: '🛡️ Respinto', held: '🏰 Il mastio ha resistito', sacked: '🔥 Castello espugnato' }[ls.outcome];
        siege.innerHTML = `<h4>Ultimo assedio — ${escapeHtml(ls.attacker)}</h4>
          <p class="${ls.outcome === 'repelled' ? 'good' : 'bad'}">${title} · caduti nemici ${ls.attackerLosses}, nostri ${ls.defenderLosses}${ls.loot ? ` · bottino ${ls.loot} 🪙` : ''}</p>
          <ol class="small siege-log">${ls.log.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ol>`;
      }
      body.innerHTML = `
        <h4>${escapeHtml(era.name)}</h4>
        <p class="muted small">${escapeHtml(era.description)}</p>
        <table>
          <tr><td>👪 Abitanti</td><td>${Math.floor(s.population)} / ${s.housing}</td></tr>
          <tr><td>👷 Posti di lavoro</td><td>${s.jobs} (copertura ${Math.round(s.staffing * 100)}%)</td></tr>
          <tr><td>🍞 Cibo al giorno</td><td>${fmt(s.foodPerDay)}</td></tr>
          <tr><td>📦 Magazzini</td><td>${s.storage} per risorsa</td></tr>
        </table>
        <p class="small muted">Il cibo si consuma partendo da quello più deperibile. Una dieta varia fa crescere la popolazione più in fretta.</p>`;
    };
  }

  private buildArmyTab() {
    const rows = el('div');
    const info = el('p', { class: 'small muted' });
    this.panelBody.append(rows, info);
    const units = Object.keys(UNITS) as UnitType[];
    const counts = new Map<UnitType, HTMLElement>();
    const reasons = new Map<UnitType, HTMLElement>();
    for (const u of units) {
      const def = UNITS[u];
      const count = el('strong');
      const reason = el('span', { class: 'small muted' });
      const mk = (label: string, fn: () => void) => {
        const b = el('button', { text: label });
        b.onclick = fn;
        return b;
      };
      counts.set(u, count);
      reasons.set(u, reason);
      rows.append(
        el(
          'div',
          { class: 'unit' },
          el('div', { class: 'row' }, el('span', { text: `${def.icon} ${def.name}` }), el('span', { class: 'spacer' }), count),
          el('div', { class: 'small muted', text: `Costo ${formatCost(def.cost)} · Paga ${formatCost(def.upkeep)}/giorno · Att ${def.attack} Dif ${def.defense}` }),
          el(
            'div',
            { class: 'row' },
            mk('+1', () => this.game.recruit(u, 1)),
            mk('+5', () => this.game.recruit(u, 5)),
            mk('−1', () => this.game.dismiss(u, 1)),
            reason,
          ),
        ),
      );
    }
    this.refreshTab = () => {
      for (const u of units) {
        counts.get(u)!.textContent = String(this.game.state.army[u]);
        const c = this.game.canRecruit(u);
        reasons.get(u)!.textContent = c.ok ? '' : c.reason ?? '';
      }
      const d = Math.ceil(this.game.daysToRaid());
      info.textContent = `Difesa totale: ${fmt(this.game.fortDefense() * 0.8 + this.game.armyPower())}. Gli arcieri rendono di più con le torri. Le spie segnalano movimenti di nemici tra circa ${d} giorni.`;
    };
  }

  private buildMarketTab() {
    const wrap = el('div');
    const warn = el('p', { class: 'small muted' });
    const table = el('table', { class: 'market' });
    wrap.append(warn, table);
    this.panelBody.append(wrap);
    const cells = new Map<ResourceId, { buy: HTMLElement; sell: HTMLElement }>();
    for (const id of RESOURCE_IDS) {
      if (id === 'coins') continue;
      const buy = el('td');
      const sell = el('td');
      const bBtn = el('button', { text: '+10' });
      bBtn.onclick = () => this.tradeResult(this.game.trade(id, 10));
      const sBtn = el('button', { text: '−10' });
      sBtn.onclick = () => this.tradeResult(this.game.trade(id, -10));
      cells.set(id, { buy, sell });
      table.append(el('tr', {}, el('td', { text: `${RESOURCES[id].icon} ${RESOURCES[id].name}` }), buy, el('td', {}, bBtn), sell, el('td', {}, sBtn)));
    }
    this.refreshTab = () => {
      warn.textContent = this.game.summary().hasMarket
        ? 'Prezzo d\'acquisto e di vendita per unità. Il cibo costa di più in inverno.'
        : 'Costruisci un mercato per commerciare.';
      for (const [id, c] of cells) {
        c.buy.textContent = `🪙${this.game.buyPrice(id)}`;
        c.sell.textContent = `🪙${this.game.sellPrice(id)}`;
      }
    };
  }

  private tradeResult(r: { ok: boolean; reason?: string }) {
    if (!r.ok) this.toast(r.reason ?? 'Operazione non riuscita', 'bad');
  }

  private buildRealmTab() {
    if (!this.cb.realm) {
      this.panelBody.append(
        el('p', { text: 'Il multiplayer richiede un account.' }),
        el('p', { class: 'small muted', text: 'Accedi (o configura Supabase) per entrare in un regno con altri giocatori: chat, classifica e carovane di merci.' }),
      );
      this.refreshTab = () => {};
      return;
    }
    const realm = this.cb.realm;
    const name = el('input', { type: 'text', value: this.realmName, maxlength: '32' });
    const joinBtn = el('button', { class: 'primary' });
    const players = el('div', { class: 'players' });
    const chatLog = el('div', { class: 'chat' });
    const chatInput = el('input', { type: 'text', placeholder: 'Scrivi ai signori del regno…', maxlength: '300' });
    const chatForm = el('form', { class: 'row' }, chatInput, el('button', { text: 'Invia' }));
    chatForm.onsubmit = (e) => {
      e.preventDefault();
      if (chatInput.value.trim()) realm.chat(chatInput.value.trim());
      chatInput.value = '';
    };
    joinBtn.onclick = async () => {
      joinBtn.disabled = true;
      try {
        if (this.realmJoined) {
          await realm.leave();
          this.realmJoined = false;
          this.players = [];
        } else {
          this.realmName = name.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'regno-1';
          name.value = this.realmName;
          await realm.join(this.realmName);
          this.realmJoined = true;
        }
      } catch (e) {
        this.toast((e as Error).message, 'bad');
      } finally {
        joinBtn.disabled = false;
        this.setTab('realm');
      }
    };
    this.panelBody.append(
      el('label', { text: 'Nome del regno' }),
      el('div', { class: 'row' }, name, joinBtn),
      el('h4', { text: 'Signori presenti' }),
      players,
      el('h4', { text: 'Chat' }),
      chatLog,
      chatForm,
    );
    let lastPlayers = '';
    let lastChat = -1;
    this.refreshTab = () => {
      joinBtn.textContent = this.realmJoined ? 'Esci' : 'Entra';
      name.disabled = this.realmJoined;
      chatInput.disabled = !this.realmJoined;
      const key = JSON.stringify(this.players);
      if (key !== lastPlayers) {
        lastPlayers = key;
        players.replaceChildren();
        if (!this.realmJoined) players.append(el('p', { class: 'small muted', text: 'Non sei in nessun regno.' }));
        for (const p of [...this.players].sort((a, b) => b.power + b.population - (a.power + a.population))) {
          const row = el(
            'div',
            { class: 'player' },
            el('div', { html: `<strong>${escapeHtml(p.castle)}</strong> <span class="muted small">di ${escapeHtml(p.name)}</span>` }),
            el('div', { class: 'small muted', text: `Anno ${p.year} · 👪 ${p.population} · ⚔️ ${Math.round(p.power)}` }),
          );
          if (this.myId !== p.id) {
            const sel = el('select');
            for (const id of RESOURCE_IDS) sel.append(el('option', { value: id, text: `${RESOURCES[id].icon} ${RESOURCES[id].name}` }));
            const amt = el('input', { type: 'number', value: '20', min: '1', class: 'amount' });
            const send = el('button', { text: 'Invia carovana' });
            send.onclick = () => realm.caravan(p.id, sel.value as ResourceId, Math.floor(Number(amt.value)));
            row.append(el('div', { class: 'row' }, sel, amt, send));
          }
          players.append(row);
        }
      }
      if (this.chat.length !== lastChat) {
        lastChat = this.chat.length;
        chatLog.replaceChildren(
          ...this.chat.slice(-30).map((m) => el('p', { html: `<strong>${escapeHtml(m.fromName)}:</strong> ${escapeHtml(m.text)}` })),
        );
        chatLog.scrollTop = chatLog.scrollHeight;
      }
    };
  }

  myId: string | null = null;

  setPlayers(p: RealmPlayer[]) {
    this.players = p;
  }

  addChat(m: ChatMessage) {
    this.chat.push(m);
    if (this.chat.length > 100) this.chat.shift();
  }

  // ───────────── Aggiornamento ─────────────

  setSaveStatus(text: string) {
    this.saveEl.textContent = text;
  }

  toast(text: string, kind: 'good' | 'bad' | 'info' = 'info') {
    const t = el('div', { class: `toast ${kind}`, text });
    this.toastEl.append(t);
    setTimeout(() => t.classList.add('fade'), 5000);
    setTimeout(() => t.remove(), 5600);
  }

  refresh(speed: number) {
    const g = this.game;
    const d = g.date;
    this.dateEl.textContent = formatDate(d);
    this.eraEl.textContent = eraForYear(d.year).name;
    const days = g.daysToRaid();
    this.raidEl.textContent = days < 60 ? `⚠️ Nemici in avvicinamento (${Math.ceil(days)} gg)` : '';
    this.speedBtns.forEach((b, i) => b.classList.toggle('active', SPEEDS[i] === speed));
    const cap = g.storageCap();
    for (const [id, e] of this.resEls) {
      const v = g.state.resources[id];
      e.textContent = fmt(v);
      e.parentElement!.classList.toggle('empty', v < 1);
      e.parentElement!.classList.toggle('full', id !== 'coins' && v >= cap - 0.5);
      e.parentElement!.title = `${RESOURCES[id].name}: ${fmt(v)}${id !== 'coins' ? ` / ${cap}` : ''}`;
    }
    this.refreshBuildList();
    this.refreshTab();
    this.refreshSelection();
    const last = g.state.log.at(-1);
    const logKey = `${g.state.log.length}:${last?.day}:${last?.text}`;
    if (logKey !== this.logKey) {
      this.logKey = logKey;
      this.logEl.replaceChildren(
        ...g.state.log.slice(-6).map((e) => el('p', { class: e.kind, text: e.text })),
      );
    }
  }

  get isTyping(): boolean {
    const a = document.activeElement;
    return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT');
  }

  destroy() {
    this.top.remove();
    this.panel.remove();
    this.selPanel.remove();
    this.logEl.remove();
    this.toastEl.remove();
    this.hintEl.remove();
    document.querySelector('.build')?.remove();
  }
}
