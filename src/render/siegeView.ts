import * as THREE from 'three';
import { getBuilding } from '../game/data/buildings';
import type { Game } from '../game/sim/game';
import { bake, box, cone, cyl, flag, mats, smoke, sphere } from './kit';
import type { TerrainView } from './terrain';

/**
 * Grafica dell'assedio in corso: l'accampamento nemico con tende, fuochi, scale e macchine,
 * i sassi lanciati ad arco sul tratto di mura bersagliato con la polvere dei colpi,
 * e i nugoli di frecce quando parte un assalto.
 */

interface Shot {
  mesh: THREE.Mesh;
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
  dur: number;
  arrow: boolean;
}

interface Puff {
  mesh: THREE.Mesh;
  t: number;
}

const stoneGeo = new THREE.IcosahedronGeometry(0.07, 0);
const arrowGeo = new THREE.BoxGeometry(0.22, 0.012, 0.012);
const puffGeo = new THREE.IcosahedronGeometry(0.2, 1);

export class SiegeView {
  readonly group = new THREE.Group();
  private camp: THREE.Group | null = null;
  private campKey = '';
  private shots: Shot[] = [];
  private puffs: Puff[] = [];
  private fireTimer = 0;
  private lastAssaults = -1;
  private stoneMat = new THREE.MeshStandardMaterial({ color: 0x8a847a, roughness: 1 });
  private arrowMat = new THREE.MeshBasicMaterial({ color: 0x2a2018 });
  private puffMat = new THREE.MeshStandardMaterial({ color: 0xb8ad98, transparent: true, opacity: 0.6, depthWrite: false });

  constructor(private game: Game, private terrain: TerrainView) {}

  update(dt: number) {
    const sg = this.game.state.siege;
    const key = sg ? `${sg.startDay}:${Math.floor(sg.ladders / 4)}:${Math.floor(sg.mangonels)}:${sg.troops.trebuchets}:${sg.camp}` : '';
    if (key !== this.campKey) {
      this.campKey = key;
      if (this.camp) {
        this.group.remove(this.camp);
        this.camp.traverse((o) => {
          if (o instanceof THREE.Mesh) o.geometry.dispose();
        });
        this.camp = null;
      }
      if (sg) {
        this.camp = this.buildCamp(sg.camp, Math.floor(sg.ladders), Math.floor(sg.mangonels), sg.troops.trebuchets);
        this.group.add(this.camp);
      }
    }
    if (sg) {
      // Bombardamento: un sasso ogni tanto per macchina, verso il tratto preso di mira
      const engines = Math.floor(sg.mangonels) + sg.troops.trebuchets;
      const target = sg.target !== undefined ? this.game.byUid(sg.target) : undefined;
      if (sg.phase === 'bombard' && engines > 0 && target) {
        this.fireTimer -= dt;
        if (this.fireTimer <= 0) {
          this.fireTimer = 2.4 / Math.min(4, engines) + Math.random() * 0.6;
          const def = getBuilding(target.defId);
          const tx = target.x + def.size[0] / 2 + (Math.random() - 0.5) * 0.4;
          const tz = target.z + def.size[1] / 2 + (Math.random() - 0.5) * 0.4;
          const [cx, cz] = sg.camp;
          const fx = cx + 0.5 + (Math.random() - 0.5) * 2;
          const fz = cz + 0.5 + (Math.random() - 0.5) * 2;
          this.shoot(new THREE.Vector3(fx, this.terrain.heightAt(fx, fz) + 1.2, fz), new THREE.Vector3(tx, this.terrain.heightAt(tx, tz) + 0.8, tz), 1.6, false);
        }
      }
      // Assalto: nugoli di frecce in entrambe le direzioni
      if (this.lastAssaults >= 0 && sg.assaults > this.lastAssaults) this.volley(sg.camp);
      this.lastAssaults = sg.assaults;
    } else this.lastAssaults = -1;
    this.animate(dt);
  }

