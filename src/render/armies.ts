import * as THREE from 'three';
import type { Game } from '../game/sim/game';
import type { Company, Force } from '../game/sim/state';
import type { Formation } from '../game/data/units';
import { bake, box, cone, cyl, flag, mats, sphere } from './kit';
import type { TerrainView } from './terrain';

/**
 * Eserciti in marcia sulla mappa: i nostri (rossi) verso il castello nemico e ritorno,
 * quelli nemici (blu) in arrivo verso di noi.
 */

interface ArmyObj {
  obj: THREE.Group;
  key: string;
}

const tabardRed = new THREE.MeshStandardMaterial({ color: 0xa8302a, roughness: 0.9 });
const tabardBlue = new THREE.MeshStandardMaterial({ color: 0x2f5fb8, roughness: 0.9 });
const tabards = new Map<number, THREE.MeshStandardMaterial>();
const flags = new Map<number, THREE.MeshStandardMaterial>();
/** Colore dello schieramento: rosso il giocatore, blu l'avversario, altri colori per i signori. */
export const SIDE_COLORS = [0xa8302a, 0x2f5fb8, 0x3f8a4a, 0xd8a83a, 0x7a3a8a, 0x2a8a8a];
function tabardFor(color: number) {
  if (color === 0xa8302a) return tabardRed;
  if (color === 0x2f5fb8) return tabardBlue;
  if (!tabards.has(color)) tabards.set(color, new THREE.MeshStandardMaterial({ color, roughness: 0.9 }));
  return tabards.get(color)!;
}
function flagFor(color: number) {
  if (!flags.has(color)) flags.set(color, new THREE.MeshStandardMaterial({ color, roughness: 0.9, side: THREE.DoubleSide }));
  return flags.get(color)!;
}

/** Etichetta sopra il reparto: composizione e formazione, del colore dello schieramento. */
function label(f: Force, color: number, formation: Formation, envoy: boolean): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 320;
  c.height = 72;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgba(25, 18, 12, 0.82)';
  ctx.beginPath();
  ctx.roundRect(2, 2, 316, 68, 14);
  ctx.fill();
  ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
  ctx.beginPath();
  ctx.roundRect(2, 2, 18, 68, [14, 0, 0, 14]);
  ctx.fill();
  ctx.fillStyle = '#f4ead6';
  ctx.font = 'bold 30px Georgia, serif';
  ctx.textBaseline = 'middle';
  const parts: string[] = [];
  if (envoy) parts.push(color === 0x3f8a4a ? '🐎 Esploratore' : '🕊️ Diplomatico');
  else {
    if (f.infantry) parts.push(`🛡️${f.infantry}`);
    if (f.archers) parts.push(`🏹${f.archers}`);
    if (f.cavalry) parts.push(`🐎${f.cavalry}`);
    if (f.rams) parts.push(`🪵${f.rams}`);
    if (f.trebuchets) parts.push(`🎯${f.trebuchets}`);
    parts.push({ line: '▬', column: '⋮', wedge: '▲', square: '■', shields: '⛨' }[formation]);
  }
  ctx.fillText(parts.join(' '), 32, 38);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  // Dimensione costante sullo schermo, a qualsiasi zoom
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false }));
  sp.scale.set(0.14, 0.032, 1);
  sp.renderOrder = 10;
  sp.userData.label = true;
  return sp;
}
const skin = new THREE.MeshStandardMaterial({ color: 0xd9b08c, roughness: 0.9 });

function soldier(m: THREE.Material, kind: 'infantry' | 'archers' | 'cavalry'): THREE.Group {
  const k = mats();
  const g = new THREE.Group();
  if (kind === 'cavalry') {
    g.add(box(0.26, 0.11, 0.09, k.horse, 0, 0.11, 0));
    for (const [x, z] of [[-0.1, -0.03], [0.1, -0.03], [-0.1, 0.03], [0.1, 0.03]]) g.add(box(0.025, 0.11, 0.025, k.horseDark, x, 0, z));
    g.add(box(0.06, 0.1, 0.05, k.horse, 0.14, 0.18, 0));
    g.add(box(0.06, 0.11, 0.06, m, -0.02, 0.22, 0));
    g.add(sphere(0.03, skin, -0.02, 0.35, 0, 0));
    const lance = cyl(0.006, 0.006, 0.42, k.planks, 0.05, 0.18, 0.04, 4);
    lance.rotation.z = -1.1;
    g.add(lance);
  } else {
    for (const s of [-1, 1]) g.add(box(0.025, 0.09, 0.025, k.beam, 0, 0, s * 0.02));
    g.add(box(0.06, 0.1, 0.07, m, 0, 0.09, 0));
    g.add(sphere(0.028, skin, 0, 0.215, 0, 0));
    g.add(cone(0.032, 0.03, k.iron, 0, 0.235, 0, 6));
    if (kind === 'infantry') {
      g.add(cyl(0.005, 0.005, 0.32, k.planks, 0.04, 0.04, 0, 4));
      g.add(cone(0.01, 0.03, k.iron, 0.04, 0.36, 0, 4));
      g.add(box(0.012, 0.08, 0.06, m, -0.04, 0.08, 0));
    } else {
      const bow = cyl(0.005, 0.005, 0.18, k.darkPlanks, 0.04, 0.06, 0, 4);
      bow.rotation.x = 0.2;
      g.add(bow);
    }
  }
  return g;
}

