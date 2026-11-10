import './style.css';
import { supabase } from './config/supabase';
import { getBuilding } from './game/data/buildings';
import { SECONDS_PER_DAY, SIEGE_TIME } from './game/data/calendar';
import { RESOURCES } from './game/data/resources';
import { Game, lineTiles } from './game/sim/game';
import type { GameState } from './game/sim/state';
import { SupabaseRealm, type RealmPlayer } from './net/realm';
import { MatchSession } from './net/matchSession';
import { moodFor, Music } from './audio/music';
import { makeThumbnails } from './render/thumbs';
import { WorldRenderer, type PointerTile, type Quality } from './render/scene';
import { el } from './ui/dom';
import { Hud } from './ui/hud';
import { showStartScreen, type Session, type StartResult } from './ui/start';

const AUTOSAVE_MS = 30_000;
const QUALITY_KEY = 'medieval.quality';
const QUALITY_LABELS: Record<Quality, string> = { high: 'Alta', medium: 'Media', low: 'Bassa' };
const QUALITY_ORDER: Quality[] = ['high', 'medium', 'low'];

function loadQuality(): Quality {
  try {
    const q = localStorage.getItem(QUALITY_KEY) as Quality | null;
    if (q && QUALITY_ORDER.includes(q)) return q;
  } catch {
    /* storage non disponibile */
  }
  // Su telefoni e tablet si parte più leggeri
  return matchMedia('(pointer: coarse)').matches ? 'medium' : 'high';
}
const PRESENCE_MS = 10_000;

async function boot() {
  const app = document.getElementById('app')!;
  const { session, state, match } = await showStartScreen(app);
  await startGame(app, session, state, match);
}