  /** Lancia un proiettile lungo un arco. */
  private shoot(from: THREE.Vector3, to: THREE.Vector3, dur: number, arrow: boolean) {
    const mesh = new THREE.Mesh(arrow ? arrowGeo : stoneGeo, arrow ? this.arrowMat : this.stoneMat);
    mesh.position.copy(from);
    this.group.add(mesh);
    this.shots.push({ mesh, from, to, t: 0, dur, arrow });
  }

  /** Frecce dalle mura verso il campo e dal campo verso le mura. */
  private volley(camp: [number, number]) {
    const [kx, kz] = this.game.keepCenter();
    const [cx, cz] = camp;
    for (let i = 0; i < 60; i++) {
      const out = i % 2 === 0;
      const a = new THREE.Vector3(kx + (cx - kx) * 0.45 + (Math.random() - 0.5) * 4, 0, kz + (cz - kz) * 0.45 + (Math.random() - 0.5) * 4);
      const b = new THREE.Vector3(cx + 0.5 + (Math.random() - 0.5) * 3, 0, cz + 0.5 + (Math.random() - 0.5) * 3);
      a.y = this.terrain.heightAt(a.x, a.z) + 1.4;
      b.y = this.terrain.heightAt(b.x, b.z) + 0.3;
      const from = out ? a : b;
      const to = out ? b : a;
      setTimeout(() => this.shoot(from, to, 0.9 + Math.random() * 0.4, true), Math.random() * 2500);
    }
  }

  private animate(dt: number) {
    for (const s of this.shots) {
      s.t += dt;
      const k = Math.min(1, s.t / s.dur);
      const p = s.mesh.position;
      p.lerpVectors(s.from, s.to, k);
      const h = s.from.distanceTo(s.to) * (s.arrow ? 0.18 : 0.35);
      p.y += Math.sin(k * Math.PI) * h;
      if (s.arrow) {
        // La freccia segue la traiettoria
        const dir = new THREE.Vector3().subVectors(s.to, s.from);
        s.mesh.rotation.y = Math.atan2(-dir.z, dir.x);
        s.mesh.rotation.z = Math.cos(k * Math.PI) * 0.7;
      } else s.mesh.rotation.x += dt * 6;
      if (k >= 1 && !s.arrow) this.puff(s.to);
    }
    const done = this.shots.filter((s) => s.t >= s.dur);
    for (const s of done) this.group.remove(s.mesh);
    this.shots = this.shots.filter((s) => s.t < s.dur);
    for (const p of this.puffs) {
      p.t += dt;
      const k = p.t / 1.6;
      p.mesh.scale.setScalar(0.6 + k * 2.4);
      p.mesh.position.y += dt * 0.25;
      (p.mesh.material as THREE.MeshStandardMaterial).opacity = Math.max(0, 0.6 * (1 - k));
    }
    for (const p of this.puffs.filter((x) => x.t >= 1.6)) {
      this.group.remove(p.mesh);
      (p.mesh.material as THREE.Material).dispose();
    }
    this.puffs = this.puffs.filter((x) => x.t < 1.6);
  }

  /** Nuvola di polvere e schegge dove cade il sasso. */
  private puff(at: THREE.Vector3) {
    const mesh = new THREE.Mesh(puffGeo, this.puffMat.clone());
    mesh.position.copy(at);
    this.group.add(mesh);
    this.puffs.push({ mesh, t: 0 });
  }