function ram(): THREE.Group {
  const k = mats();
  const g = new THREE.Group();
  g.add(box(0.36, 0.04, 0.2, k.planks, 0, 0.06, 0));
  for (const x of [-0.13, 0.13]) for (const z of [-0.11, 0.11]) {
    const w = cyl(0.05, 0.05, 0.03, k.darkPlanks, 0, 0, 0, 8);
    w.rotation.x = Math.PI / 2;
    w.position.set(x, 0.05, z);
    g.add(w);
  }
  const log = cyl(0.04, 0.04, 0.44, k.log, 0, 0, 0, 7);
  log.rotation.z = Math.PI / 2;
  log.position.set(0.04, 0.14, 0);
  g.add(log);
  g.add(cone(0.05, 0.06, k.iron, 0.29, 0.11, 0, 6));
  g.add(box(0.38, 0.02, 0.24, k.thatch, 0, 0.22, 0));
  return g;
}

function trebuchet(): THREE.Group {
  const k = mats();
  const g = new THREE.Group();
  g.add(box(0.4, 0.04, 0.26, k.planks, 0, 0.04, 0));
  for (const z of [-0.1, 0.1]) {
    const a = box(0.03, 0.4, 0.03, k.log, -0.06, 0.04, z);
    a.rotation.z = 0.25;
    g.add(a);
    const b = box(0.03, 0.4, 0.03, k.log, 0.06, 0.04, z);
    b.rotation.z = -0.25;
    g.add(b);
  }
  const arm = box(0.6, 0.025, 0.025, k.log, 0, 0.42, 0);
  arm.rotation.z = 0.6;
  g.add(arm);
  g.add(box(0.1, 0.1, 0.1, k.stoneDark, -0.22, 0.2, 0));
  return g;
}

/** Posizioni dei soldati (in avanti = +x) secondo la formazione. */
function slots(n: number, formation: Formation): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const sp = formation === 'shields' ? 0.17 : 0.21;
  if (formation === 'column') {
    for (let i = 0; i < n; i++) out.push([-Math.floor(i / 2) * sp, ((i % 2) - 0.5) * sp]);
  } else if (formation === 'wedge') {
    for (let r = 0; out.length < n; r++) for (let c = -r; c <= r && out.length < n; c++) out.push([-r * sp, c * sp]);
  } else if (formation === 'square') {
    const side = Math.max(2, Math.ceil(n / 4) + 1);
    const h = ((side - 1) * sp) / 2;
    for (let i = 0; out.length < n; i++) {
      const k = i % (side - 1);
      const e = Math.floor(i / (side - 1)) % 4;
      const ring = Math.floor(i / (4 * (side - 1)));
      const t = -h + k * sp;
      const hh = h - ring * sp;
      out.push(e === 0 ? [hh, t] : e === 1 ? [-t, hh] : e === 2 ? [-hh, -t] : [t, -hh]);
    }
  } else {
    const per = formation === 'shields' ? 5 : 7;
    for (let i = 0; i < n; i++) out.push([-Math.floor(i / per) * sp, ((i % per) - (per - 1) / 2) * sp]);
  }
  return out;
}