async function startGame(app: HTMLElement, session: Session, state: GameState, match?: StartResult['match']) {
  const canvas = el('canvas', { class: 'world' });
  app.append(canvas);
  const game = new Game(state);
  const view = new WorldRenderer(canvas, game, loadQuality());
  let speed = 1;
  let tool: string | null = null;
  const music = new Music();
  // I browser permettono l'audio solo dopo un gesto dell'utente
  const unlockAudio = () => {
    music.start();
    window.removeEventListener('pointerdown', unlockAudio);
    window.removeEventListener('keydown', unlockAudio);
  };
  window.addEventListener('pointerdown', unlockAudio);
  window.addEventListener('keydown', unlockAudio);
  /** Partita multigiocatore in corso (null in solitario). */
  let ms: MatchSession | null = null;
  const setSpeed = (s: number) => {
    if (ms && !ms.isHost) ms.requestSpeed(s);
    else speed = s;
  };

  // ───── Salvataggi ─────
  let saving = false;
  const save = async (manual = false) => {
    if (saving) return;
    saving = true;
    hud.setSaveStatus('Salvataggio…');
    try {
      if (ms) await ms.save();
      else await session.store.save(game.state);
      hud.setSaveStatus(`Salvato ${new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`);
      if (manual) hud.toast(ms ? 'Partita multigiocatore salvata.' : `Partita salvata (${session.store.label}).`, 'good');
    } catch (e) {
      hud.setSaveStatus('⚠️ Salvataggio fallito');
      hud.toast(`Salvataggio fallito: ${(e as Error).message}`, 'bad');
    } finally {
      saving = false;
    }
  };

  // ───── Multiplayer ─────
  const realm = session.userId && supabase && !match ? new SupabaseRealm(supabase) : null;
  const me = (): RealmPlayer => ({
    id: session.userId!,
    name: session.name,
    castle: game.state.castleName,
    year: game.date.year,
    population: Math.floor(game.state.population),
    power: Math.round(game.armyPower() + game.fortDefense()),
  });

  const hud = new Hud(
    app,
    game,
    {
      onTool: (id) => setTool(id),
      onDeselect: () => select(null),
      selectCompanies: (ids) => selectCompanies(ids),
      focus: (x, z) => view.focus(x, z),
      onSpeed: (s) => setSpeed(s),
      onSave: () => save(true),
      musicOn: music.enabled,
      onMusic: () => {
        music.setEnabled(!music.enabled);
        return music.enabled;
      },
      qualityLabel: QUALITY_LABELS[view.currentQuality],
      onQuality: () => {
        const next = QUALITY_ORDER[(QUALITY_ORDER.indexOf(view.currentQuality) + 1) % QUALITY_ORDER.length];
        view.setQuality(next);
        try {
          localStorage.setItem(QUALITY_KEY, next);
        } catch {
          /* ignora */
        }
        return QUALITY_LABELS[next];
      },
      onExit: async () => {
        await save();
        await ms?.leave();
        await realm?.leave();
        location.reload();
      },
      war: () => (ms ? { opponent: ms.opponent, launch: (f, st) => ms!.launch(f, st) } : null),
      realm: realm && {
        join: (name) => realm.join(name, me()),
        leave: () => realm.leave(),
        chat: (text) => realm.sendChat(text),
        caravan: async (toId, res, amount) => {
          if (!(amount > 0)) return;
          if (game.state.resources[res] < amount) {
            hud.toast(`Non hai abbastanza ${RESOURCES[res].name.toLowerCase()}.`, 'bad');
            return;
          }
          game.state.resources[res] -= amount;
          await realm.sendCaravan(toId, { [res]: amount });
          hud.toast(`Carovana partita: ${RESOURCES[res].icon} ${amount}.`, 'good');
        },
      },
    },
    match ? `⚔️ ${match.info.name} · 👤 ${session.name}` : session.userId ? `👤 ${session.name}` : '👤 Ospite',
  );
  hud.myId = session.userId;
  // Miniature 3D degli edifici nel menu di costruzione (generate in sottofondo)
  makeThumbnails((id, url) => hud.setThumbnail(id, url));
  if (realm) {
    realm.onPlayers((p) => hud.setPlayers(p));
    realm.onChat((m) => hud.addChat(m));
    realm.onCaravan((c) => game.receive(c.goods, c.fromName));
  }

  // ───── Strumenti e selezione ─────
  let hover: PointerTile | null = null;
  /** Reparti selezionati sulla mappa. */
  let selectedCompanies: string[] = [];
  function selectCompanies(ids: string[]) {
    selectedCompanies = ids;
    view.setSelectedCompanies(ids);
    hud.setCompanySelection(ids);
  }
  function setTool(id: string | null) {
    tool = id;
    hud.setTool(id);
    view.setLeftPan(!id);
    if (id) select(null);
    updateGhost();
  }
  function select(b: ReturnType<Game['buildingAt']> | null) {
    // Gli edifici nascosti dalla nebbia non si possono selezionare
    if (b && !game.isRevealed(b)) b = null;
    view.select(b ?? null);
    hud.select(b ?? null);
  }
  function updateGhost() {
    if (!tool) {
      view.setGhost(null, null, false);
      return;
    }
    const ok = hover ? game.canPlace(tool, hover.x, hover.z).ok : false;
    view.setGhost(tool, hover, ok);
  }
  function placeAt(t: PointerTile) {
    if (!tool) return;
    const check = game.canPlace(tool, t.x, t.z);
    if (check.ok) game.place(tool, t.x, t.z);
    else hud.toast(check.reason ?? 'Impossibile costruire qui', 'bad');
  }

  // ───── Input ─────
  let down: { x: number; y: number; button: number } | null = null;
  /** Inizio della linea in corso (mura, fossati, strade): si costruisce al rilascio. */
  let lineStart: PointerTile | null = null;
  const lineFrom = (end: PointerTile) => lineTiles(lineStart!.x, lineStart!.z, end.x, end.z);
  function updateLinePreview() {
    if (!tool || !lineStart || !hover) {
      view.setLinePreview(null);
      return;
    }
    const tiles = lineFrom(hover);
    // Il costo cresce lungo la linea: segna in rosso le caselle che non si possono pagare
    const def = getBuilding(tool);
    let budgetOk = true;
    const res = { ...game.state.resources };
    view.setLinePreview(
      tiles.map(([x, z]) => {
        const c = game.canPlace(tool!, x, z);
        let ok = c.ok || c.reason === 'Risorse insufficienti';
        if (ok) {
          for (const [id, n] of Object.entries(def.cost)) {
            res[id as keyof typeof res] -= n ?? 0;
            if (res[id as keyof typeof res] < 0) budgetOk = false;
          }
          ok = budgetOk;
        }
        return { x, z, ok };
      }),
    );
  }

  // Selezione a riquadro: Maiusc + trascina col tasto sinistro
  let boxStart: { x: number; y: number } | null = null;
  const boxEl = el('div', { class: 'select-box hidden' });
  app.append(boxEl);
  canvas.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY, button: e.button };
    if (e.button === 0 && e.shiftKey && !tool) {
      boxStart = { x: e.clientX, y: e.clientY };
      view.controls.enabled = false;
    }
    const t = view.pick(e.clientX, e.clientY);
    if (tool && e.button === 0 && t) {
      if (getBuilding(tool).draggable) {
        lineStart = t;
        updateLinePreview();
      } else placeAt(t);
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    hover = view.pick(e.clientX, e.clientY);
    if (boxStart) {
      const x0 = Math.min(boxStart.x, e.clientX);
      const y0 = Math.min(boxStart.y, e.clientY);
      Object.assign(boxEl.style, { left: `${x0}px`, top: `${y0}px`, width: `${Math.abs(e.clientX - boxStart.x)}px`, height: `${Math.abs(e.clientY - boxStart.y)}px` });
      boxEl.classList.toggle('hidden', Math.hypot(e.clientX - boxStart.x, e.clientY - boxStart.y) < 6);
    }
    if (lineStart) updateLinePreview();
    updateGhost();
  });
  canvas.addEventListener('pointerleave', () => {
    hover = null;
    updateGhost();
  });
  window.addEventListener('pointerup', (e) => {
    if (boxStart) {
      const big = Math.hypot(e.clientX - boxStart.x, e.clientY - boxStart.y) >= 6;
      if (big) {
        const x0 = Math.min(boxStart.x, e.clientX);
        const x1 = Math.max(boxStart.x, e.clientX);
        const y0 = Math.min(boxStart.y, e.clientY);
        const y1 = Math.max(boxStart.y, e.clientY);
        const inside = (game.state.companies ?? []).filter((c) => {
          const p = view.toScreen(c.x, c.z);
          return p.visible && p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
        });
        selectCompanies([...new Set([...selectedCompanies, ...inside.map((c) => c.id)])]);
        select(null);
        down = null;
      }
      boxStart = null;
      boxEl.classList.add('hidden');
      view.controls.enabled = true;
      if (big) return;
    }
    if (lineStart && tool) {
      const end = view.pick(e.clientX, e.clientY) ?? hover ?? lineStart;
      const r = game.placeLine(tool, lineFrom(end));
      if (!r.placed || r.reason === 'Risorse insufficienti') hud.toast(r.reason ?? 'Impossibile costruire qui', 'bad');
      lineStart = null;
      view.setLinePreview(null);
    }
    const moved = down ? Math.hypot(e.clientX - down.x, e.clientY - down.y) : 99;
    if (down && moved < 5 && e.target === canvas) {
      if (down.button === 2 && tool) setTool(null);
      else if (down.button === 2 && selectedCompanies.length) {
        // Ordine ai reparti selezionati: su un edificio nemico attacca, altrimenti muove
        const t = view.pick(e.clientX, e.clientY);
        const p = view.pickPoint(e.clientX, e.clientY);
        if (t && p) {
          const b = game.buildingAt(t.x, t.z);
          const foe = game.enemyCompanies.find((c) => Math.hypot(c.x - p.x, c.z - p.z) < 1);
          if (b && game.isForeign(b)) {
            const r = game.orderAttack(selectedCompanies, t.x + 0.5, t.z + 0.5);
            hud.toast(r.ok ? '⚔️ All\'attacco!' : r.reason ?? '', r.ok ? 'good' : 'bad');
          } else if (foe) {
            // Contro un reparto nemico: lo si va a ingaggiare
            game.orderMove(selectedCompanies, foe.x, foe.z);
            game.setBehavior(selectedCompanies, 'aggressive');
            hud.toast('⚔️ Ingaggiate il nemico!', 'good');
          } else game.orderMove(selectedCompanies, p.x, p.z, e.shiftKey); // Maiusc: aggiunge una tappa
        }
      } else if (down.button === 0 && !tool) {
        const p = view.pickPoint(e.clientX, e.clientY);
        const c = p ? game.companyAt(p.x, p.z) : undefined;
        if (c) {
          // Maiusc (o Ctrl) per aggiungere o togliere dalla selezione
          if (e.shiftKey || e.ctrlKey) {
            selectCompanies(selectedCompanies.includes(c.id) ? selectedCompanies.filter((x) => x !== c.id) : [...selectedCompanies, c.id]);
          } else selectCompanies([c.id]);
          select(null);
        } else {
          if (!e.shiftKey) selectCompanies([]);
          const t = view.pick(e.clientX, e.clientY);
          select(t ? game.structureAt(t.x, t.z) ?? null : null);
        }
      }
    }
    down = null;
    updateGhost();
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  // Gruppi rapidi: Ctrl+1…5 assegna, 1…5 richiama (due volte: centra la telecamera)
  const groups = new Map<string, string[]>();
  let lastGroupKey = { key: '', at: 0 };
  window.addEventListener('keydown', (e) => {
    if (hud.isTyping) return;
    const comps = game.state.companies ?? [];
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && comps.length) {
      e.preventDefault();
      selectCompanies(comps.map((c) => c.id));
      return;
    }
    if (/^[1-5]$/.test(e.key)) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        groups.set(e.key, [...selectedCompanies]);
        hud.toast(`Gruppo ${e.key}: ${selectedCompanies.length} reparti.`, 'info');
      } else {
        const ids = (groups.get(e.key) ?? []).filter((id) => comps.some((c) => c.id === id));
        if (ids.length) {
          selectCompanies(ids);
          const now = performance.now();
          if (lastGroupKey.key === e.key && now - lastGroupKey.at < 450) {
            const cs = comps.filter((c) => ids.includes(c.id));
            view.focus(cs.reduce((s, c) => s + c.x, 0) / cs.length, cs.reduce((s, c) => s + c.z, 0) / cs.length);
          }
          lastGroupKey = { key: e.key, at: now };
        }
      }
      return;
    }
    if (selectedCompanies.length && !e.ctrlKey) {
      const order: Array<'line' | 'column' | 'wedge' | 'square' | 'shields'> = ['line', 'column', 'wedge', 'square', 'shields'];
      if (e.key.toLowerCase() === 'f') {
        const cur = comps.find((c) => c.id === selectedCompanies[0])?.formation ?? 'line';
        game.setFormation(selectedCompanies, order[(order.indexOf(cur) + 1) % order.length]);
        return;
      }
      if (e.key.toLowerCase() === 'h') {
        game.orderHome(selectedCompanies);
        return;
      }
    }
    if (e.key === 'Escape') {
      lineStart = null;
      view.setLinePreview(null);
      if (selectedCompanies.length) selectCompanies([]);
      if (tool) setTool(null);
      else select(null);
    } else if (e.key === ' ') {
      e.preventDefault();
      setSpeed((ms ? ms.displaySpeed : speed) === 0 ? 1 : 0);
    } else if (e.key === 'Delete' && hud.selected) {
      game.demolish(hud.selected.uid);
      select(null);
    }
  });

  // ───── Ciclo principale ─────
  let last = performance.now();
  let lastHud = 0;
  let lastSave = performance.now();
  let lastPresence = 0;
  const frame = (now: number) => {
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    // In giocatore singolo, durante un assedio il tempo scorre più lento per seguirlo e decidere
    // e prima di un pericolo vicino (predoni, nemici nel territorio) non va oltre la velocità normale
    const danger = !ms && (game.enemiesInTerritory() > 0 || (game.state.incoming ?? []).some((a) => !a.resolved && a.arriveDay - game.state.day < 4) || game.daysToRaid() < 4);
    const eff = ms ? ms.speed(speed) : Math.min(speed, danger ? 1 : speed) * (game.siegeActive() ? SIEGE_TIME : 1);
    if (eff > 0) game.advance((dt * eff) / SECONDS_PER_DAY);
    ms?.tick(now);
    if (now - lastHud > 200) {
      lastHud = now;
      // Atmosfera musicale: stagione, oppure pericolo se ci sono nemici vicini
      const danger =
        game.enemiesInTerritory() > 0 ||
        (game.state.incoming ?? []).some((a) => !a.resolved && a.arriveDay - game.state.day < 6) ||
        game.daysToRaid() < 8;
      music.setMood(moodFor(game.date.season, danger));
      hud.refresh(ms ? ms.displaySpeed : speed);
      if (tool) updateGhost();
    }
    if (now - lastSave > AUTOSAVE_MS) {
      lastSave = now;
      void save();
    }
    if (realm?.connected && now - lastPresence > PRESENCE_MS) {
      lastPresence = now;
      void realm.update(me());
    }
    // Interruttore di debug (test automatici): sospende solo il disegno, non la simulazione
    if (!(window as unknown as { __noRender?: boolean }).__noRender) view.render();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void save();
  });
  // Partita multigiocatore: presenza, orologio condiviso, salvataggi
  if (match) {
    try {
      const room = await match.service.connect(match.info);
      ms = new MatchSession(game, match.info, match.service, room, app, (text, kind) => hud.toast(text, kind));
      window.addEventListener('beforeunload', () => void ms?.save());
    } catch (e) {
      hud.toast(`Connessione alla partita fallita: ${(e as Error).message}`, 'bad');
      game.locked = true;
    }
  }
  // Per i test automatici e il debug dalla console
  (window as unknown as { medieval: unknown }).medieval = { game, view, setTool, match: () => ms, music };
}

boot().catch((e) => {
  console.error(e);
  document.body.append(el('pre', { class: 'fatal', text: `Errore: ${(e as Error).message}` }));
});
