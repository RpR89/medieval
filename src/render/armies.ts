import * as THREE from 'three';
import type { Game } from '../game/sim/game';
import type { Force } from '../game/sim/state';
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

function buildArmy(f: Force, enemy: boolean): THREE.Group {
  const m = enemy ? tabardBlue : tabardRed;
  const g = new THREE.Group();
  // Formazione: fanti davanti, arcieri dietro, cavalieri sui fianchi, macchine in coda
  const show = (n: number) => Math.min(n, 18);
  let row = 0;
  const place = (n: number, kind: 'infantry' | 'archers' | 'cavalry', perRow: number) => {
    for (let i = 0; i < show(n); i++) {
      const s = soldier(m, kind);
      const r = Math.floor(i / perRow);
      const c = (i % perRow) - (perRow - 1) / 2;
      s.position.set(-(row + r) * 0.22, 0, c * 0.2);
      g.add(s);
    }
    row += Math.ceil(show(n) / perRow);
  };
  place(f.infantry, 'infantry', 5);
  place(f.archers, 'archers', 5);
  place(f.cavalry, 'cavalry', 4);
  for (let i = 0; i < Math.min(f.rams, 3); i++) {
    const r = ram();
    r.position.set(-(row + 0.6) * 0.22, 0, (i - 1) * 0.35);
    g.add(r);
  }
  if (f.rams) row += 2;
  for (let i = 0; i < Math.min(f.trebuchets, 2); i++) {
    const t = trebuchet();
    t.position.set(-(row + 1) * 0.22, 0, (i - 0.5) * 0.45);
    g.add(t);
  }
  const baked = bake(g);
  baked.add(flag(enemy ? mats().flagBlue : mats().flag, 0.25, 0, -0.55, 0.3));
  return baked;
}

export class ArmyView {
  readonly group = new THREE.Group();
  private armies = new Map<string, ArmyObj>();

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
    };
    for (const e of g.state.expeditions ?? []) {
      if (e.status === 'marching') show(e.id, e.troops, home, away, e.departDay, e.arriveDay, false);
      else if (e.result) show(e.id, e.result.survivors, away, home, e.arriveDay, e.returnDay ?? e.arriveDay, false);
    }
    for (const a of g.state.incoming ?? []) {
      if (!a.resolved) show(`in:${a.id}`, a.troops, away, home, a.departDay, a.arriveDay, true);
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

  /** Oggetti animati (bandiere) da passare all'animazione generica. */
  objects(): THREE.Object3D[] {
    return [...this.armies.values()].map((a) => a.obj);
  }
}