function buildArmy(f: Force, enemy: boolean, formation: Formation = 'line', color?: number): THREE.Group {
  const m = color !== undefined ? tabardFor(color) : enemy ? tabardBlue : tabardRed;
  const g = new THREE.Group();
  const k = mats();
  const cap = (n: number) => Math.min(n, 18);
  // Fanti davanti, arcieri dietro (al centro nel quadrato), cavalieri in coda
  const kinds: Array<'infantry' | 'archers' | 'cavalry'> = [];
  for (let i = 0; i < cap(f.infantry); i++) kinds.push('infantry');
  const archers: Array<'archers'> = Array(cap(f.archers)).fill('archers');
  if (formation !== 'square') kinds.push(...archers);
  for (let i = 0; i < cap(f.cavalry); i++) kinds.push('cavalry');
  const pos = slots(kinds.length, formation);
  kinds.forEach((kind, i) => {
    const s = soldier(m, kind);
    s.position.set(pos[i][0], 0, pos[i][1]);
    if (formation === 'shields' && kind === 'infantry') {
      // Pavese: grande scudo davanti al fante
      s.add(box(0.02, 0.17, 0.12, m, 0.06, 0.02, 0));
      s.add(box(0.021, 0.04, 0.124, k.planks, 0.061, 0.08, 0));
    }
    g.add(s);
  });
  if (formation === 'square') {
    const inner = slots(archers.length, 'line');
    archers.forEach((kind, i) => {
      const s = soldier(m, kind);
      s.position.set(inner[i][0] * 0.6 - 0.1, 0, inner[i][1] * 0.6);
      g.add(s);
    });
  }
  const back = Math.min(...pos.map((p) => p[0]), 0) - 0.3;
  for (let i = 0; i < Math.min(f.rams, 3); i++) {
    const r = ram();
    r.position.set(back - 0.1, 0, (i - 1) * 0.35);
    g.add(r);
  }
  for (let i = 0; i < Math.min(f.trebuchets, 2); i++) {
    const t = trebuchet();
    t.position.set(back - (f.rams ? 0.55 : 0.2), 0, (i - 0.5) * 0.45);
    g.add(t);
  }
  const baked = bake(g);
  baked.add(flag(color !== undefined ? flagFor(color) : enemy ? mats().flagBlue : mats().flag, 0.25, 0, -0.55, 0.3));
  // Soldati più grandi del naturale rispetto agli edifici: si riconoscono meglio dall'alto
  baked.scale.setScalar(1.45);
  return baked;
}

/** Diplomatico a cavallo con il drappo bianco. */
/** Carri delle salmerie in fila dietro al reparto (verso -x, la marcia va verso +x). */
function wagonTrain(n: number): THREE.Group {
  const k = mats();
  const g = new THREE.Group();
  for (let i = 0; i < Math.min(4, n); i++) {
    const w = new THREE.Group();
    w.add(box(0.36, 0.1, 0.2, k.darkPlanks, 0, 0.08, 0));
    // Tela tesa sugli archi
    const cover = cyl(0.11, 0.11, 0.34, k.cloth[2], 0, 0, 0, 8);
    cover.rotation.z = Math.PI / 2;
    cover.position.set(0, 0.2, 0);
    cover.scale.set(1, 1, 0.9);
    w.add(cover);
    for (const [x, z] of [[-0.12, -0.11], [0.12, -0.11], [-0.12, 0.11], [0.12, 0.11]]) {
      const wh = cyl(0.06, 0.06, 0.02, k.planks, 0, 0, 0, 8);
      wh.rotation.x = Math.PI / 2;
      wh.position.set(x, 0.06, z);
      w.add(wh);
    }
    // Cavallo da tiro davanti
    w.add(box(0.2, 0.09, 0.07, k.horse, 0.32, 0.1, 0));
    w.add(box(0.06, 0.08, 0.05, k.horse, 0.44, 0.17, 0));
    for (const [x, z] of [[0.25, -0.025], [0.25, 0.025], [0.38, -0.025], [0.38, 0.025]]) w.add(box(0.02, 0.1, 0.02, k.horseDark, x, 0, z));
    w.add(box(0.2, 0.012, 0.012, k.beam, 0.2, 0.12, 0));
    w.position.set(-0.75 - i * 0.62, 0, (i % 2) * 0.12 - 0.06);
    g.add(w);
  }
  return g;
}

function envoyModel(color: number): THREE.Group {
  const k = mats();
  const g = soldier(tabardFor(color), 'cavalry');
  g.add(cyl(0.008, 0.008, 0.5, k.beam, -0.02, 0.2, -0.05, 4));
  g.add(box(0.16, 0.1, 0.005, new THREE.MeshStandardMaterial({ color: 0xf4f0e6, side: THREE.DoubleSide }), 0.06, 0.62, -0.05));
  const out = bake(g);
  out.scale.setScalar(1.8);
  return out;
}

const ringGeo = new THREE.RingGeometry(0.55, 0.68, 32).rotateX(-Math.PI / 2);
const ringMat = new THREE.MeshBasicMaterial({ color: 0xffd54a, transparent: true, opacity: 0.9, depthWrite: false });

