import {
  BUILDINGS,
  CATEGORY_NAMES,
  getBuilding,
  isAvailable,
  SPECIES_NAMES,
  type BuildingCategory,
  type UnitType,
} from '../game/data/buildings';
import { formatDate, formatDuration, WEATHER, weatherOf } from '../game/data/calendar';
import { eraForYear } from '../game/data/eras';
import { canAfford, CHAIN_IDS, formatCost, RESOURCE_IDS, RESOURCES, TAX_LEVELS, type ResourceId } from '../game/data/resources';
import { BEHAVIORS, ENGINES, FORMATIONS, SOLDIER_FOOD, UNITS, WAGON, type Behavior, type EngineType, type Formation, type Stance } from '../game/data/units';
import type { Force } from '../game/sim/state';
import { CASTLE_LEVELS, UPGRADE_BY_ID } from '../game/data/upgrades';
import { BUILDER_FOOD, BUILDER_WAGE, Game } from '../game/sim/game';
import { PERSONALITIES } from '../game/sim/lords';
import { SIDE_COLORS } from '../render/armies';
import type { PlacedBuilding } from '../game/sim/state';
import type { ChatMessage, RealmPlayer } from '../net/realm';
import { el, escapeHtml, fmt } from './dom';
import { emblemHtml, factionTraitsHtml } from './emblem';
import { isLevelable, levelEffects, levelName } from '../game/data/levels';
import { FACTIONS } from '../game/data/factions';

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

type Tab = 'build' | 'castle' | 'works' | 'army' | 'market' | 'realm' | 'diplomacy';
const SPEEDS = [0, 1, 3, 8];
const SPEED_ICONS: Record<number, string> = { 0: '⏸', 1: '▶', 3: '⏩', 8: '⏭' };

export class Hud {
  private top: HTMLElement;
  private dateEl: HTMLElement;
  private eraEl: HTMLElement;
  private raidEl: HTMLElement;
  private saveEl: HTMLElement;
  private speedBtns: HTMLButtonElement[] = [];
  private resEls = new Map<ResourceId, HTMLElement>();
  private chainSeen = new Set<ResourceId>();
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
  private siegePanel: HTMLElement = el('div', { class: 'siege-panel panel hidden' });
  private siegeStart = -1;
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
      const b = el('button', { text: SPEED_ICONS[s], title: s === 0 ? 'Pausa (spazio)' : `Velocità ${s}× (rallenta da sola se c'è un pericolo)` });
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
        el('span', { class: 'castle-emblem', html: emblemHtml(game.state.faction, 18) }),
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
    this.buildCats = cats;

    // ───── Un solo pannello a sinistra: schede, selezione (quando c'è) e contenuto ─────
    const tabs = el('div', { class: 'tabs' });
    const tabNames: Record<Tab, string> = { build: '🔨 Costruisci', castle: '🏰 Castello', works: '🏗️ Cantieri', army: '⚔️ Esercito', market: '⚖️ Mercato', diplomacy: '🤝 Diplomazia', realm: '👥 Regno' };
    for (const t of Object.keys(tabNames) as Tab[]) {
      if (t === 'diplomacy' && !game.lords().length) continue;
      if (t === 'realm' && game.lords().length) continue;
      const [icon, ...rest] = tabNames[t].split(' ');
      const b = el('button', { title: rest.join(' ') }, el('span', { class: 'ti', text: icon }), el('span', { class: 'tl', text: rest.join(' ') }));
      b.onclick = () => {
        this.setCollapsed(false);
        this.setTab(t);
      };
      this.tabBtns.set(t, b);
      tabs.append(b);
    }
    const fold = el('button', { class: 'fold', title: 'Riduci o allarga il pannello' , text: '«' });
    fold.onclick = () => this.setCollapsed(!this.sidebar.classList.contains('collapsed'));
    this.foldBtn = fold;
    tabs.prepend(fold);
    this.panelBody = el('div', { class: 'panel-body' });
    this.selPanel = el('div', { class: 'selection hidden' });
    this.compPanel.className = 'companies-panel hidden';
    this.panel = el('div', { class: 'side-content' }, this.selPanel, this.compPanel, this.panelBody);
    this.sidebar = el('aside', { class: 'sidebar panel' }, tabs, this.panel);

    this.logEl = el('div', { class: 'log', title: 'Clic: mostra più messaggi' });
    this.logEl.onclick = () => {
      this.logEl.classList.toggle('open');
      this.logKey = '';
    };
    this.toastEl = el('div', { class: 'toasts' });
    this.hintEl = el('div', {
      class: 'hint',
      text: 'W/S avanti e indietro · A/D sinistra e destra · Z/C gira · Q/E inclina · Rotella: zoom · Trascina: sposta · Spazio: pausa',
    });

