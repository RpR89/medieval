import * as THREE from 'three';
import { getBuilding } from '../game/data/buildings';
import type { Game } from '../game/sim/game';
import type { TerrainView } from './terrain';

/**
 * Vita nel castello: contadini e artigiani che vanno e vengono tra case, campi e botteghe.
 * Due sole mesh istanziate (corpi e teste): costano pochissimo. Nel cuore della notte (pieno inverno) restano in casa.
 */
interface Walker {
  x: number;
  z: number;
  tx: number;
  tz: number;
  wait: number;
  speed: number;
  phase: number;
}

const MAX = 40;
const HOME_CATS = new Set(['housing', 'farming', 'animals', 'gathering', 'industry', 'trade']);

export class LifeView {
  readonly group = new THREE.Group();
  private bodies: THREE.InstancedMesh;
  private heads: THREE.InstancedMesh;
  private walkers: Walker[] = [];
  private spots: Array<[number, number]> = [];
  private spotTimer = 0;
  private rand: () => number;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3(1.6, 1.6, 1.6);
  private up = new THREE.Vector3(0, 1, 0);

  constructor(private game: Game, private terrain: TerrainView) {
    let a = game.state.seed >>> 0;
    this.rand = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), a | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const body = new THREE.CylinderGeometry(0.035, 0.05, 0.16, 5).translate(0, 0.08, 0);
    const head = new THREE.IcosahedronGeometry(0.036, 0).translate(0, 0.19, 0);
    this.bodies = new THREE.InstancedMesh(body, new THREE.MeshStandardMaterial({ roughness: 1 }), MAX);
    this.heads = new THREE.InstancedMesh(head, new THREE.MeshStandardMaterial({ color: 0xe0b890, roughness: 0.9 }), MAX);
    const tunics = [0x8a3a2a, 0x3a5f8a, 0x6a7a3a, 0x8a6a3a, 0x5a4a7a, 0xb0a080].map((c) => new THREE.Color(c));
    for (let i = 0; i < MAX; i++) this.bodies.setColorAt(i, tunics[i % tunics.length]);
    for (const im of [this.bodies, this.heads]) {
      im.count = 0;
      im.frustumCulled = false;
      im.castShadow = false;
    }
    this.group.add(this.bodies, this.heads);
  }

  /** Luoghi dove si va: vicino alle case, ai campi e alle botteghe del castello. */
  private refreshSpots() {
    this.spots = [];
    for (const b of this.game.state.buildings) {
      const def = getBuilding(b.defId);
      if (!HOME_CATS.has(def.category) || def.fort || def.road) continue;
      const [w, d] = def.size;
      this.spots.push([b.x + w / 2, b.z + d + 0.3]);
    }
  }

  /** Il tragitto è libero (niente mura né edifici in mezzo)? */
  private clear(x0: number, z0: number, x1: number, z1: number): boolean {
    const n = Math.max(2, Math.ceil(Math.hypot(x1 - x0, z1 - z0) * 2));
    for (let i = 1; i < n; i++) {
      const x = x0 + ((x1 - x0) * i) / n;
      const z = z0 + ((z1 - z0) * i) / n;
      const b = this.game.buildingAt(Math.floor(x), Math.floor(z));
      if (!b) continue;
      const d = getBuilding(b.defId);
      if (!d.road && d.category !== 'farming') return false;
    }
    return true;
  }

  update(dt: number, night: number, camX: number, camZ: number) {
    this.spotTimer -= dt;
    if (this.spotTimer <= 0) {
      this.spotTimer = 4;
      this.refreshSpots();
    }
    const want = night > 0.9 || !this.spots.length ? 0 : Math.min(MAX, Math.round(this.game.state.population / 2.5));
    while (this.walkers.length < want) {
      const s = this.spots[Math.floor(this.rand() * this.spots.length)];
      this.walkers.push({ x: s[0], z: s[1], tx: s[0], tz: s[1], wait: this.rand() * 4, speed: 0.35 + this.rand() * 0.25, phase: this.rand() * 6 });
    }
    if (this.walkers.length > want) this.walkers.length = want;
    let shown = 0;
    for (const w of this.walkers) {
      // Fuori dall'inquadratura non si anima nemmeno
      if (Math.abs(w.x - camX) > 55 || Math.abs(w.z - camZ) > 55) continue;
      const dx = w.tx - w.x;
      const dz = w.tz - w.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.08) {
        w.wait -= dt;
        if (w.wait <= 0 && this.spots.length) {
          // Nuova meta tra quelle vicine e raggiungibili in linea retta
          for (let tries = 0; tries < 4; tries++) {
            const s = this.spots[Math.floor(this.rand() * this.spots.length)];
            if (Math.hypot(s[0] - w.x, s[1] - w.z) > 12) continue;
            if (!this.clear(w.x, w.z, s[0], s[1])) continue;
            w.tx = s[0] + (this.rand() - 0.5) * 0.5;
            w.tz = s[1] + (this.rand() - 0.5) * 0.3;
            break;
          }
          w.wait = 2 + this.rand() * 6;
        }
      } else {
        const st = Math.min(dist, w.speed * dt);
        w.x += (dx / dist) * st;
        w.z += (dz / dist) * st;
        w.phase += dt * 9;
      }
      const bob = dist >= 0.08 ? Math.abs(Math.sin(w.phase)) * 0.015 : 0;
      this.p.set(w.x, this.terrain.heightAt(w.x, w.z) + bob, w.z);
      this.q.setFromAxisAngle(this.up, Math.atan2(dx, dz));
      this.m.compose(this.p, this.q, this.s);
      this.bodies.setMatrixAt(shown, this.m);
      this.heads.setMatrixAt(shown, this.m);
      shown++;
    }
    this.bodies.count = this.heads.count = shown;
    this.bodies.instanceMatrix.needsUpdate = true;
    this.heads.instanceMatrix.needsUpdate = true;
    if (this.bodies.instanceColor) this.bodies.instanceColor.needsUpdate = true;
  }
}