export class ArmyView {
  readonly group = new THREE.Group();
  private armies = new Map<string, ArmyObj>();
  private selected = new Set<string>();
  /** Posizioni mostrate dei reparti nemici (si avvicinano dolcemente a quelle ricevute). */
  private shown = new Map<string, { x: number; z: number }>();

  setSelected(ids: string[]) {
    this.selected = new Set(ids);
  }

  constructor(private game: Game, private terrain: TerrainView) {}

  update(t: number) {
    const g = this.game;
    const slot = g.state.match?.slot ?? 0;
    const home = g.terrain.sites[slot];
    const away = g.terrain.sites[1 - slot];
    const day = g.state.day;
    const seen = new Set<string>();
    const show = (id: string, f: Force, from: [number, number], to: [number, number], d0: number, d1: number, enemy: boolean) => {
      if (!from || !to) return;
      const key = `${id}:${JSON.stringify(f)}`;
      seen.add(id);
      let a = this.armies.get(id);
      if (!a || a.key !== key) {
        if (a) this.group.remove(a.obj);
        a = { obj: buildArmy(f, enemy), key };
        a.obj.name = `army:${id}`;
        this.armies.set(id, a);
        this.group.add(a.obj);
      }
      // Si ferma a qualche casella dalle mura del bersaglio
      const dx = to[0] - from[0];
      const dz = to[1] - from[1];
      const len = Math.hypot(dx, dz) || 1;
      const stop = 8 / len;
      const p = Math.min(1, Math.max(0, (day - d0) / Math.max(0.01, d1 - d0))) * (1 - stop * 2) + stop;
      const x = from[0] + dx * p;
      const z = from[1] + dz * p;
      a.obj.position.set(x, this.terrain.heightAt(x, z) + Math.abs(Math.sin(t * 6)) * 0.015, z);
      a.obj.rotation.y = Math.atan2(-dz, dx);
      // Le truppe nemiche si vedono solo dove c'è qualcuno a guardare
      a.obj.visible = !enemy || g.isVisible(x, z);
    };
    for (const e of g.state.expeditions ?? []) {
      if (e.status === 'marching') show(e.id, e.troops, home, away, e.departDay, e.arriveDay, false);
      else if (e.result) show(e.id, e.result.survivors, away, home, e.arriveDay, e.returnDay ?? e.arriveDay, false);
    }
    for (const a of g.state.incoming ?? []) {
      // Gli assalti dei reparti nemici sono già visibili come reparti
      if (!a.resolved && a.arriveDay > a.departDay) show(`in:${a.id}`, a.troops, away, home, a.departDay, a.arriveDay, true);
    }
    // Reparti comandati dai giocatori
    const place = (
      id: string,
      f: Force,
      x: number,
      z: number,
      heading: number,
      moving: boolean,
      enemy: boolean,
      formation: Formation = 'line',
      color?: number,
      envoy = false,
      wagons = 0,
    ) => {
      // Chiave con numeri interi: le truppe calano di frazioni (assedi, fame) e non serve ricostruire a ogni fotogramma
      const key = `${id}:${Math.round(f.infantry)},${Math.round(f.archers)},${Math.round(f.cavalry)},${f.rams},${f.trebuchets}:${formation}:${color}:${envoy}:${wagons}`;
      seen.add(id);
      let a = this.armies.get(id);
      if (!a || a.key !== key) {
        if (a) this.group.remove(a.obj);
        const root = new THREE.Group();
        const body = envoy ? envoyModel(color ?? 0xffffff) : buildArmy(f, enemy, formation, color);
        if (wagons) body.add(wagonTrain(wagons));
        body.userData.body = true;
        body.traverse((o) => {
          if (o instanceof THREE.Mesh) o.castShadow = false;
        });
        root.add(body);
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.userData.ring = true;
        ring.position.y = 0.04;
        ring.scale.setScalar(1.2 + Math.min(1.4, Math.sqrt(f.infantry + f.archers + f.cavalry) * 0.15));
        root.add(ring);
        const lab = label(f, color ?? (enemy ? 0x2f5fb8 : 0xa8302a), formation, envoy);
        lab.position.y = 1.15;
        root.add(lab);
        a = { obj: root, key };
        a.obj.name = `army:${id}`;
        this.armies.set(id, a);
        this.group.add(a.obj);
      }
      a.obj.position.set(x, this.terrain.heightAt(x, z) + (moving ? Math.abs(Math.sin(t * 7 + x)) * 0.02 : 0), z);
      for (const ch of a.obj.children) {
        if (ch.userData.body) ch.rotation.y = heading;
        if (ch.userData.ring) ch.visible = this.selected.has(id);
      }
    };
    // Predoni che assediano il castello (senza un reparto di un signore): accampati davanti alle mura
    const sg = g.state.siege;
    if (sg && sg.lord === undefined) {
      const [kx, kz] = g.keepCenter();
      const r = (n: number) => Math.round(n);
      place('siege-raiders', { infantry: r(sg.troops.infantry), archers: r(sg.troops.archers), cavalry: r(sg.troops.cavalry), rams: sg.troops.rams, trebuchets: 0 }, sg.camp[0] + 0.5 + Math.cos(Math.atan2(kz - sg.camp[1], kx - sg.camp[0])) * 1.5, sg.camp[1] + 0.5 + Math.sin(Math.atan2(kz - sg.camp[1], kx - sg.camp[0])) * 1.5, Math.atan2(-(kz - sg.camp[1]), kx - sg.camp[0]), false, true, 'line', 0x6a5a4a);
    }
    for (const c of g.state.companies ?? []) place(c.id, c.troops, c.x, c.z, c.heading ?? 0, !!c.path?.length, false, c.formation, c.scout ? 0x3f8a4a : undefined, !!c.envoy || !!c.scout, c.wagons ?? 0);
    this.updatePaths(g.state.companies ?? []);
    for (const c of g.enemyCompanies) {
      const prev = this.shown.get(c.id) ?? { x: c.x, z: c.z };
      const moving = Math.hypot(c.x - prev.x, c.z - prev.z) > 0.01;
      prev.x += (c.x - prev.x) * 0.15;
      prev.z += (c.z - prev.z) * 0.15;
      this.shown.set(c.id, prev);
      place(`e:${c.id}`, c.troops, prev.x, prev.z, c.heading ?? 0, moving, true, c.formation, c.owner !== undefined ? SIDE_COLORS[c.owner + 1] : undefined, !!c.envoy);
      const shown = this.armies.get(`e:${c.id}`);
      if (shown) shown.obj.visible = g.isVisible(prev.x, prev.z);
    }
    for (const [id, a] of this.armies) {
      if (seen.has(id)) continue;
      this.group.remove(a.obj);
      a.obj.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      this.armies.delete(id);
    }
  }