  private buildCamp(at: [number, number], ladders: number, mangonels: number, trebuchets: number): THREE.Group {
    const k = mats();
    const g = new THREE.Group();
    const [cx, cz] = this.game.keepCenter();
    const toward = Math.atan2(-(cz - at[1]), cx - at[0]);
    // Tende in cerchio attorno ai fuochi
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      const r = 1.6 + (i % 2) * 0.5;
      const tent = cone(0.32, 0.5, k.cloth[i % k.cloth.length], Math.cos(a) * r, 0, Math.sin(a) * r, 6);
      g.add(tent);
      g.add(cyl(0.012, 0.012, 0.62, k.beam, Math.cos(a) * r, 0, Math.sin(a) * r, 4));
    }
    g.add(cyl(0.18, 0.2, 0.05, k.stoneDark, 0, 0, 0, 8));
    g.add(box(0.12, 0.08, 0.12, k.fire, 0, 0.04, 0));
    g.add(smoke(0, 0.15, 0, 4, 0.8));
    g.add(flag(k.flagBlue, 0.4, 0.9, 0.3, 0.3));
    g.add(cyl(0.02, 0.02, 0.95, k.beam, 0.4, 0, 0.3, 4));
    // Scale accatastate
    for (let i = 0; i < Math.min(8, Math.ceil(ladders / 4)); i++) {
      const l = new THREE.Group();
      for (const s of [-0.07, 0.07]) l.add(box(0.02, 0.02, 0.9, k.planks, s, 0, 0));
      for (let j = 0; j < 6; j++) l.add(box(0.14, 0.015, 0.015, k.planks, 0, 0.01, -0.38 + j * 0.15));
      l.position.set(-1.1 + i * 0.05, 0.02 + i * 0.03, -0.6);
      l.rotation.y = 0.2;
      g.add(l);
    }
    // Macchine d'assedio rivolte verso il castello
    const engines = Math.min(6, mangonels + trebuchets);
    for (let i = 0; i < engines; i++) {
      const big = i < trebuchets;
      const e = big ? trebuchet() : mangonel();
      const side = (i - (engines - 1) / 2) * 0.9;
      e.position.set(Math.cos(toward) * 2.6 - Math.sin(toward) * side, 0, -Math.sin(toward) * 2.6 - Math.cos(toward) * side);
      e.rotation.y = toward;
      g.add(e);
    }
    const out = bake(g);
    out.position.set(at[0] + 0.5, this.terrain.heightAt(at[0] + 0.5, at[1] + 0.5), at[1] + 0.5);
    return out;
  }
}

/** Mangano: telaio basso e braccio a molla con il cucchiaio. */
function mangonel(): THREE.Group {
  const k = mats();
  const g = new THREE.Group();
  for (const s of [-0.12, 0.12]) g.add(box(0.6, 0.06, 0.05, k.darkPlanks, 0, 0.05, s));
  g.add(box(0.06, 0.25, 0.28, k.planks, 0.05, 0.05, 0));
  const arm = box(0.55, 0.04, 0.04, k.log, 0, 0, 0);
  arm.geometry.translate(0.27, 0, 0);
  arm.position.set(0.05, 0.3, 0);
  arm.rotation.z = 2.4;
  g.add(arm);
  g.add(sphere(0.05, k.darkPlanks, -0.3, 0.62, 0, 0));
  for (const [x, z] of [[-0.25, -0.15], [0.25, -0.15], [-0.25, 0.15], [0.25, 0.15]]) {
    const w = cyl(0.07, 0.07, 0.03, k.planks, x, 0.07, z, 8);
    w.rotation.x = Math.PI / 2;
    g.add(w);
  }
  return g;
}

/** Trabucco a contrappeso: cavalletto alto, braccio lungo, cassa di pietre. */
function trebuchet(): THREE.Group {
  const k = mats();
  const g = new THREE.Group();
  for (const s of [-0.2, 0.2]) {
    g.add(box(0.9, 0.06, 0.06, k.darkPlanks, 0, 0.03, s));
    const a = box(0.06, 1.0, 0.06, k.log, -0.2, 0, s);
    a.rotation.z = -0.35;
    g.add(a);
    const b = box(0.06, 1.0, 0.06, k.log, 0.2, 0, s);
    b.rotation.z = 0.35;
    g.add(b);
  }
  g.add(box(0.05, 0.05, 0.5, k.beam, 0, 0.92, 0));
  const arm = box(1.5, 0.05, 0.05, k.log, 0, 0, 0);
  arm.geometry.translate(0.3, 0, 0);
  arm.position.set(0, 0.95, 0);
  arm.rotation.z = -0.6;
  g.add(arm);
  g.add(box(0.22, 0.22, 0.22, k.planks, -0.38, 0.6, 0));
  return g;
}
