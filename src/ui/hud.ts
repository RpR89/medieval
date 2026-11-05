import {
  BUILDINGS,
  CATEGORY_NAMES,
  getBuilding,
  isAvailable,
  SPECIES_NAMES,
  type BuildingCategory,
  type UnitType,
} from '../game/data/buildings';
import { formatDate, formatDuration } from '../game/data/calendar';
import { eraForYear } from '../game/data/eras';
import { canAfford, formatCost, RESOURCE_IDS, RESOURCES, TAX_LEVELS, type ResourceId } from '../game/data/resources';
import { BEHAVIORS, ENGINES, FORMATIONS, UNITS, type Behavior, type EngineType, type Formation, type Stance } from '../game/data/units';
import type { Force } from '../game/sim/state';
import { CASTLE_LEVELS, KEEP_EVOLVE, UPGRADE_BY_ID } from '../game/data/upgrades';
import { Game } from '../game/sim/game';
import { PERSONALITIES } from '../game/sim/lords';
import { SIDE_COLORS } from '../render/armies';
import type { PlacedBuilding } from '../game/sim/state';
import type { ChatMessage, RealmPlayer } from '../net/realm';
import { el, escapeHtml, fmt } from './dom';

/** Aggiorna l'HTML solo se è cambiato (evita di ricalcolare l'impaginazione per nulla). */
function setHtml(e: HTMLElement, html: string) {
  // Si confronta con l'ultimo testo impostato (l'innerHTML del browser è normalizzato e differirebbe)
  if (e.dataset.html !== html) {
    e.innerHTML = html;
    e.dataset.html = html;
  }
}

export interface HudCallbacks {
  onTool(defId: string | null): void;
  onDeselect(): void;
  onSpeed(speed: number): void;
  onSave(): void;
  onExit(): void;
  /** Accende o spegne la musica; restituisce il nuovo stato. */
  onMusic?(): boolean;
  musicOn?: boolean;
  /** Passa al livello di qualità grafica successivo e ne restituisce il nome. */
  onQuality(): string;
  qualityLabel: string;
  /** Centra la telecamera su un punto della mappa. */
  focus?(x: number, z: number): void;
  /** Seleziona reparti sulla mappa. */
  selectCompanies?(ids: string[]): void;
  /** Spedizioni contro l'altro giocatore (solo nelle partite multigiocatore). */
  war?: () => null | { opponent: string; launch(f: Force, stance: Stance): string | null };
  /** null se il multiplayer non è disponibile (ospite o Supabase non configurato). */
  realm: null | {
    join(name: string): Promise<void>;
    leave(): Promise<void>;
    chat(text: string): Promise<void>;
    caravan(toId: string, res: ResourceId, amount: number): Promise<void>;
  };
}

type Tab = 'castle' | 'army' | 'market' | 'realm' | 'diplomacy';
const SPEEDS = [0, 1, 2, 4, 8];