  private paths = new Map<string, { line: THREE.Line; marker: THREE.Group; key: string }>();
  private pathMat = new THREE.LineDashedMaterial({ color: 0xffd54a, dashSize: 0.3, gapSize: 0.2, transparent: true, opacity: 0.85, depthTest: false });

  /** Percorso tratteggiato e bandierina di arrivo per i reparti selezionati. */
  private updatePaths(list: Company[]) {
    const keep = new Set<string>();
    for (const c of list) {
      if (!this.selected.has(c.id) || !c.path?.length) continue;
      keep.add(c.id);
      const key = `${c.path.length}:${c.path[c.path.length - 1]}:${Math.round(c.x * 4)}:${Math.round(c.z * 4)}`;
      let p = this.paths.get(c.id);
      if (p && p.key === key) continue;
      const pts = [new THREE.Vector3(c.x, this.terrain.heightAt(c.x, c.z) + 0.08, c.z)];
      for (const [x, z] of c.path) pts.push(new THREE.Vector3(x + 0.5, this.terrain.heightAt(x + 0.5, z + 0.5) + 0.08, z + 0.5));
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      if (!p) {
        const line = new THREE.Line(geo, this.pathMat);
        line.renderOrder = 5;
        const marker = new THREE.Group();
        marker.add(cyl(0.015, 0.015, 0.5, mats().beam, 0, 0, 0, 4));
        marker.add(box(0.2, 0.12, 0.01, ringMat, 0.1, 0.36, 0));
        p = { line, marker, key };
        this.paths.set(c.id, p);
        this.group.add(line, marker);
      } else {
        p.line.geometry.dispose();
        p.line.geometry = geo;
        p.key = key;
      }
      p.line.computeLineDistances();
      const end = pts[pts.length - 1];
      p.marker.position.copy(end).setY(end.y - 0.08);
    }
    for (const [id, p] of this.paths) {
      if (keep.has(id)) continue;
      this.group.remove(p.line, p.marker);
      p.line.geometry.dispose();
      this.paths.delete(id);
    }
  }

  /** Oggetti animati (bandiere) da passare all'animazione generica. */
  objects(): THREE.Object3D[] {
    return [...this.armies.values()].map((a) => a.obj);
  }
}