    root.append(this.resTip, this.siegePanel);
    this.siegePanel.onpointerdown = (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!t) return;
      const g = this.game;
      if (t.dataset.act === 'sortie') {
        const r = g.sortie();
        if (!r) this.toast(g.canSortie().reason ?? 'Impossibile', 'bad');
      } else if (t.dataset.act === 'ransom') {
        if (!g.payRansom()) this.toast('Non hai abbastanza monete per il riscatto.', 'bad');
      } else if (t.dataset.act === 'focus' && g.state.siege) this.cb.focus?.(...g.state.siege.camp);
      else if (t.dataset.act === 'focus-off' && g.state.offense) this.cb.focus?.(...g.state.offense.camp);
      else if (t.dataset.act === 'toggle') {
        this.siegeOpen = !this.siegeOpen;
        this.refreshSiege();
      } else if (t.dataset.act === 'assault') g.offenseAssault();
      else if (t.dataset.act === 'lift') g.liftOffense();
      else if (t.dataset.act?.startsWith('aim-')) g.setOffenseAim(t.dataset.act.slice(4) as 'weakest' | 'gate' | 'tower');
    };
    root.append(this.top, this.sidebar, this.logEl, this.toastEl, this.hintEl);
    // Il pannello parte sotto la barra in alto, qualunque sia la sua altezza
    const place = () => {
      this.sidebar.style.top = `${this.top.offsetHeight}px`;
      this.siegePanel.style.top = `${this.top.offsetHeight + 4}px`;
    };
    requestAnimationFrame(place);
    window.addEventListener('resize', place);
    this.renderBuildList();
    this.setTab('build');
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
          el('span', { class: 'cost', text: formatCost(this.game.costOf(def)) }),
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
    parts.push(`⏱ ${formatDuration(this.game.estimateDays(id))}`);
    return parts.join(' · ');
  }

  private refreshBuildList() {
    const year = this.game.date.year;
    for (const [id, btn] of this.buildBtns) {
      const def = getBuilding(id);
      const levelLocked = !!def.minLevel && this.game.castleLevel() < def.minLevel;
      const locked = !isAvailable(def, year) || levelLocked;
      btn.classList.toggle('locked', locked);
      btn.classList.toggle('poor', !locked && !canAfford(this.game.state.resources, this.game.costOf(def)));
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
      : 'W/S avanti e indietro · A/D sinistra e destra · Z/C gira · Q/E inclina · Rotella: zoom · Trascina: sposta · Spazio: pausa';
  }

  // ───────────── Selezione ─────────────

  private selDyn: HTMLElement = el('div');
  private selKey = '';

  private selWasSite = false;

  select(b: PlacedBuilding | null) {
    this.selected = b;
    this.selKey = '';
    this.selPanel.classList.toggle('hidden', !b);
    if (!b) return;
    // Il pannello si apre dove serve: la selezione compare in cima
    this.setCollapsed(false);
    this.panel.scrollTop = 0;
    const def = getBuilding(b.defId);
    const isSite = !!this.game.siteByUid(b.uid);
    this.selWasSite = isSite;
    const demolish = el('button', { class: 'danger', text: isSite ? 'Annulla il cantiere (rimborso)' : 'Demolisci (rimborso 50%)' });
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
    const isSite = !!this.game.siteByUid(b.uid);
    if (!this.game.byUid(b.uid) && !isSite) {
      this.cb.onDeselect();
      return;
    }
    if (isSite !== this.selWasSite) {
      this.select(b);
      return;
    }
    const g = this.game;
    const def = getBuilding(b.defId);
    const job = g.jobFor(b.uid);
    const eta = job ? g.jobEta(job) : null;
    const to = isSite ? undefined : g.evolveTarget(b);
    const evo = to ? g.canEvolve(b) : null;
    const levelable = !isSite && isLevelable(def);
    const lvl = levelable ? g.canLevelUp(b) : null;
    const ups = g.upgradeOptions(b);
    const checks = ups.map((u) => g.canUpgrade(b, u.id));
    const repairCost = g.repairCost(b);
    const key = JSON.stringify([
      Math.round(b.hp ?? 0), b.upgrades, Math.round(b.herd ?? 0), checks.map((c) => c.ok), b.garrison, g.state.army.archers + g.state.army.infantry,
      canAfford(g.state.resources, repairCost), g.structureVersion, b.defId,
      job && [Math.round((job.done / job.work) * 100), g.lastCrew.get(job.id) ?? 0, eta === null ? -1 : Math.round(eta)],
      evo?.ok, evo?.reason, g.desiredBuilders(), b.level, lvl?.ok, lvl?.reason,
    ]);
    if (key === this.selKey) return;
    this.selKey = key;
    const parts: Node[] = [];
    if (job) {
      const pct = Math.round((job.done / job.work) * 100);
      const crew = g.lastCrew.get(job.id) ?? 0;
      parts.push(
        el('h4', { text: job.kind === 'build' ? '🏗️ In costruzione' : `🏗️ Lavori: ${g.jobName(job)}` }),
        el('div', { class: 'hp' }, el('div', { class: 'hp-bar build', style: `width:${pct}%` })),
        el('p', {
          class: 'small',
          text: `${pct}% · ${crew ? `👷 ${crew} costruttori al lavoro` : '⏳ in coda: nessun costruttore libero'}${eta !== null ? ` · fine tra circa ${formatDuration(eta)}` : ' · lavori fermi'}`,
        }),
      );
      const row = el('div', { class: 'row' });
      const prio = el('button', { text: '⏫ Priorità', title: 'Porta questo lavoro in cima alla coda dei costruttori' });
      prio.onclick = () => g.prioritizeJob(job.id);
      row.append(prio);
      if (def.draggable) {
        const all = el('button', { text: '⏫ Tutto il tratto', title: 'Porta in cima tutti i lavori uguali (es. tutto il tratto di mura)' });
        all.onclick = () => g.prioritizeSimilar(job.id);
        row.append(all);
      }
      if (job.kind !== 'build') {
        const stop = el('button', { text: '✕ Annulla', title: 'Interrompe i lavori: rimborso pieno se non sono iniziati, metà se sono a metà' });
        stop.onclick = () => g.cancelJob(job.id);
        row.append(stop);
      }
      parts.push(row);
      if (isSite) {
        parts.push(el('p', { class: 'small muted', text: `Materiali già pagati: ${formatCost(job.cost)}. L'edificio funzionerà solo a lavori finiti.` }));
        this.selDyn.replaceChildren(...parts);
        return;
      }
    }
    if (def.herd) parts.push(el('p', { text: `${SPECIES_NAMES[def.herd.species]}: ${Math.round(b.herd ?? 0)} / ${g.herdCapacity(b)} capi` }));
    if (!isSite && !def.fort && !def.road && !this.game.isForeign(b)) {
      const depth = g.depthOf(b);
      const cut = g.isCutOff(b);
      const text = cut
        ? '🔒 Tagliato fuori dall\'assedio: non produce e le sue scorte sono isolate.'
        : depth > 0
          ? `🏰 Dentro le mura (${depth === 1 ? 'primo giro' : `${depth}° giro`})${def.storage ? ': le sue scorte servono a resistere agli assedi.' : '.'}`
          : def.storage
            ? '⚠️ Fuori dalle mura: durante un assedio le scorte di questo granaio restano isolate.'
            : 'Fuori dalle mura: durante un assedio si ferma.';
      parts.push(el('p', { class: `small ${cut || (!depth && def.storage) ? 'bad' : depth ? 'good' : 'muted'}`, text }));
    }
    if (levelable && lvl) {
      const level = g.levelOf(b);
      const max = g.maxLevel();
      const eff = levelEffects(level);
      const nextEff = levelEffects(level + 1);
      const what = def.housing ? `alloggi ×${eff.housing.toFixed(2)} → ×${nextEff.housing.toFixed(2)}` : def.storage ? `magazzini ×${eff.storage.toFixed(2)} → ×${nextEff.storage.toFixed(2)}` : def.herd ? `capi ×${eff.herd.toFixed(2)} → ×${nextEff.herd.toFixed(2)}` : `resa ×${eff.production.toFixed(2)} → ×${nextEff.production.toFixed(2)}`;
      const cost = g.levelCost(b);
      const days = g.daysFor(Game.workFor(cost), b.defId, (cost.stone ?? 0) + (cost.lime ?? 0) > 0);
      const row = el('div', { class: 'upgrade evolve' });
      row.append(
        el('div', { class: 'row' }, el('strong', { text: `⭐ ${levelName(level)}` }), el('span', { class: 'spacer' }), el('span', { class: 'small muted', text: `max ${max} in quest'epoca` })),
        el('div', { class: 'hp' }, el('div', { class: 'hp-bar build', style: `width:${Math.round((level / 20) * 100)}%` })),
        el('div', { class: 'small', text: `Prossimo livello: ${what} · ${formatCost(cost)} · ⏱ ${formatDuration(days)}` }),
      );
      const btns = el('div', { class: 'row' });
      const one = el('button', { text: `⬆️ Migliora al livello ${level + 1}` });
      one.disabled = !lvl.ok;
      one.onclick = () => g.levelUp(b);
      btns.append(one);
      const same = g.state.buildings.filter((x) => x.defId === b.defId && g.levelOf(x) === level && !g.jobFor(x.uid)).length;
      if (same > 1) {
        const all = el('button', { text: `Tutti (${same})`, title: 'Migliora tutti gli edifici uguali allo stesso livello, finché bastano le risorse' });
        all.disabled = !lvl.ok;
        all.onclick = () => {
          const n = g.levelUpAll(b.defId, level);
          this.toast(`${n} ${def.name.toLowerCase()} in miglioramento.`, 'good');
        };
        btns.append(all);
      }
      if (!lvl.ok && lvl.reason) btns.append(el('span', { class: 'small muted', text: lvl.reason }));
      row.append(btns);
      parts.push(row);
    }
    if (!def.fort && !def.road && (def.produces || def.herd)) {
      const bonus = g.roadBonus(b);
      parts.push(
        el('p', {
          class: bonus > 1 ? 'good small' : 'bad small',
          text: bonus > 1 ? `🛣️ Collegato alla rete stradale: produzione +${Math.round((bonus - 1) * 100)}%` : '🛣️ Non collegato: costruisci una strada fino al castello o al mercato (+15%)',
        }),
      );
    }
    if (def.vision && !isSite) {
      const gar = b.garrison ? b.garrison.infantry + b.garrison.archers : 0;
      const minus = el('button', { text: '−' });
      const plus = el('button', { text: '+' });
      minus.onclick = () => g.setGarrison(b, gar - 1);
      plus.onclick = () => g.setGarrison(b, gar + 1);
      minus.disabled = gar <= 0;
      plus.disabled = gar >= (def.garrison ?? 0) || g.state.army.archers + g.state.army.infantry < 1;
      parts.push(
        el('h4', { text: '🔭 Vedetta' }),
        el('p', { class: 'small', text: `Vede fino a ${g.visionOf(b)} caselle e dà l'allarme quando si avvicinano truppe nemiche.` }),
        el('div', { class: 'row' }, el('span', { text: `🛡️ Guardie: ${gar} / ${def.garrison}` }), el('span', { class: 'spacer' }), minus, plus),
        el('p', { class: 'small muted', text: 'Ogni guardia allunga la vista di una casella e difende la torre dalle incursioni (meglio con recinto e muretto). Le guardie si prendono dalla guarnigione, prima gli arcieri.' }),
      );
    }
    if (def.fort || def.vision) {
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
      if (def.fort) parts.push(el('p', { class: 'small', text: `🛡️ Difesa: ${fmt(g.defenseOf(b))}${!g.analysis().closed && def.fort !== 'keep' && def.fort !== 'moat' ? ' (dimezzata: cinta aperta)' : ''}` }));
    }
    if (to && evo) {
      const cost = g.evolveCost(b);
      const stone = (cost.stone ?? 0) + (cost.lime ?? 0) > 0;
      const days = g.daysFor(g.evolveWork(b), b.defId, stone);
      const row = el('div', { class: 'upgrade evolve' });
      row.append(
        el('div', { class: 'row' }, el('strong', { text: `⬆️ Trasforma in ${to.icon} ${to.name}` })),
        el('div', { class: 'small muted', text: to.description }),
        el('div', {
          class: 'small',
          text: `${formatCost(cost)} · ⏱ ${formatDuration(days)}${to.hp && def.hp ? ` · ❤️ ${def.hp} → ${to.hp}` : ''}${to.defense !== undefined ? ` · 🛡️ ${def.defense ?? 0} → ${to.defense}` : ''}`,
        }),
      );
      const btns = el('div', { class: 'row' });
      const one = el('button', { text: 'Trasforma' });
      one.disabled = !evo.ok;
      one.onclick = () => g.evolve(b);
      btns.append(one);
      const same = g.state.buildings.filter((x) => x.defId === b.defId && !g.jobFor(x.uid)).length;
      if (same > 1) {
        const all = el('button', { text: `Tutti (${same})`, title: 'Trasforma tutti gli edifici di questo tipo, finché bastano le risorse' });
        all.disabled = !evo.ok;
        all.onclick = () => {
          const n = g.evolveAll(b.defId);
          this.toast(`${n} ${def.name.toLowerCase()} in trasformazione: ${to.name.toLowerCase()}.`, 'good');
        };
        btns.append(all);
      }
      if (!evo.ok && evo.reason) btns.append(el('span', { class: 'small muted', text: evo.reason }));
      row.append(btns);
      parts.push(el('h4', { text: 'Evoluzione' }), row);
    }
    if (ups.length) {
      parts.push(el('h4', { text: 'Miglioramenti' }));
      ups.forEach((u, i) => {
        const done = b.upgrades?.includes(u.id);
        const c = checks[i];
        const row = el('div', { class: `upgrade ${done ? 'done' : ''}` });
        row.append(
          el('div', { class: 'row' }, el('strong', { text: `${u.icon} ${u.name}` }), el('span', { class: 'spacer' }), el('span', { class: 'small', text: done ? '✓' : `${formatCost(g.upgradeCostOf(u))} · ⏱ ${formatDuration(g.daysFor(Game.workFor(u.cost), b.defId, (u.cost.stone ?? 0) + (u.cost.lime ?? 0) > 0))}` })),
          el('div', { class: 'small muted', text: u.description }),
        );
        if (!done) {
          const btns = el('div', { class: 'row' });
          const one = el('button', { text: 'Costruisci' });
          one.disabled = !c.ok;
          one.onclick = () => g.upgrade(b, u.id);
          btns.append(one);
          const same = g.state.buildings.filter((x) => x.defId === b.defId && !x.upgrades?.includes(u.id) && !g.jobFor(x.uid)).length;
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
    if (ids.length) {
      this.setCollapsed(false);
      this.panel.scrollTop = 0;
    }
    this.compKey = '';
    this.refreshCompanies();
  }

  private refreshCompanies() {
    const g = this.game;
    const comps = (g.state.companies ?? []).filter((c) => this.compIds.includes(c.id));
    this.compPanel.classList.toggle('hidden', !comps.length);
    if (!comps.length) return;
    const eta = Math.max(...comps.map((c) => g.etaDays(c) ?? 0));
    const supply = Math.min(...comps.map((c) => g.supplyDays(c)));
    const key = JSON.stringify([comps.map((c) => [c.id, c.troops, c.order, c.engaged, c.cargo, c.formation, c.behavior]), Math.round(eta), Math.round(supply)]);
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
      ...comps.filter((c) => c.cmd).map((c) => el('p', { class: 'small', text: `🎖️ ${c.cmd!.name} · +${Math.round(c.cmd!.skill * 100)}% · ${c.cmd!.wins} vittorie` })),
      el('p', {
        class: 'small',
        text: `${t.infantry} 🛡️ fanti · ${t.archers} 🏹 arcieri · ${t.cavalry} 🐎 cavalieri${t.rams ? ` · ${t.rams} 🪵 arieti` : ''}${t.trebuchets ? ` · ${t.trebuchets} 🎯 trabucchi` : ''}${comps.reduce((a, c) => a + (c.wagons ?? 0), 0) ? ` · ${comps.reduce((a, c) => a + (c.wagons ?? 0), 0)} 🛒 carri` : ''}${cargo ? ` · 💰 bottino ${Math.round(cargo)}` : ''}`,
      }),
      el('p', { class: 'small muted', text: comps.some((c) => c.engaged) ? 'In battaglia…' : `${FORMATIONS[curF].description}` }),
      el('p', {
        class: `small ${supply < 8 ? 'bad' : ''}`,
        text: `${eta > 0 ? `⏱ Arrivo tra circa ${formatDuration(eta)} · ` : ''}${isFinite(supply) ? `🍞 Viveri per ${formatDuration(supply)}${supply < 1 ? ' — finiti: i soldati disertano!' : ''}` : ''}`,
      }),
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

  private sidebar!: HTMLElement;
  private foldBtn!: HTMLElement;
  private buildCats!: HTMLElement;

  /** Riduce il pannello alla sola colonna delle icone (o lo riapre). */
  private setCollapsed(on: boolean) {
    this.sidebar.classList.toggle('collapsed', on);
    this.foldBtn.textContent = on ? '»' : '«';
  }

  private setTab(t: Tab) {
    for (const [k, b] of this.tabBtns) b.classList.toggle('active', k === t);
    this.panelBody.replaceChildren();
    this.refreshTab = () => {};
    if (t === 'build') {
      this.panelBody.append(this.buildCats, this.buildList);
      this.renderBuildList();
    } else if (t === 'castle') this.buildCastleTab();
    else if (t === 'works') this.buildWorksTab();
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
      if (lv === 2 && keep) return { label: `🏰 Trasforma in mastio di pietra (${formatCost(g.evolveCost(keep))})`, check: g.canEvolveKeep(), run: () => g.evolveKeep() };
      const id = lv === 1 ? 'bailey' : lv === 3 ? 'great_hall' : lv === 4 ? 'palace' : null;
      if (!id || !keep) return null;
      const u = UPGRADE_BY_ID[id];
      return { label: `${u.icon} ${u.name} (${formatCost(g.upgradeCostOf(u))})`, check: g.canUpgrade(keep, id), run: () => g.upgrade(keep, id) };
    };
    levelBtn.onclick = () => nextStep()?.run();
    const levelBox = el('div', { class: 'castle-level' }, el('h4', { text: '👑 Livello del castello' }), levelInfo, levelBtn, levelWhy);
    const fac = this.game.faction();
    const factionBox = el('div', { class: 'faction-box' });
    if (fac) {
      factionBox.innerHTML = `<h4>${emblemHtml(fac.id, 20)} Schieramento: ${escapeHtml(fac.name)}</h4>
        <p class="small muted">${escapeHtml(fac.region)}</p>${factionTraitsHtml(fac)}`;
    }
    const goalsBox = el('div', { class: 'goals' });
    this.panelBody.append(levelBox, goalsBox, factionBox, tax, defense, repairAll, siege, body);
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
      const keepJob = g.ownKeep() ? g.jobFor(g.ownKeep()!.uid) : undefined;
      if (keepJob) {
        const eta = g.jobEta(keepJob);
        levelBtn.classList.add('hidden');
        levelWhy.textContent = `🏗️ ${g.jobName(keepJob)}: ${Math.round((keepJob.done / keepJob.work) * 100)}%${eta !== null ? `, fine tra circa ${formatDuration(eta)}` : ''}`;
      } else if (step) {
        levelBtn.textContent = step.label;
        levelBtn.disabled = !step.check.ok;
        levelWhy.textContent = step.check.ok ? '' : step.check.reason ?? '';
      } else levelWhy.textContent = '';
      const gl = g.goals();
      const open = gl.filter((x) => !x.done);
      setHtml(
        goalsBox,
        (g.activeEvents().length ? `<p class="small bad">${g.activeEvents().map((e) => `⚠️ ${escapeHtml(e.text)} (${formatDuration(e.until - g.state.day)})`).join(' · ')}</p>` : '') +
        `<h4>🎯 Obiettivi dell'epoca <span class="muted small">${gl.length - open.length}/${gl.length}</span></h4>` +
          open
            .map(
              ({ goal, have }) =>
                `<div class="goal"><span>${goal.icon} ${escapeHtml(goal.text)}</span><span class="muted small">${fmt(have)}/${fmt(goal.need)} · ${formatCost(goal.reward)}</span><div class="hp"><div class="hp-bar" style="width:${Math.round((have / goal.need) * 100)}%"></div></div></div>`,
            )
            .join('') || '<p class="small good">Tutti gli obiettivi raggiunti: aspetta la prossima epoca.</p>',
      );
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
          ${bud.builders ? `<tr><td>🏗️ Paga dei costruttori</td><td>−${fmt(bud.builders)}/mese</td></tr>` : ''}
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

  private buildWorksTab() {
    const g = this.game;
    const crew = el('div');
    const list = el('div', { class: 'works' });
    const minus = el('button', { text: '−', title: 'Meno costruttori: più braccia nei campi' });
    const plus = el('button', { text: '+', title: 'Più costruttori (servono posti nella loggia dei muratori)' });
    const max = el('button', { text: 'Massimo' });
    const count = el('strong');
    minus.onclick = () => g.setBuilders(Math.max(0, g.desiredBuilders() - 1));
    plus.onclick = () => g.setBuilders(g.desiredBuilders() + 1);
    max.onclick = () => g.setBuilders(undefined);
    list.onpointerdown = (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!t) return;
      const ids = (t.dataset.ids ?? '').split(',').map(Number);
      if (t.dataset.act === 'prio') g.prioritizeSimilar(ids[0]);
      else if (t.dataset.act === 'pause') {
        const on = t.dataset.on === '1';
        for (const id of ids) g.setJobPaused(id, on);
      } else if (t.dataset.act === 'crew') {
        const dlt = Number(t.dataset.d);
        for (const id of ids) {
          const j = g.jobs().find((x) => x.id === id);
          if (!j) continue;
          const cur = j.crew ?? g.crewCap(g.jobDef(j) ?? '');
          g.setJobCrew(id, Math.max(1, cur + dlt));
        }
      } else if (t.dataset.act === 'plan') g.togglePlan(t.dataset.def ?? '');
      else if (t.dataset.act === 'cancel') {
        let n = 0;
        for (const id of ids) if (g.cancelJob(id)) n++;
        this.toast(`${n} lavori annullati: materiali rimborsati.`, 'info');
      }
    };
    this.panelBody.append(
      el('h4', { text: '👷 Costruttori' }),
      el('div', { class: 'row' }, minus, count, plus, max),
      crew,
      list,
    );
    this.refreshTab = () => {
      const cap = g.builderCap();
      const want = g.state.builders;
      count.textContent = `${g.desiredBuilders()} / ${cap}${want === undefined ? ' (massimo)' : ''}`;
      const rate = (stone: boolean) => {
        const r = g.builderRate(stone);
        return `×${r.rate.toFixed(2)}${r.parts.length ? ` <span class="muted">(${r.parts.map(([n, v]) => `${escapeHtml(n)} ×${v.toFixed(2)}`).join(', ')})</span>` : ''}`;
      };
      setHtml(
        crew,
        `<p class="small">Al lavoro: <strong>${g.lastBuilders}</strong> · posti ${cap} (${4} di base + 6 per ogni loggia dei muratori) · al massimo metà degli abitanti.</p>
        <p class="small muted">Ogni costruttore lascia i campi e le botteghe, prende ${fmt(BUILDER_WAGE * 30)} monete e mangia ${fmt(BUILDER_FOOD * 30)} di cibo in più al mese.</p>
        <p class="small">Rendimento lavori in pietra: ${rate(true)}<br>Rendimento lavori in legno: ${rate(false)}</p>`,
      );
      // Lavori raggruppati per tipo (un tratto di mura è un gruppo solo)
      const groups = new Map<string, { name: string; ids: number[]; work: number; done: number; crew: number; eta: number | null; paused: boolean }>();
      for (const j of g.jobs()) {
        const name = g.jobName(j);
        const k = `${j.kind}|${name}`;
        const e = groups.get(k) ?? { name, ids: [], work: 0, done: 0, crew: 0, eta: 0, paused: true };
        e.paused = e.paused && !!j.paused;
        e.ids.push(j.id);
        e.work += j.work;
        e.done += j.done;
        e.crew += g.lastCrew.get(j.id) ?? 0;
        const t = g.jobEta(j);
        e.eta = t === null || e.eta === null ? null : Math.max(e.eta, t);
        groups.set(k, e);
      }
      const rows = [...groups.values()].map((e) => {
        const pct = Math.round((e.done / e.work) * 100);
        return `<div class="work">
          <div class="row"><strong>${escapeHtml(e.name)}${e.ids.length > 1 ? ` ×${e.ids.length}` : ''}</strong><span class="spacer"></span>
            <button data-act="crew" data-d="-1" data-ids="${e.ids.join(',')}" title="Squadra più piccola: i costruttori vanno ad altri lavori">👷−</button>
            <button data-act="crew" data-d="1" data-ids="${e.ids.join(',')}" title="Squadra più grande">👷+</button>
            <button data-act="pause" data-on="${e.paused ? 0 : 1}" data-ids="${e.ids.join(',')}" title="${e.paused ? 'Riprendi' : 'Sospendi: libera i costruttori'}">${e.paused ? '▶' : '⏸'}</button>
            <button data-act="prio" data-ids="${e.ids.join(',')}" title="Porta in cima alla coda">⏫</button>
            <button data-act="cancel" data-ids="${e.ids.join(',')}" title="Annulla (rimborso dei materiali non ancora usati)">✕</button></div>
          <div class="hp"><div class="hp-bar build" style="width:${pct}%"></div></div>
          <p class="small muted">${pct}% · ${e.paused ? '⏸ sospeso' : e.crew ? `👷 ${e.crew}` : '⏳ in coda'}${e.eta !== null ? ` · fine tra circa ${formatDuration(e.eta)}` : ' · fermo'}</p>
        </div>`;
      });
      setHtml(
        list,
        `<h4>🏗️ Lavori in corso (${g.jobs().length})</h4>${rows.length ? rows.join('') : '<p class="small muted">Nessun lavoro. Scegli un edificio dal menu Costruisci, oppure seleziona una fortificazione per trasformarla o migliorarla.</p>'}
        <p class="small muted">I lavori procedono nell'ordine della coda. D'inverno la malta gela: le opere in pietra quasi si fermano. Entro 14 caselle da una loggia dei muratori si lavora il 15% più in fretta. Con 👷 scegli quanti costruttori assegnare a ogni lavoro.</p>
        <h4>📋 Piani di cantiere</h4>
        <p class="small muted">Un piano trasforma da solo le mura appena ci sono epoca, livello e materiali.</p>
        ${['palisade', 'palisade_double', 'wall_rubble', 'wall_stone', 'wall_curtain']
          .map((id) => {
            const on = g.plans().some((p) => p.defId === id);
            const to = getBuilding(getBuilding(id).evolvesTo ?? id).name;
            return `<div class="row"><span>${getBuilding(id).icon} ${escapeHtml(getBuilding(id).name)} → ${escapeHtml(to)}</span><span class="spacer"></span><button data-act="plan" data-def="${id}" class="${on ? 'active' : ''}">${on ? 'Attivo' : 'Attiva'}</button></div>`;
          })
          .join('')}`,
      );
    };
  }

  private buildArmyTab() {
    const rows = el('div');
    const info = el('p', { class: 'small muted' });
    const scoutBtn = el('button', { text: '🐎 Invia un esploratore (15 🪙)', title: 'Un cavaliere che vede lontano: selezionalo e mandalo col tasto destro. Non combatte.' });
    scoutBtn.onclick = () => {
      const c = this.game.sendScout();
      if (!c) this.toast(this.game.canSendScout().reason ?? 'Impossibile', 'bad');
      else this.cb.selectCompanies?.([c.id]);
    };
    this.panelBody.append(
      el('p', { class: 'small muted', text: 'Vedi solo attorno ai tuoi edifici, ai reparti, agli esploratori e alle torri di avvistamento. I castelli dei signori compaiono quando li scopri o se sono tuoi alleati.' }),
      scoutBtn,
      rows,
      info,
    );
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
          el('div', { class: 'small muted', text: `Costo ${formatCost(this.game.unitCost(u))} · Paga ${formatCost(def.upkeep)}/giorno · Att ${def.attack} Dif ${def.defense}` }),
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
    // Carri delle salmerie: si costruiscono qui e si portano dietro al reparto
    const wagonsIn = el('input', { type: 'number', min: '0', value: '0', class: 'amount' });
    const wagonsAll = el('button', { class: 'link small', text: 'tutti' });
    wagonsAll.onclick = () => {
      wagonsIn.value = String(this.game.state.wagons ?? 0);
      refreshWar();
    };
    wagonsIn.oninput = () => refreshWar();
    grid.append(el('span', { text: `${WAGON.icon} Carri salmerie` }), wagonsIn, wagonsAll);
    const wagonInfo = el('span', { class: 'small' });
    const buildWagon = el('button', { text: `🔨 Costruisci un carro (${formatCost(WAGON.cost)})`, title: `Porta ${WAGON.capacity} di cibo dietro all'esercito: senza carri i soldati hanno viveri solo per 40 giorni` });
    buildWagon.onclick = () => {
      if (!this.game.buildWagon()) this.toast(this.game.canBuildWagon().reason ?? 'Impossibile', 'bad');
      refreshWar();
    };
    const estimate = el('p', { class: 'small' });
    const form = el('button', { class: 'primary', text: '🚩 Forma il reparto ed esci dal castello' });
    form.onclick = () => {
      const c = this.game.formCompany(force(), Math.max(0, Math.floor(Number(wagonsIn.value) || 0)));
      wagonsIn.value = '0';
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
      el('div', { class: 'row' }, buildWagon, wagonInfo),
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
      const w = Math.min(g.state.wagons ?? 0, Math.max(0, Math.floor(Number(wagonsIn.value) || 0)));
      wagonInfo.textContent = `Al castello: ${g.state.wagons ?? 0} carri`;
      buildWagon.disabled = !g.canBuildWagon().ok;
      // Viveri: zaini (40 giorni) più i carri, in razioni da marcia
      const ration = n * SOLDIER_FOOD * Game.FIELD_RATION;
      const days = ration > 0 ? (ration * Game.SUPPLY_DAYS + w * WAGON.capacity) / ration : 0;
      estimate.textContent = n
        ? c.ok
          ? `${n} soldati${f.rams + f.trebuchets ? ` e ${f.rams + f.trebuchets} macchine` : ''}${w ? ` e ${w} carri` : ''} · 🍞 viveri per circa ${formatDuration(days)}${w ? ' (i carri rallentano la marcia)' : ''}`
          : c.reason ?? ''
        : 'Scegli le truppe del reparto.';
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
      const orders = { idle: 'fermo', move: 'in marcia', attack: 'all\'attacco', home: 'rientra', siege: 'assedia' };
      list.replaceChildren(
        ...(comps.length
          ? comps.map((x) => {
              const t = x.troops;
              const b = el('button', { class: 'link', text: 'Seleziona' });
              b.onclick = () => this.cb.selectCompanies?.([x.id]);
              return el(
                'div',
                { class: 'row small' },
                el('span', { text: `🚩 ${t.infantry}🛡️ ${t.archers}🏹 ${t.cavalry}🐎${t.rams ? ` ${t.rams}🪵` : ''}${t.trebuchets ? ` ${t.trebuchets}🎯` : ''}${x.wagons ? ` ${x.wagons}🛒` : ''} · ${x.engaged ? 'in battaglia' : orders[x.order]}${x.cargo ? ' · 💰' : ''}` }),
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
    const props = el('div', { class: 'proposals' });
    props.onpointerdown = (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-prop]');
      if (!t) return;
      const msg = g.answerProposal(Number(t.dataset.prop), t.dataset.yes === '1');
      if (msg) this.toast(msg, t.dataset.yes === '1' ? 'good' : 'info');
    };
    this.panelBody.append(
      props,
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
      const scout = el('button', { text: '🐎 Esplora', title: 'Manda un esploratore a cavallo a vedere il suo castello (15 monete)' });
      scout.onclick = () => {
        const [kx, kz] = g.lordKeep(l);
        const [hx, hz] = g.homeSite();
        const d = Math.hypot(kx - hx, kz - hz) || 1;
        // Si ferma a qualche casella dalle mura, dalla nostra parte
        const c = g.sendScout(kx + ((hx - kx) / d) * 9, kz + ((hz - kz) / d) * 9);
        this.toast(c ? `L'esploratore parte verso ${l.castle}.` : g.canSendScout().reason ?? 'Impossibile', c ? 'good' : 'bad');
      };
      rows.set(l.id, { info, bar });
      list.append(
        el(
          'div',
          { class: 'lord' },
          info,
          el('div', { class: 'hp' }, bar),
          el('div', { class: 'row' }, mission, scout, show),
          el('div', { class: 'row small' }, el('span', { text: 'Dono: 🪙' }), coins, el('span', { text: '🌾' }), grain),
          el('div', { class: 'row' }, send, why),
        ),
      );
    }
    let lastTravel = '';
    this.refreshTab = () => {
      // Proposte dei signori in attesa di risposta
      const pend = g.pendingProposals();
      const icons = { help: '⚔️', alliance: '🤝', marriage: '💍', trade: '⚖️', tribute: '💰', spy: '🕵️' };
      const yesNo = { help: ['Entra in guerra', 'Rifiuta'], alliance: ['Accetta', 'Rifiuta'], marriage: ['Accetta le nozze', 'Rifiuta'], trade: ['Accetta', 'Rifiuta'], tribute: ['Paga', 'Rifiuta'], spy: ['Imprigiona', 'Rimandala'] };
      setHtml(
        props,
        pend.length
          ? `<h4>📜 Proposte (${pend.length})</h4>${pend
              .map(
                (p) => `<div class="proposal"><p class="small">${icons[p.kind]} ${escapeHtml(p.text)}</p>
                <div class="row"><button data-prop="${p.id}" data-yes="1" class="primary">${yesNo[p.kind][0]}</button><button data-prop="${p.id}" data-yes="0">${yesNo[p.kind][1]}</button><span class="small muted">scade tra ${formatDuration(p.expires - g.state.day)}</span></div></div>`,
              )
              .join('')}<hr>`
          : '',
      );
      const nameOf = (id: number) => escapeHtml(g.lord(id)?.name ?? '?');
      for (const l of g.lords()) {
        const r = rows.get(l.id);
        if (!r) continue;
        const ties = [
          (l.foes ?? []).length ? `⚔️ in guerra con ${(l.foes ?? []).map(nameOf).join(', ')}` : '',
          (l.friends ?? []).length ? `🤝 alleato di ${(l.friends ?? []).map(nameOf).join(', ')}` : '',
          l.liege !== undefined ? `👑 vassallo di ${nameOf(l.liege)}` : '',
        ].filter(Boolean).join(' · ');
        const soldiers = Math.round(l.army.infantry + l.army.archers + l.army.cavalry);
        const html = `<div class="row"><span class="swatch" style="background:#${SIDE_COLORS[(l.id + 1) % SIDE_COLORS.length].toString(16).padStart(6, '0')}"></span>
          <strong>${escapeHtml(l.name)}</strong></div>
          <div class="small">${l.faction ? `${emblemHtml(l.faction, 14)} ${escapeHtml(FACTIONS[l.faction].name)} · ` : ''}${escapeHtml(l.castle)} · ${l.level ? `${'★'.repeat(l.level)}${'☆'.repeat(5 - l.level)}` : 'accampamento'} · ${PERSONALITIES[l.personality].name}</div>
          <div class="small ${l.status === 'war' ? 'bad' : l.status === 'alliance' || l.status === 'vassal' ? 'good' : ''}">${escapeHtml(g.lordStatusName(l))} · rapporto ${Math.round(l.relation)} · circa ${Math.round(soldiers / 5) * 5} soldati${l.companies.length ? ' · <span class="bad">esercito in marcia</span>' : ''}</div>
          ${ties ? `<div class="small">${ties}</div>` : ''}
          <div class="small muted">👪 ${Math.round(l.pop ?? 0)} abitanti${(() => {
            const act = g.lordActivity(l);
            if (!act.length) return '';
            const uniq = [...new Set(act)];
            return ` · 🏗️ ${escapeHtml(uniq.slice(0, 2).join(', '))}${uniq.length > 2 ? ` e altro (${act.length} lavori)` : ''}`;
          })()}</div>`;
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

  /** Sezione dell'assedio che subiamo. */
  private defenseHtml(): string {
    const g = this.game;
    const sg = g.state.siege;
    if (!sg) return '';
    const ph = g.siegePhase()!;
    const t = sg.troops;
    const size = Math.round(t.infantry + t.archers + t.cavalry);
    const rings = g.rings();
    const food = g.siegeFood();
    const iso = Object.values(sg.isolated).reduce((a, b) => a + (b ?? 0), 0);
    const sortie = g.canSortie();
    const ransom = g.ransomCost();
    const engines = Math.floor(sg.mangonels) + t.trebuchets;
    return (
      `<div class="row"><strong class="bad">⚔️ Assedio — ${escapeHtml(sg.attacker)}</strong><span class="spacer"></span><span class="small muted">giorno ${Math.floor(g.state.day - sg.startDay) + 1}</span></div>
      <p class="small"><strong>${escapeHtml(ph.name)}</strong>${sg.phase !== 'assault' ? ` · assalto tra circa ${formatDuration(ph.days)}` : ''}</p>
      <p class="small">Assedianti: ${size} (🛡️${Math.round(t.infantry)} 🏹${Math.round(t.archers)} 🐎${Math.round(t.cavalry)}) · 🪜 ${Math.floor(sg.ladders)} scale · ${engines ? `🎯 ${engines} macchine` : 'nessuna macchina'}</p>
      <div class="row small"><span>Morale nemico</span><div class="hp grow"><div class="hp-bar ${sg.morale < 0.35 ? 'ruin' : sg.morale < 0.6 ? 'damaged' : ''}" style="width:${Math.round(sg.morale * 100)}%"></div></div></div>
      <p class="small">🏰 Giri di mura in piedi: ${Math.max(0, rings - sg.breached)} su ${rings}${sg.breached ? ' (gli edifici tra le cinte cadute sono perduti)' : ''}</p>
      <p class="small ${food.days < 20 ? 'bad' : ''}">🍞 Cibo dentro le mura: ${fmt(food.food)} (circa ${isFinite(food.days) ? formatDuration(food.days) : '—'})${iso > 1 ? ` · 🔒 isolato fuori: ${fmt(iso)}` : ''}${sg.starving > 0 ? ' · <span class="bad">la gente ha fame!</span>' : ''}</p>
      <div class="row">
        <button data-act="sortie" ${sortie.ok ? '' : 'disabled'} title="Metà della guarnigione e tutta la cavalleria escono e attaccano il campo: bruciano scale e macchine">🔥 Sortita</button>
        <button data-act="ransom" ${g.state.resources.coins >= ransom ? '' : 'disabled'} title="Paghi e se ne vanno">💰 Riscatto (${ransom})</button>
        <button data-act="focus" class="link">📍 Campo nemico</button>
      </div>
      ${sortie.ok ? '' : `<p class="small muted">${escapeHtml(sortie.reason ?? '')}</p>`}
      <ol class="small siege-log">${sg.log.slice(-4).map((l) => `<li>${escapeHtml(l.text)}</li>`).join('')}</ol>`
    );
  }

  /** Sezione del nostro assedio a un signore. */
  private offenseHtml(): string {
    const g = this.game;
    const o = g.state.offense;
    if (!o) return '';
    const l = g.lord(o.lord);
    if (!l) return '';
    const t = g.offenseTroops();
    const size = Math.round(t.infantry + t.archers + t.cavalry);
    const engines = Math.floor(o.mangonels) + t.trebuchets;
    const tb = o.target !== undefined ? l.buildings.find((b) => b.uid === o.target) : undefined;
    const tmax = tb ? g.maxHp(tb) : 0;
    const enemy = Math.round((l.army.infantry + l.army.archers + l.army.cavalry) / 5) * 5;
    const food = l.res?.food ?? 0;
    const foodText = food < 1 ? `<span class="good">finito! (${Math.floor(o.starving)} giorni di fame, si arrendono dopo 25)</span>` : food < 200 ? 'scarseggia' : 'ancora abbondante';
    const supply = Math.min(...g.offenseCompanies().map((c) => g.supplyDays(c)));
    const aim = (id: string, label: string) => `<button data-act="aim-${id}" class="${o.aim === id ? 'active' : ''}">${label}</button>`;
    return `<div class="row"><strong class="good">⛺ Assedio a ${escapeHtml(l.castle)}</strong><span class="spacer"></span><span class="small muted">giorno ${Math.floor(g.state.day - o.startDay) + 1}</span></div>
      <p class="small">Nostri: ${size} (🛡️${t.infantry} 🏹${t.archers} 🐎${t.cavalry}) · 🪜 ${Math.floor(o.ladders)} scale · ${engines ? `🎯 ${engines} macchine` : 'nessuna macchina (mangani dal 1100, o porta i trabucchi)'}</p>
      <div class="row small"><span>Bersaglio:</span>${aim('weakest', 'Più debole')}${aim('gate', 'Porta')}${aim('tower', 'Torre')}</div>
      ${tb ? `<div class="row small"><span>${escapeHtml(getBuilding(tb.defId).name)}</span><div class="hp grow"><div class="hp-bar ${(tb.hp ?? 0) < tmax * 0.5 ? 'damaged' : ''}" style="width:${Math.round(((tb.hp ?? 0) / Math.max(1, tmax)) * 100)}%"></div></div></div>` : ''}
      <p class="small">Difensori: circa ${enemy} soldati · cinta ${g.lordRingClosed(l) ? 'chiusa' : '<span class="good">aperta (breccia)</span>'} · cibo del castello: ${foodText}</p>
      <p class="small ${supply < 8 ? 'bad' : ''}">🍞 Viveri del campo: ${isFinite(supply) ? formatDuration(supply) : '—'}</p>
      <div class="row">
        <button data-act="assault" class="primary" title="Tutti i reparti del campo assaltano: le scale preparate e le brecce aiutano">⚔️ Assalta ora</button>
        <button data-act="lift" title="I reparti tornano al castello">🏳️ Togli l'assedio</button>
        <button data-act="focus-off" class="link">📍 Campo</button>
      </div>
      <ol class="small siege-log">${o.log.slice(-4).map((x) => `<li>${escapeHtml(x.text)}</li>`).join('')}</ol>`;
  }

  /** Riga riassuntiva, sempre visibile, degli assedi in corso. */
  private siegeSummary(): string {
    const g = this.game;
    const parts: string[] = [];
    const sg = g.state.siege;
    const start = sg?.startDay ?? g.state.offense?.startDay ?? -1;
    if (start !== this.siegeStart) {
      // Nuovo assedio: il pannello parte chiuso (il tempo intanto rallenta da solo)
      this.siegeStart = start;
      this.siegeOpen = false;
    }
    if (sg) {
      const ph = g.siegePhase()!;
      const food = g.siegeFood();
      const short = { prepare: 'preparano', bombard: 'bombardano', assault: 'assalto!' }[sg.phase];
      parts.push(
        `<span class="bad">⚔️ Assediati</span> · ${short}${sg.phase !== 'assault' ? ` · assalto ~${formatDuration(ph.days)}` : ''} · 🍞 ${isFinite(food.days) ? formatDuration(food.days) : '—'} · morale ${Math.round(sg.morale * 100)}%
        <button data-act="sortie" ${g.canSortie().ok ? '' : 'disabled'} title="${escapeHtml(g.canSortie().reason ?? 'Sortita: brucia scale e macchine')}">🔥</button><button data-act="ransom" title="Riscatto: ${g.ransomCost()} monete" ${g.state.resources.coins >= g.ransomCost() ? '' : 'disabled'}>💰</button>`,
      );
    }
    const o = g.state.offense;
    if (o) {
      const l = g.lord(o.lord);
      parts.push(
        `<span class="good">⛺ ${escapeHtml(l?.castle ?? '')}</span> · 🪜 ${Math.floor(o.ladders)} · 🎯 ${Math.floor(o.mangonels) + g.offenseTroops().trebuchets}
        <button data-act="assault" title="Assalta ora">⚔️</button><button data-act="lift" title="Togli l'assedio">🏳️</button>`,
      );
    }
    return parts.join('<span class="sep">│</span>');
  }

  private siegeOpen = false;

  /** Pannello degli assedi in corso (subiti e nostri): una barra compatta, i dettagli a richiesta. */
  private refreshSiege() {
    const summary = this.siegeSummary();
    this.siegePanel.classList.toggle('hidden', !summary);
    if (!summary) return;
    const details = this.siegeOpen ? [this.defenseHtml(), this.offenseHtml()].filter(Boolean).join('<hr>') : '';
    this.siegePanel.classList.toggle('open', this.siegeOpen);
    setHtml(
      this.siegePanel,
      `<div class="siege-bar"><span class="slow" title="Durante l'assedio il tempo scorre più lento">⏳</span>${summary}<button data-act="toggle" class="link" title="${this.siegeOpen ? 'Chiudi i dettagli' : 'Dettagli e comandi'}">${this.siegeOpen ? '▴' : '▾'}</button></div>${details ? `<div class="siege-details">${details}</div>` : ''}`,
    );
  }

  refresh(speed: number) {
    const g = this.game;
    const d = g.date;
    const wx = weatherOf(g.state.day);
    this.dateEl.textContent = formatDate(d) + (WEATHER[wx].icon ? ` ${WEATHER[wx].icon}` : '');
    this.dateEl.title = `Tempo: ${WEATHER[wx].name}${wx === 'rain' ? ' (fango: marce più lente, archi e cavalleria penalizzati)' : wx === 'snow' ? ' (marce lente, più viveri consumati fuori casa)' : ''}`;
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
      if (CHAIN_IDS.includes(id)) e.parentElement!.style.display = v >= 1 || this.chainSeen.has(id) ? '' : 'none';
      if (v >= 1) this.chainSeen.add(id);
      e.parentElement!.classList.toggle('full', id !== 'coins' && v >= cap - 0.5);
    }
    if (this.resHover) this.refreshResTip();
    this.refreshSiege();
    // Numero di proposte in attesa sulla scheda Diplomazia
    const dip = this.tabBtns.get('diplomacy');
    if (dip) {
      const n = g.pendingProposals().length;
      if (dip.dataset.badge !== String(n)) {
        dip.dataset.badge = String(n);
        dip.classList.toggle('badge', n > 0);
      }
    }
    this.refreshBuildList();
    this.refreshTab();
    this.refreshSelection();
    this.refreshCompanies();
    const last = g.state.log.at(-1);
    const logKey = `${g.state.log.length}:${last?.day}:${last?.text}`;
    if (logKey !== this.logKey) {
      this.logKey = logKey;
      // Discreto: gli ultimi tre messaggi; con un clic la cronaca più lunga
      const n = this.logEl.classList.contains('open') ? 16 : 3;
      this.logEl.replaceChildren(...g.state.log.slice(-n).map((e) => el('p', { class: e.kind, text: e.text })));
    }
  }

  get isTyping(): boolean {
    const a = document.activeElement;
    return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT');
  }

}
