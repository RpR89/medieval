import './style.css';
import { supabase } from './config/supabase';
import { getBuilding } from './game/data/buildings';
import { RESOURCES } from './game/data/resources';
import { Game } from './game/sim/game';
import type { GameState } from './game/sim/state';
import { SupabaseRealm, type RealmPlayer } from './net/realm';
import { WorldRenderer, type PointerTile } from './render/scene';
import { el } from './ui/dom';
import { Hud } from './ui/hud';
import { showStartScreen, type Session } from './ui/start';

const AUTOSAVE_MS = 30_000;
const PRESENCE_MS = 10_000;

async function boot() {
  const app = document.getElementById('app')!;
  const { session, state } = await showStartScreen(app);
  startGame(app, session, state);
}

function startGame(app: HTMLElement, session: Session, state: GameState) {
  const canvas = el('canvas', { class: 'world' });
  app.append(canvas);
  const game = new Game(state);
  const view = new WorldRenderer(canvas, game);
  let speed = 1;
  let tool: string | null = null;

  // ───── Salvataggi ─────
  let saving = false;
  const save = async (manual = false) => {
    if (saving) return;
    saving = true;
    hud.setSaveStatus('Salvataggio…');
    try {
      await session.store.save(game.state);
      hud.setSaveStatus(`Salvato ${new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`);
      if (manual) hud.toast(`Partita salvata (${session.store.label}).`, 'good');
    } catch (e) {
      hud.setSaveStatus('⚠️ Salvataggio fallito');
      hud.toast(`Salvataggio fallito: ${(e as Error).message}`, 'bad');
    } finally {
      saving = false;
    }
  };

  // ───── Multiplayer ─────
  const realm = session.userId && supabase ? new SupabaseRealm(supabase) : null;
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
      onSpeed: (s) => (speed = s),
      onSave: () => save(true),
      onExit: async () => {
        await save();
        await realm?.leave();
        location.reload();
      },
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
    session.userId ? `👤 ${session.name}` : '👤 Ospite',
  );
  hud.myId = session.userId;
  if (realm) {
    realm.onPlayers((p) => hud.setPlayers(p));
    realm.onChat((m) => hud.addChat(m));
    realm.onCaravan((c) => game.receive(c.goods, c.fromName));
  }

  // ───── Strumenti e selezione ─────
  let hover: PointerTile | null = null;
  function setTool(id: string | null) {
    tool = id;
    hud.setTool(id);
    view.setLeftPan(!id);
    if (id) select(null);
    updateGhost();
  }
  function select(b: ReturnType<Game['buildingAt']> | null) {
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
    else if (!dragging || check.reason === 'Risorse insufficienti') hud.toast(check.reason ?? 'Impossibile costruire qui', 'bad');
  }

  // ───── Input ─────
  let down: { x: number; y: number; button: number } | null = null;
  let dragging = false;
  let lastDragTile = '';

  canvas.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY, button: e.button };
    const t = view.pick(e.clientX, e.clientY);
    if (tool && e.button === 0 && t) {
      dragging = true;
      lastDragTile = `${t.x},${t.z}`;
      placeAt(t);
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    hover = view.pick(e.clientX, e.clientY);
    if (dragging && tool && hover && getBuilding(tool).draggable) {
      const k = `${hover.x},${hover.z}`;
      if (k !== lastDragTile) {
        lastDragTile = k;
        placeAt(hover);
      }
    }
    updateGhost();
  });
  canvas.addEventListener('pointerleave', () => {
    hover = null;
    updateGhost();
  });
  window.addEventListener('pointerup', (e) => {
    const moved = down ? Math.hypot(e.clientX - down.x, e.clientY - down.y) : 99;
    if (down && moved < 5 && e.target === canvas) {
      if (down.button === 2 && tool) setTool(null);
      else if (down.button === 0 && !tool) {
        const t = view.pick(e.clientX, e.clientY);
        select(t ? game.buildingAt(t.x, t.z) ?? null : null);
      }
    }
    down = null;
    dragging = false;
    updateGhost();
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('keydown', (e) => {
    if (hud.isTyping) return;
    if (e.key === 'Escape') {
      if (tool) setTool(null);
      else select(null);
    } else if (e.key === ' ') {
      e.preventDefault();
      speed = speed === 0 ? 1 : 0;
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
    if (speed > 0) game.advance(dt * speed);
    if (now - lastHud > 200) {
      lastHud = now;
      hud.refresh(speed);
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
    view.render();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void save();
  });
  // Per i test automatici e il debug dalla console
  (window as unknown as { medieval: unknown }).medieval = { game, view, setTool };
}

boot().catch((e) => {
  console.error(e);
  document.body.append(el('pre', { class: 'fatal', text: `Errore: ${(e as Error).message}` }));
});
