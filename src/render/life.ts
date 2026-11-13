import * as THREE from 'three';
import { getBuilding } from '../game/data/buildings';
import type { Game } from '../game/sim/game';
import { mats } from './kit';
import type { TerrainView } from './terrain';

/**
 * Vita nel castello: contadini e artigiani che vanno e vengono tra case, campi e botteghe.
 * Di notte escono con una torcia e vanno dove si fa festa: locanda, piazza, casa di piacere, mercato.
 * Poche mesh istanziate (corpi, teste, manici e fiamme delle torce): costano pochissimo.
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
const HOME_CATS = new Set(['housing', 'farming', 'animals', 'gathering', 'industry', 'trade', 'civic']);
/** Dove si va la sera, e quanto ci si trattiene. */
const NIGHT_PLACES: Record<string, number> = { tavern: 3, brothel: 2, square: 2, market: 1 };

export class LifeView {
  readonly group = new THREE.Group();
  private bodies: THREE.InstancedMesh;
  private heads: THREE.InstancedMesh;
  private sticks: THREE.InstancedMesh;
  private flames: THREE.InstancedMesh;
  private walkers: Walker[] = [];
  /** Mete di giorno (case, campi, botteghe) e di notte (locali), con il loro richiamo. */
  private spots: Array<[number, number]> = [];
  private nightSpots: Array<[number, number, number]> = [];
  private spotTimer = 0;
  private rand: () => number;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3(1.6, 1.6, 1.6);
  private up = new THREE.Vector3(0, 1, 0);
  /** Posizione della torcia rispetto al corpo: nella mano destra, alzata. */
  private torchOffset = new THREE.Vector3(0.075, 0, 0.02);
  private tmp = new THREE.Vector3();

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
    const stick = new THREE.CylinderGeometry(0.008, 0.008, 0.14, 4).translate(0, 0.17, 0);
    const flame = new THREE.OctahedronGeometry(0.025, 0).scale(1, 1.5, 1).translate(0, 0.26, 0);
    this.bodies = new THREE.InstancedMesh(body, new THREE.MeshStandardMaterial({ roughness: 1 }), MAX);
    this.heads = new THREE.InstancedMesh(head, new THREE.MeshStandardMaterial({ color: 0xe0b890, roughness: 0.9 }), MAX);
    this.sticks = new THREE.InstancedMesh(stick, mats().beam, MAX);
    // La fiamma usa il materiale del fuoco: di notte la scena ne aumenta il bagliore
    this.flames = new THREE.InstancedMesh(flame, mats().fire, MAX);
    const tunics = [0x8a3a2a, 0x3a5f8a, 0x6a7a3a, 0x8a6a3a, 0x5a4a7a, 0xb0a080].map((c) => new THREE.Color(c));
    for (let i = 0; i < MAX; i++) this.bodies.setColorAt(i, tunics[i % tunics.length]);
    for (const im of [this.bodies, this.heads, this.sticks, this.flames]) {
      im.count = 0;
      im.frustumCulled = false;
      im.castShadow = false;
    }
    this.group.add(this.bodies, this.heads, this.sticks, this.flames);
  }

  /** Luoghi dove si va: case, campi e botteghe di giorno; locande, piazze e locali di notte. */
  private refreshSpots() {
    this.spots = [];
    this.nightSpots = [];
    for (const b of this.game.state.buildings) {
      const def = getBuilding(b.defId);
      if (!HOME_CATS.has(def.category) || def.fort || def.road) continue;
      const [w, d] = def.size;
      // La piazza si attraversa: ci si ferma al centro; gli altri davanti alla porta
      const spot: [number, number] = def.id === 'square' ? [b.x + w / 2, b.z + d / 2 + 0.6] : [b.x + w / 2, b.z + d + 0.3];
      this.spots.push(spot);
      const pull = NIGHT_PLACES[def.id];
      if (pull) this.nightSpots.push([spot[0], spot[1], pull]);
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
      if (!d.road && d.category !== 'farming' && d.id !== 'square') return false;
    }
    return true;
  }

  /** Una meta: di notte di preferenza un locale (pesato per richiamo), altrimenti un posto qualsiasi. */
  private pickTarget(w: Walker, night: boolean): [number, number] | null {
    if (night && this.nightSpots.length && this.rand() < 0.75) {
      const tot = this.nightSpots.reduce((s, x) => s + x[2], 0);
      for (let tries = 0; tries < 4; tries++) {
        let r = this.rand() * tot;
        const s = this.nightSpots.find((x) => (r -= x[2]) < 0) ?? this.nightSpots[0];
        if (Math.hypot(s[0] - w.x, s[1] - w.z) > 20 || !this.clear(w.x, w.z, s[0], s[1])) continue;
        return [s[0], s[1]];
      }
    }
    for (let tries = 0; tries < 4; tries++) {
      const s = this.spots[Math.floor(this.rand() * this.spots.length)];
      if (Math.hypot(s[0] - w.x, s[1] - w.z) > 12 || !this.clear(w.x, w.z, s[0], s[1])) continue;
      return s;
    }
    return null;
  }

  update(dt: number, night: number, camX: number, camZ: number) {
    this.spotTimer -= dt;
    if (this.spotTimer <= 0) {
      this.spotTimer = 4;
      this.refreshSpots();
    }
    const dark = night > 0.5;
    // Di notte esce meno gente, ma chi esce va a far baldoria (se ci sono locali, un po' di più)
    const share = dark ? (this.nightSpots.length ? 0.7 : 0.35) : 1;
    const want = !this.spots.length ? 0 : Math.min(MAX, Math.round((this.game.state.population / 2.5) * share));
    while (this.walkers.length < want) {
      const s = this.spots[Math.floor(this.rand() * this.spots.length)];
      this.walkers.push({ x: s[0], z: s[1], tx: s[0], tz: s[1], wait: this.rand() * 4, speed: 0.35 + this.rand() * 0.25, phase: this.rand() * 6 });
    }
    if (this.walkers.length > want) this.walkers.length = want;
    const torches = night > 0.3;
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
          const t = this.pickTarget(w, dark);
          if (t) {
            // Attorno alla meta ci si sparpaglia un po' (in piazza di più)
            w.tx = t[0] + (this.rand() - 0.5) * 0.8;
            w.tz = t[1] + (this.rand() - 0.5) * 0.5;
          }
          // Davanti alla locanda ci si trattiene a chiacchierare
          w.wait = dark ? 4 + this.rand() * 9 : 2 + this.rand() * 6;
        }
      } else {
        const st = Math.min(dist, w.speed * dt);
        w.x += (dx / dist) * st;
        w.z += (dz / dist) * st;
        w.phase += dt * 9;
      }
      const bob = dist >= 0.08 ? Math.abs(Math.sin(w.phase)) * 0.015 : 0;
      this.p.set(w.x, this.terrain.heightAt(w.x, w.z) + bob, w.z);
      if (dist >= 0.08) this.q.setFromAxisAngle(this.up, Math.atan2(dx, dz));
      this.m.compose(this.p, this.q, this.s);
      this.bodies.setMatrixAt(shown, this.m);
      this.heads.setMatrixAt(shown, this.m);
      if (torches) {
        // La torcia nella mano destra; la fiamma tremola un poco
        this.p.add(this.tmp.copy(this.torchOffset).multiplyScalar(this.s.x).applyQuaternion(this.q));
        this.p.y += Math.sin(w.phase * 1.7 + shown) * 0.003;
        this.m.compose(this.p, this.q, this.s);
        this.sticks.setMatrixAt(shown, this.m);
        this.flames.setMatrixAt(shown, this.m);
      }
      shown++;
    }
    this.bodies.count = this.heads.count = shown;
    this.sticks.count = this.flames.count = torches ? shown : 0;
    for (const im of [this.bodies, this.heads, this.sticks, this.flames]) im.instanceMatrix.needsUpdate = true;
  }
}