export class Hud {
  private top: HTMLElement;
  private dateEl: HTMLElement;
  private eraEl: HTMLElement;
  private raidEl: HTMLElement;
  private saveEl: HTMLElement;
  private speedBtns: HTMLButtonElement[] = [];
  private resEls = new Map<ResourceId, HTMLElement>();
  /** Riquadro con entrate e uscite della risorsa sotto il mouse. */
  private resTip = el('div', { class: 'res-tip panel hidden' });
  private resHover: ResourceId | null = null;
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
  private compPanel: HTMLElement = el('div', { class: 'companies-panel panel hidden' });
  private compIds: string[] = [];
  private compKey = '';
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
    const musicBtn = el('button', { text: cb.musicOn === false ? '🔇' : '🎵', title: 'Musica (clic per accendere o spegnere)' });
    musicBtn.onclick = () => {
      if (cb.onMusic) musicBtn.textContent = cb.onMusic() ? '🎵' : '🔇';
    };
    const exitBtn = el('button', { text: '⎋', title: 'Torna al menu' });
    exitBtn.onclick = () => cb.onExit();
    const resBar = el('div', { class: 'resources' });
    for (const id of RESOURCE_IDS) {
      const v = el('span', { class: 'v' });
      const item = el('span', { class: 'res' }, RESOURCES[id].icon, v);
      item.onmouseenter = () => {
        this.resHover = id;
        this.refreshResTip(item);
      };
      item.onmouseleave = () => {
        this.resHover = null;
        this.resTip.classList.add('hidden');
      };
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
        musicBtn,
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
    const tabNames: Record<Tab, string> = { castle: '🏰 Castello', army: '⚔️ Esercito', market: '⚖️ Mercato', diplomacy: '🤝 Diplomazia', realm: '👥 Regno' };
    for (const t of Object.keys(tabNames) as Tab[]) {
      if (t === 'diplomacy' && !game.lords().length) continue;
      if (t === 'realm' && game.lords().length) continue;
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

    root.append(this.resTip);
    root.append(this.top, build, this.panel, this.selPanel, this.compPanel, this.logEl, this.toastEl, this.hintEl);
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
      const thumb = el('span', { class: 'thumb', 'data-id': def.id }, el('span', { class: 'emoji', text: def.icon }));
      const url = this.thumbs.get(def.id);
      if (url) thumb.append(el('img', { src: url, alt: '' }));
      const btn = el(
        'button',
        { class: 'build-item', title: def.description },
        thumb,
        el(
          'span',
          { class: 'text' },
          el('span', { class: 'name', text: def.name }),
          el('span', { class: 'cost', text: formatCost(def.cost) }),
          el('span', { class: 'meta', text: this.metaFor(def.id) }),
        ),
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
      const levelLocked = !!def.minLevel && this.game.castleLevel() < def.minLevel;
      const locked = !isAvailable(def, year) || levelLocked;
      btn.classList.toggle('locked', locked);
      btn.classList.toggle('poor', !locked && !canAfford(this.game.state.resources, def.cost));
      btn.classList.toggle('active', this.activeTool === id);
      btn.classList.toggle('done', !!def.unique && this.game.count(id) > 0);
      const meta = btn.querySelector('.meta')!;
      const text = !isAvailable(def, year) ? `🔒 Dal ${def.minYear}` : levelLocked ? `🔒 Castello livello ${def.minLevel}` : this.metaFor(id);
      if (meta.textContent !== text) meta.textContent = text;
    }
  }

  private thumbs = new Map<string, string>();

  /** Miniatura 3D pronta: la mostra accanto all'edificio nel menu. */
  setThumbnail(id: string, url: string) {
    this.thumbs.set(id, url);
    for (const t of this.buildList.querySelectorAll<HTMLElement>(`.thumb[data-id="${id}"]`)) {
      if (!t.querySelector('img')) t.append(el('img', { src: url, alt: '' }));
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

  // ───────────── Reparti selezionati ─────────────

  setCompanySelection(ids: string[]) {
    this.compIds = ids;
    this.compKey = '';
    this.refreshCompanies();
  }

  private refreshCompanies() {
    const g = this.game;
    const comps = (g.state.companies ?? []).filter((c) => this.compIds.includes(c.id));
    this.compPanel.classList.toggle('hidden', !comps.length);
    if (!comps.length) return;
    const key = JSON.stringify(comps.map((c) => [c.id, c.troops, c.order, c.engaged, c.cargo, c.formation, c.behavior]));
    if (key === this.compKey) return;
    this.compKey = key;
    const t = { infantry: 0, archers: 0, cavalry: 0, rams: 0, trebuchets: 0 };
    let cargo = 0;
    for (const c of comps) {
      for (const k of Object.keys(t) as Array<keyof typeof t>) t[k] += c.troops[k];
      cargo += Object.values(c.cargo ?? {}).reduce((a, b) => a + (b ?? 0), 0);
    }
    const ids = comps.map((c) => c.id);
    const btn = (label: string, fn: () => void, title = '') => {
      const b = el('button', { text: label, title });
      b.onclick = fn;
      return b;
    };
    const buttons = [
      btn('🏰 Rientra', () => g.orderHome(ids), 'Torna al castello: le truppe e il bottino rientrano'),
      btn('✋ Fermati', () => g.orderStop(ids)),
    ];
    if (comps.length === 1) buttons.push(btn('✂️ Dividi', () => {
      const n = g.splitCompany(ids[0]);
      if (n) this.cb.selectCompanies?.([ids[0], n.id]);
    }));
    const enemyKeep = g.others.find((b) => getBuilding(b.defId).fort === 'keep');
    if (enemyKeep) {
      buttons.push(
        btn('⚔️ Attacca il castello', () => {
          const r = g.orderAttack(ids, enemyKeep.x + 1, enemyKeep.z + 1);
          if (!r.ok) this.toast(r.reason ?? '', 'bad');
        }, 'Marcia verso il mastio nemico e assalta le mura'),
      );
    }
    buttons.push(btn('✕', () => this.cb.selectCompanies?.([])));
    const curF = comps[0].formation ?? 'line';
    const sameF = comps.every((c) => (c.formation ?? 'line') === curF);
    const formRow = el(
      'div',
      { class: 'row formations' },
      ...(Object.keys(FORMATIONS) as Formation[]).map((f) => {
        const d = FORMATIONS[f];
        const b = btn(`${d.icon} ${d.name}`, () => g.setFormation(ids, f), `${d.description} (velocità ×${d.speed}, attacco ×${d.attack}, difesa ×${d.defense})`);
        if (sameF && f === curF) b.classList.add('active');
        return b;
      }),
    );
    const curB = comps[0].behavior ?? 'defensive';
    const sameB = comps.every((c) => (c.behavior ?? 'defensive') === curB);
    const behRow = el(
      'div',
      { class: 'row formations' },
      ...(Object.keys(BEHAVIORS) as Behavior[]).map((k) => {
        const d = BEHAVIORS[k];
        const b = btn(`${d.icon} ${d.name}`, () => g.setBehavior(ids, k), d.description);
        if (sameB && k === curB) b.classList.add('active');
        return b;
      }),
    );
    this.compPanel.replaceChildren(
      el('div', { class: 'row' }, el('strong', { text: comps.length === 1 ? '🚩 Reparto' : `🚩 ${comps.length} reparti` }), el('span', { class: 'spacer' })),
      el('p', {
        class: 'small',
        text: `${t.infantry} 🛡️ fanti · ${t.archers} 🏹 arcieri · ${t.cavalry} 🐎 cavalieri${t.rams ? ` · ${t.rams} 🪵 arieti` : ''}${t.trebuchets ? ` · ${t.trebuchets} 🎯 trabucchi` : ''}${cargo ? ` · 💰 bottino ${Math.round(cargo)}` : ''}`,
      }),
      el('p', { class: 'small muted', text: comps.some((c) => c.engaged) ? 'In battaglia…' : `${FORMATIONS[curF].description}` }),
      el('div', { class: 'small strong', text: 'Formazione (F)' }),
      formRow,
      el('div', { class: 'small strong', text: 'Comportamento' }),
      behRow,
      el('div', { class: 'row' }, ...buttons),
      el('p', {
        class: 'small muted',
        text: 'Tasto destro: muovi · Maiusc+destro: aggiungi tappa · destro su nemico: attacca · Maiusc+trascina: seleziona a riquadro · Ctrl+A: tutti · Ctrl+1…5: gruppo · H: rientra',
      }),
    );
  }

  // ───────────── Pannelli ─────────────

  private setTab(t: Tab) {
    for (const [k, b] of this.tabBtns) b.classList.toggle('active', k === t);
    this.panelBody.replaceChildren();
    if (t === 'castle') this.buildCastleTab();
    else if (t === 'army') this.buildArmyTab();
    else if (t === 'market') this.buildMarketTab();
    else if (t === 'diplomacy') this.buildDiplomacyTab();
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
    // ───── Tasse e contento della popolazione
    const taxBtns = TAX_LEVELS.map((lv, i) => {
      const b = el('button', { text: `${lv.icon} ${lv.name}`, title: `Gettito ×${lv.mul} · contento ${lv.mood >= 0 ? '+' : ''}${lv.mood}` });
      b.onclick = () => this.game.setTaxLevel(i);
      return b;
    });
    const moodBar = el('div', { class: 'hp-bar' });
    const moodText = el('div', { class: 'small' });
    const moodParts = el('p', { class: 'small muted' });
    const tax = el(
      'div',
      { class: 'tax' },
      el('h4', { text: '🪙 Tasse e contento' }),
      el('div', { class: 'row tax-levels' }, ...taxBtns),
      el('div', { class: 'hp' }, moodBar),
      moodText,
      moodParts,
    );
    // ───── Livello del castello
    const levelInfo = el('div');
    const levelBtn = el('button', { class: 'primary' });
    const levelWhy = el('p', { class: 'small muted' });
    const nextStep = () => {
      const g = this.game;
      const lv = g.castleLevel();
      const keep = g.ownKeep();
      if (lv === 2) return { label: `🏰 Trasforma in mastio di pietra (${formatCost(KEEP_EVOLVE.cost)})`, check: g.canEvolveKeep(), run: () => g.evolveKeep() };
      const id = lv === 1 ? 'bailey' : lv === 3 ? 'great_hall' : lv === 4 ? 'palace' : null;
      if (!id || !keep) return null;
      const u = UPGRADE_BY_ID[id];
      return { label: `${u.icon} ${u.name} (${formatCost(u.cost)})`, check: g.canUpgrade(keep, id), run: () => g.upgrade(keep, id) };
    };
    levelBtn.onclick = () => nextStep()?.run();
    const levelBox = el('div', { class: 'castle-level' }, el('h4', { text: '👑 Livello del castello' }), levelInfo, levelBtn, levelWhy);
    this.panelBody.append(levelBox, tax, defense, repairAll, siege, body);
    let lastSiege = -1;
    this.refreshTab = () => {
      const g = this.game;
      const s = g.summary();
      const d = g.defenseBreakdown();
      taxBtns.forEach((b, i) => b.classList.toggle('active', i === g.taxLevel()));
      const lvl = g.castleLevel();
      const L = CASTLE_LEVELS[lvl];
      const stars = '★'.repeat(lvl) + '☆'.repeat(5 - lvl);
      const lvlHtml = `<p><span class="stars">${stars}</span> <strong>${L.icon} ${escapeHtml(L.name)}</strong> (livello ${lvl}/5)</p>
        <p class="small muted">${lvl ? `Vantaggi: +${L.housing} alloggi, +${L.storage} magazzini, tasse +${Math.round(L.tax * 100)}%.` : ''} ${escapeHtml(L.how)}</p>`;
      if (levelInfo.innerHTML !== lvlHtml) levelInfo.innerHTML = lvlHtml;
      const step = nextStep();
      levelBtn.classList.toggle('hidden', !step);
      if (step) {
        levelBtn.textContent = step.label;
        levelBtn.disabled = !step.check.ok;
        levelWhy.textContent = step.check.ok ? '' : step.check.reason ?? '';
      } else levelWhy.textContent = '';
      const h = g.happiness();
      const mood = g.moodTarget();
      moodBar.style.width = `${Math.round(h)}%`;
      moodBar.className = `hp-bar ${h < 30 ? 'ruin' : h < 50 ? 'damaged' : ''}`;
      const trend = mood.total > h + 1 ? '↗' : mood.total < h - 1 ? '↘' : '→';
      const bud = g.budget();
      const money = (n: number) => `${n >= 0 ? '' : '−'}${fmt(Math.abs(n))}`;
      setHtml(
        moodText,
        `Contento <strong>${Math.round(h)}</strong>/100 ${trend} ${Math.round(mood.total)} · produzione ×${g.productivity().toFixed(2)}${h < 30 ? ' · <span class="bad">la gente se ne va!</span>' : ''}${h < 20 ? ' <span class="bad">Rischio di tumulti!</span>' : ''}
        <table class="budget">
          <tr><td>🪙 Tasse (${Math.floor(g.state.population)} abitanti × ${bud.perPerson.toFixed(1)})</td><td>+${fmt(bud.taxes)}/mese</td></tr>
          ${bud.tribute ? `<tr><td>👑 Tributi dei vassalli</td><td>+${fmt(bud.tribute)}/mese</td></tr>` : ''}
          <tr><td>⚔️ Paga dei soldati</td><td>−${fmt(bud.army)}/mese</td></tr>
          ${bud.engines ? `<tr><td>🪵 Macchine d'assedio</td><td>−${fmt(bud.engines)}/mese</td></tr>` : ''}
          <tr class="${bud.net < 0 ? 'bad' : 'good'}"><td><strong>Saldo</strong></td><td><strong>${money(bud.net)}/mese</strong></td></tr>
        </table>
        ${bud.net < 0 ? `<p class="small bad">Le spese superano le entrate: con ${fmt(g.state.resources.coins)} monete resisti circa ${Math.max(0, Math.floor(g.state.resources.coins / -bud.net))} mesi, poi i soldati diserteranno.</p>` : ''}`,
      );
      moodParts.textContent = mood.parts.map(([n, v]) => `${n} ${v >= 0 ? '+' : ''}${v}`).join(' · ');
      const era = eraForYear(s.date.year);
      setHtml(defense, `
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
        ${d.damaged || d.ruined ? `<p class="bad small">Danneggiate: ${d.damaged} · In rovina: ${d.ruined}</p>` : ''}`);
      repairAll.classList.toggle('hidden', !d.damaged && !d.ruined && !g.state.buildings.some((b) => (b.hp ?? 0) < g.maxHp(b)));
      const ls = g.state.lastSiege;
      if (ls && ls.day !== lastSiege) {
        lastSiege = ls.day;
        const title = { repelled: '🛡️ Respinto', held: '🏰 Il mastio ha resistito', sacked: '🔥 Castello espugnato' }[ls.outcome];
        siege.innerHTML = `<h4>Ultimo assedio — ${escapeHtml(ls.attacker)}</h4>
          <p class="${ls.outcome === 'repelled' ? 'good' : 'bad'}">${title} · caduti nemici ${ls.attackerLosses}, nostri ${ls.defenderLosses}${ls.loot ? ` · bottino ${ls.loot} 🪙` : ''}</p>
          <ol class="small siege-log">${ls.log.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ol>`;
      }
      setHtml(body, `
        <h4>${escapeHtml(era.name)}</h4>
        <p class="muted small">${escapeHtml(era.description)}</p>
        <table>
          <tr><td>👪 Abitanti</td><td>${Math.floor(s.population)} / ${s.housing}</td></tr>
          <tr><td>👷 Posti di lavoro</td><td>${s.jobs} (copertura ${Math.round(s.staffing * 100)}%)</td></tr>
          <tr><td>🍞 Cibo al giorno</td><td>${fmt(s.foodPerDay)}</td></tr>
          <tr><td>📦 Magazzini</td><td>${s.storage} per risorsa</td></tr>
        </table>
        <p class="small muted">Il cibo si consuma partendo da quello più deperibile. Una dieta varia fa crescere la popolazione più in fretta.</p>`);
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
    let refreshWar: () => void = () => {};
    this.refreshTab = () => {
      for (const u of units) {
        counts.get(u)!.textContent = String(this.game.state.army[u]);
        const c = this.game.canRecruit(u);
        reasons.get(u)!.textContent = c.ok ? '' : c.reason ?? '';
      }
      const d = Math.ceil(this.game.daysToRaid());
      info.textContent = `Difesa totale: ${fmt(this.game.fortDefense() * 0.8 + this.game.armyPower())}. Gli arcieri rendono di più con le torri. Le spie segnalano movimenti di predoni tra circa ${formatDuration(d)}.`;
      refreshEngines();
      refreshWar();
    };

    // ───── Macchine d'assedio ─────
    const engineBox = el('div');
    rows.after(engineBox);
    engineBox.before(el('h4', { text: '🪵 Macchine d\'assedio' }));
    const engineRows = new Map<EngineType, { count: HTMLElement; btn: HTMLButtonElement; why: HTMLElement }>();
    for (const t of Object.keys(ENGINES) as EngineType[]) {
      const e = ENGINES[t];
      const count = el('strong');
      const why = el('span', { class: 'small muted' });
      const btn = el('button', { text: 'Costruisci' });
      btn.onclick = () => this.game.buildEngine(t);
      engineRows.set(t, { count, btn, why });
      engineBox.append(
        el(
          'div',
          { class: 'unit' },
          el('div', { class: 'row' }, el('span', { text: `${e.icon} ${e.name}` }), el('span', { class: 'spacer' }), count),
          el('div', { class: 'small muted', text: `${e.description} Costo ${formatCost(e.cost)} · dal ${e.minYear}` }),
          el('div', { class: 'row' }, btn, why),
        ),
      );
    }
    const refreshEngines = () => {
      const have = this.game.engines();
      for (const [t, r] of engineRows) {
        const away = this.game.troopsAway()[t];
        r.count.textContent = `${have[t]}${away ? ` (+${away} in campo)` : ''}`;
        const c = this.game.canBuildEngine(t);
        r.btn.disabled = !c.ok;
        r.why.textContent = c.ok ? '' : c.reason ?? '';
      }
    };

    // ───── Reparti: si formano dalla guarnigione e si comandano sulla mappa ─────
    const warBox = el('div', { class: 'war' });
    this.panelBody.append(warBox);
    const war = this.cb.war?.() ?? null;
    const keys = ['infantry', 'archers', 'cavalry', 'rams', 'trebuchets'] as const;
    const inputs = new Map<(typeof keys)[number], HTMLInputElement>();
    const grid = el('div', { class: 'war-grid' });
    for (const k of keys) {
      const label = k in UNITS ? `${UNITS[k as UnitType].icon} ${UNITS[k as UnitType].name}` : `${ENGINES[k as EngineType].icon} ${ENGINES[k as EngineType].name}`;
      const inp = el('input', { type: 'number', min: '0', value: '0', class: 'amount' });
      const max = el('button', { class: 'link small', text: 'tutti' });
      max.onclick = () => {
        inp.value = String(k in UNITS ? this.game.state.army[k as UnitType] : this.game.engines()[k as EngineType]);
        refreshWar();
      };
      inp.oninput = () => refreshWar();
      inputs.set(k, inp);
      grid.append(el('span', { text: label }), inp, max);
    }
    const force = (): Force => {
      const f = { infantry: 0, archers: 0, cavalry: 0, rams: 0, trebuchets: 0 };
      for (const k of keys) f[k] = Math.max(0, Math.floor(Number(inputs.get(k)!.value) || 0));
      return f;
    };
    const estimate = el('p', { class: 'small' });
    const form = el('button', { class: 'primary', text: '🚩 Forma il reparto ed esci dal castello' });
    form.onclick = () => {
      const c = this.game.formCompany(force());
      if (!c) {
        this.toast(this.game.canForm(force()).reason ?? 'Impossibile', 'bad');
        return;
      }
      for (const i of inputs.values()) i.value = '0';
      this.cb.selectCompanies?.([c.id]);
      this.toast('Reparto pronto: tasto destro sulla mappa per muoverlo, su un edificio nemico per attaccare.', 'good');
      refreshWar();
    };
    const intelEl = el('div', { class: 'small intel' });
    const list = el('div', { class: 'company-list' });
    warBox.append(
      el('h4', { text: '🚩 Reparti sul campo' }),
      el('p', {
        class: 'small muted',
        text: 'Forma un reparto con le truppe del castello. Clic su un reparto per selezionarlo (Maiusc+clic per aggiungerne altri), tasto destro per muoverlo o, su un edificio nemico, per attaccare. I reparti vicini al mastio aiutano a difenderlo.',
      }),
      grid,
      estimate,
      form,
      ...(war ? [el('h4', { text: `🔭 Castello di ${war.opponent}` }), intelEl] : []),
      el('h4', { text: 'I tuoi reparti' }),
      list,
    );
    let lastList = '';
    refreshWar = () => {
      const g = this.game;
      const f = force();
      const c = g.canForm(f);
      form.disabled = !c.ok;
      const n = f.infantry + f.archers + f.cavalry;
      estimate.textContent = n ? (c.ok ? `${n} soldati${f.rams + f.trebuchets ? ` e ${f.rams + f.trebuchets} macchine` : ''}` : c.reason ?? '') : 'Scegli le truppe del reparto.';
      if (war) {
        const intel = g.opponentIntel();
        intelEl.innerHTML = intel
          ? `<strong>Rapporto degli esploratori:</strong> cinta ${intel.closed ? '<span class="bad">chiusa</span>' : '<span class="good">aperta</span>'} ·
             ${intel.walls} tratti di mura, ${intel.towers} torri, ${intel.gates} porte, ${intel.moats} fossati, ${intel.upgrades} miglioramenti ·
             difese stimate ${fmt(intel.breakdown.total)}. La guarnigione è sconosciuta.`
          : '<span class="muted">Gli esploratori non hanno ancora notizie del castello nemico.</span>';
      }
      const comps = g.state.companies ?? [];
      const key = JSON.stringify(comps.map((x) => [x.id, x.troops, x.order, !!x.engaged, x.cargo ? 1 : 0]));
      if (key === lastList) return;
      lastList = key;
      const orders = { idle: 'fermo', move: 'in marcia', attack: 'all\'attacco', home: 'rientra' };
      list.replaceChildren(
        ...(comps.length
          ? comps.map((x) => {
              const t = x.troops;
              const b = el('button', { class: 'link', text: 'Seleziona' });
              b.onclick = () => this.cb.selectCompanies?.([x.id]);
              return el(
                'div',
                { class: 'row small' },
                el('span', { text: `🚩 ${t.infantry}🛡️ ${t.archers}🏹 ${t.cavalry}🐎${t.rams ? ` ${t.rams}🪵` : ''}${t.trebuchets ? ` ${t.trebuchets}🎯` : ''} · ${x.engaged ? 'in battaglia' : orders[x.order]}${x.cargo ? ' · 💰' : ''}` }),
                el('span', { class: 'spacer' }),
                b,
              );
            })
          : [el('p', { class: 'small muted', text: 'Nessun reparto fuori dal castello.' })]),
      );
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

  private buildDiplomacyTab() {
    const g = this.game;
    const list = el('div');
    const travel = el('div');
    this.panelBody.append(
      el('p', { class: 'small muted', text: 'Manda un diplomatico ai castelli dei signori vicini: viaggia sulla mappa e porta la tua proposta. Un dono rende tutto più facile.' }),
      list,
      el('h4', { text: '🕊️ Diplomatici in viaggio' }),
      travel,
    );
    const rows = new Map<number, { info: HTMLElement; bar: HTMLElement }>();
    for (const l of g.lords()) {
      const info = el('div');
      const bar = el('div', { class: 'hp-bar' });
      const mission = el('select');
      for (const [id, m] of Object.entries(Game.MISSIONS)) mission.append(el('option', { value: id, text: `${m.icon} ${m.name}` }));
      const coins = el('input', { type: 'number', min: '0', value: '0', class: 'amount', title: 'Dono in monete' });
      const grain = el('input', { type: 'number', min: '0', value: '0', class: 'amount', title: 'Dono in grano' });
      const send = el('button', { class: 'primary', text: '🕊️ Invia diplomatico' });
      const why = el('span', { class: 'small muted' });
      send.onclick = () => {
        const gift = { coins: Math.max(0, Math.floor(Number(coins.value) || 0)), grain: Math.max(0, Math.floor(Number(grain.value) || 0)) };
        const c = g.sendDiplomat(l.id, mission.value as keyof typeof Game.MISSIONS, gift);
        if (!c) this.toast(g.canSendDiplomat(l.id, gift).reason ?? 'Impossibile', 'bad');
        else this.toast(`Il diplomatico parte verso ${l.castle}.`, 'good');
      };
      const show = el('button', { class: 'link', text: '📍 Mostra sulla mappa' });
      show.onclick = () => this.cb.focus?.(...g.lordKeep(l));
      rows.set(l.id, { info, bar });
      list.append(
        el(
          'div',
          { class: 'lord' },
          info,
          el('div', { class: 'hp' }, bar),
          el('div', { class: 'row' }, mission, show),
          el('div', { class: 'row small' }, el('span', { text: 'Dono: 🪙' }), coins, el('span', { text: '🌾' }), grain),
          el('div', { class: 'row' }, send, why),
        ),
      );
    }
    let lastTravel = '';
    this.refreshTab = () => {
      for (const l of g.lords()) {
        const r = rows.get(l.id);
        if (!r) continue;
        const soldiers = Math.round(l.army.infantry + l.army.archers + l.army.cavalry);
        const html = `<div class="row"><span class="swatch" style="background:#${SIDE_COLORS[(l.id + 1) % SIDE_COLORS.length].toString(16).padStart(6, '0')}"></span>
          <strong>${escapeHtml(l.name)}</strong></div>
          <div class="small">${escapeHtml(l.castle)} · ${'★'.repeat(l.level)}${'☆'.repeat(5 - l.level)} · ${PERSONALITIES[l.personality].name}</div>
          <div class="small ${l.status === 'war' ? 'bad' : l.status === 'alliance' || l.status === 'vassal' ? 'good' : ''}">${escapeHtml(g.lordStatusName(l))} · rapporto ${Math.round(l.relation)} · circa ${Math.round(soldiers / 5) * 5} soldati${l.companies.length ? ' · <span class="bad">esercito in marcia</span>' : ''}</div>`;
        if (r.info.innerHTML !== html) r.info.innerHTML = html;
        const v = (l.relation + 100) / 2;
        r.bar.style.width = `${v}%`;
        r.bar.className = `hp-bar ${l.relation < -30 ? 'ruin' : l.relation < 10 ? 'damaged' : ''}`;
      }
      const envoys = (g.state.companies ?? []).filter((c) => c.envoy);
      const t = envoys.length
        ? envoys
            .map((c) => {
              const l = g.lord(c.envoy!.lord);
              return `<p class="small">🕊️ ${c.order === 'home' ? 'Di ritorno da' : 'Verso'} ${escapeHtml(l?.castle ?? '?')} · ${Game.MISSIONS[c.envoy!.mission].name}</p>`;
            })
            .join('')
        : '<p class="small muted">Nessuno.</p>';
      if (t !== lastTravel) {
        lastTravel = t;
        travel.innerHTML = t;
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

  /** Entrate, uscite e movimenti una tantum della risorsa sotto il mouse. */
  private refreshResTip(anchor?: HTMLElement) {
    const id = this.resHover;
    if (!id) return;
    const g = this.game;
    const f = g.resourceFlows(id);
    const v = g.state.resources[id];
    const cap = g.storageCap();
    const num = (n: number, sign = true) => `${sign && n > 0 ? '+' : ''}${n < 0 ? '−' : ''}${fmt(Math.abs(n))}`;
    const rows = (list: Array<{ label: string; perMonth: number }>, cls: string) =>
      list.length
        ? `<table>${list.map((r) => `<tr><td>${escapeHtml(r.label)}</td><td class="${cls}">${num(r.perMonth)}</td></tr>`).join('')}</table>`
        : '<p class="muted small">Nessuna</p>';
    const totIn = f.income.reduce((a, r) => a + r.perMonth, 0);
    const totOut = f.expense.reduce((a, r) => a + r.perMonth, 0);
    const net = f.netPerMonth;
    let forecast = '';
    if (net < -0.05 && v > 0) forecast = `<p class="small bad">⏳ Al ritmo attuale finisce tra ${formatDuration((v / -net) * 30)}</p>`;
    else if (net > 0.05 && id !== 'coins' && v < cap) forecast = `<p class="small muted">Magazzini pieni tra ${formatDuration(((cap - v) / net) * 30)}</p>`;
    else if (id !== 'coins' && v >= cap - 0.5 && net > 0) forecast = '<p class="small bad">Magazzini pieni: la produzione in più va persa</p>';
    const oneOff = f.oneOff.length
      ? `<h4>Ultimi 30 giorni (una tantum)</h4><table>${f.oneOff
          .map((r) => `<tr><td>${escapeHtml(r.label)}</td><td class="${r.amount >= 0 ? 'good' : 'bad'}">${num(r.amount)}</td></tr>`)
          .join('')}</table>`
      : '';
    setHtml(
      this.resTip,
      `<h3>${RESOURCES[id].icon} ${RESOURCES[id].name}</h3>
      <p>In magazzino: <b>${fmt(v)}</b>${id !== 'coins' ? ` <span class="muted">/ ${fmt(cap)}</span>` : ''}</p>
      <h4>Entrate al mese <span class="good">${num(totIn)}</span></h4>${rows(f.income, 'good')}
      <h4>Uscite al mese <span class="bad">${num(totOut)}</span></h4>${rows(f.expense, 'bad')}
      <p class="net">Saldo mensile: <b class="${net >= 0 ? 'good' : 'bad'}">${num(net)}</b></p>
      ${forecast}${oneOff}`,
    );
    this.resTip.classList.remove('hidden');
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      const w = 290;
      this.resTip.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left - 10))}px`;
      this.resTip.style.top = `${r.bottom + 6}px`;
    }
  }

  refresh(speed: number) {
    const g = this.game;
    const d = g.date;
    this.dateEl.textContent = formatDate(d);
    this.eraEl.textContent = eraForYear(d.year).name;
    const days = g.daysToRaid();
    // Avviso: eserciti di altri giocatori in marcia (prima di tutto) o predoni vicini
    const incoming = (g.state.incoming ?? []).filter((a) => !a.resolved).sort((a, b) => a.arriveDay - b.arriveDay)[0];
    const invaders = g.enemiesInTerritory();
    this.raidEl.textContent = invaders
      ? `⚔️ ${invaders} soldati nemici nel tuo territorio!`
      : incoming
      ? `⚔️ ${incoming.from} in arrivo (${formatDuration(incoming.arriveDay - g.state.day)})`
      : days < 60
        ? `⚠️ Predoni in avvicinamento (${formatDuration(days)})`
        : '';
    this.speedBtns.forEach((b, i) => b.classList.toggle('active', SPEEDS[i] === speed));
    const cap = g.storageCap();
    for (const [id, e] of this.resEls) {
      const v = g.state.resources[id];
      e.textContent = fmt(v);
      e.parentElement!.classList.toggle('empty', v < 1);
      e.parentElement!.classList.toggle('full', id !== 'coins' && v >= cap - 0.5);
    }
    if (this.resHover) this.refreshResTip();
    this.refreshBuildList();
    this.refreshTab();
    this.refreshSelection();
    this.refreshCompanies();
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
