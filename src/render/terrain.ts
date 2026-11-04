import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Season } from '../game/data/calendar';
import { mulberry32, Tile, tileAt, type Terrain } from '../game/world/terrain';
import { textures } from './textures';
import { addCloudShadows, addSnow, addWind } from './effects';

/** Vertici per lato di ogni casella. */
const RES = 4;
export const WATER_LEVEL = -0.18;

const TARGET: Record<Tile, number> = {
  [Tile.Grass]: 0.02,
  [Tile.Forest]: 0.1,
  [Tile.Rock]: 0.38,
  [Tile.Gold]: 0.38,
  [Tile.River]: -0.55,
  [Tile.Sea]: -0.95,
  [Tile.Sand]: -0.05,
};

type Rgb = [number, number, number];
const hex = (h: number): Rgb => {
  const c = new THREE.Color(h);
  return [c.r, c.g, c.b];
};

const PALETTE: Record<Season, { grass: Rgb; forest: Rgb; rock: Rgb; sand: Rgb; bed: Rgb; earth: Rgb }> = {
  spring: { grass: hex(0x6a9e3c), forest: hex(0x4b6b2a), rock: hex(0x8d877e), sand: hex(0xd6c28c), bed: hex(0x5d6a4a), earth: hex(0x7c6444) },
  summer: { grass: hex(0x7c9b3a), forest: hex(0x4e6328), rock: hex(0x918a7f), sand: hex(0xdcc690), bed: hex(0x5d6a4a), earth: hex(0x82694a) },
  autumn: { grass: hex(0x93903f), forest: hex(0x6e5a2c), rock: hex(0x8a8279), sand: hex(0xd2be88), bed: hex(0x5d6a4a), earth: hex(0x765c3e) },
  winter: { grass: hex(0xe8eef2), forest: hex(0xd8e0e4), rock: hex(0xb8bcc0), sand: hex(0xd8d8d0), bed: hex(0x4d5a4a), earth: hex(0xcfd2d0) },
};

const FOLIAGE: Record<Season, number> = { spring: 0x6fa83e, summer: 0x4a8030, autumn: 0xc0702a, winter: 0x6a5a48 };
const CONIFER: Record<Season, number> = { spring: 0x3f6e34, summer: 0x355f2e, autumn: 0x3a5e30, winter: 0x7d9488 };
const GRASS_TUFT: Record<Season, number> = { spring: 0x7bb04a, summer: 0x8aa84a, autumn: 0xa89a50, winter: 0xe0e6e8 };

export interface Footprint {
  x: number;
  z: number;
  w: number;
  d: number;
  defId: string;
}

/** Edifici che hanno un terreno proprio (non serve colorare la terra battuta). */
const OWN_GROUND = new Set(['field_grain', 'field_vegetables', 'hay_meadow', 'pasture_cattle', 'pasture_pigs', 'pasture_goats', 'moat']);

interface Decor {
  mesh: THREE.InstancedMesh;
  index: number;
  matrix: THREE.Matrix4;
}

const ni = (g: THREE.BufferGeometry) => (g.index ? g.toNonIndexed() : g);

export class TerrainView {
  readonly group = new THREE.Group();
  private size: number;
  private n: number;
  private base: Float32Array;
  private heights: Float32Array;
  private mesh: THREE.Mesh;
  private geo: THREE.PlaneGeometry;
  private season: Season = 'summer';
  private footprints: Footprint[] = [];
  private earthMask: Float32Array;
  private noise: Float32Array;
  private decorByTile = new Map<number, Decor[]>();
  private hidden = new Set<number>();
  private grass: THREE.InstancedMesh;
  private flowers: THREE.InstancedMesh;
  private leafMat: THREE.MeshStandardMaterial;
  private coniferMat: THREE.MeshStandardMaterial;
  private grassMat: THREE.MeshStandardMaterial;
  private leaves: THREE.InstancedMesh;
  private skirtMat: THREE.MeshStandardMaterial;

  /** Altezze in una texture (per l'acqua): h = v * H_RANGE + H_MIN. */
  readonly heightTexture: THREE.DataTexture;
  static readonly H_MIN = -1.2;
  static readonly H_RANGE = 2.0;

  constructor(private terrain: Terrain, private tuftsPerTile = 6) {
    this.size = terrain.size;
    this.n = this.size * RES + 1;
    const rand = mulberry32(terrain.seed + 1234);
    this.noise = new Float32Array(this.n * this.n).map(() => rand());
    this.base = this.computeBase();
    this.heights = this.base.slice();
    this.earthMask = new Float32Array(this.n * this.n);
    this.heightTexture = new THREE.DataTexture(new Uint8Array(this.n * this.n * 4), this.n, this.n);
    this.heightTexture.magFilter = THREE.LinearFilter;
    this.heightTexture.minFilter = THREE.LinearFilter;

    this.geo = new THREE.PlaneGeometry(this.size, this.size, this.size * RES, this.size * RES);
    this.geo.rotateX(-Math.PI / 2);
    this.geo.translate(this.size / 2, 0, this.size / 2);
    // UV in coordinate di mondo: la texture di dettaglio si ripete ogni casella
    const pos = this.geo.getAttribute('position') as THREE.BufferAttribute;
    const uv = this.geo.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) * 0.5, pos.getZ(i) * 0.5);
    this.geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pos.count * 3), 3));
    const ground = textures().ground;
    this.mesh = new THREE.Mesh(
      this.geo,
      new THREE.MeshStandardMaterial({ vertexColors: true, map: ground, roughness: 1, metalness: 0 }),
    );
    this.mesh.receiveShadow = true;
    addCloudShadows(this.mesh.material as THREE.Material);
    this.group.add(this.mesh);

    // Terra oltre i bordi (a est c'è il mare aperto)
    this.skirtMat = new THREE.MeshStandardMaterial({ color: 0x6a9e3c, roughness: 1, map: ground });
    addCloudShadows(this.skirtMat);
    const s = this.size;
    const far = 220;
    for (const [w, d, x, z] of [
      [far, s + far * 2, -far / 2, s / 2],
      [s, far, s / 2, -far / 2],
      [s, far, s / 2, s + far / 2],
    ]) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(w, d), this.skirtMat);
      p.rotation.x = -Math.PI / 2;
      p.position.set(x, 0.0, z);
      p.receiveShadow = true;
      this.group.add(p);
    }
    const seabed = new THREE.Mesh(new THREE.PlaneGeometry(far * 2, s + far * 2), new THREE.MeshStandardMaterial({ color: 0x3e5a52 }));
    seabed.rotation.x = -Math.PI / 2;
    seabed.position.set(s + far, -1.2, s / 2);
    this.group.add(seabed);

    // ───── Vegetazione ─────
    this.leafMat = new THREE.MeshStandardMaterial({ color: FOLIAGE.summer, roughness: 0.85, flatShading: true });
    this.coniferMat = new THREE.MeshStandardMaterial({ color: CONIFER.summer, roughness: 0.85, flatShading: true });
    this.grassMat = new THREE.MeshStandardMaterial({ color: GRASS_TUFT.summer, roughness: 1, side: THREE.DoubleSide });
    addWind(this.leafMat, 0.045, 1.3);
    addWind(this.coniferMat, 0.03, 1.5);
    addSnow(this.coniferMat, 0.85);
    addWind(this.grassMat, 0.035, 0.16);
    const v = this.buildVegetation();
    this.leaves = v.leaves;
    this.grass = v.grass;
    this.flowers = v.flowers;

    this.applyHeights();
    this.paint();
  }

  // ───────────── Altezze ─────────────

  private target(x: number, z: number): number {
    const t = tileAt(this.terrain, Math.min(this.size - 1, Math.max(0, x)), Math.min(this.size - 1, Math.max(0, z)));
    // Oltre il bordo est c'è il mare
    if (x >= this.size) return TARGET[Tile.Sea];
    return TARGET[t ?? Tile.Grass];
  }

  private computeBase(): Float32Array {
    const h = new Float32Array(this.n * this.n);
    const rockAt = (x: number, z: number) => {
      const t = tileAt(this.terrain, x, z);
      return t === Tile.Rock || t === Tile.Gold ? 1 : 0;
    };
    for (let j = 0; j < this.n; j++) {
      for (let i = 0; i < this.n; i++) {
        const wx = i / RES - 0.5;
        const wz = j / RES - 0.5;
        const x0 = Math.floor(wx);
        const z0 = Math.floor(wz);
        const fx = wx - x0;
        const fz = wz - z0;
        const sx = fx * fx * (3 - 2 * fx);
        const sz = fz * fz * (3 - 2 * fz);
        const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
        const v =
          lerp(lerp(this.target(x0, z0), this.target(x0 + 1, z0), sx), lerp(this.target(x0, z0 + 1), this.target(x0 + 1, z0 + 1), sx), sz);
        const rock = lerp(lerp(rockAt(x0, z0), rockAt(x0 + 1, z0), sx), lerp(rockAt(x0, z0 + 1), rockAt(x0 + 1, z0 + 1), sx), sz);
        const nz = this.noise[j * this.n + i];
        const low = Math.sin(i * 0.07 + j * 0.05) * Math.cos(j * 0.06 - i * 0.03) * 0.04;
        h[j * this.n + i] = v + low + (nz - 0.5) * (0.025 + rock * 0.35) + rock * 0.12;
      }
    }
    return h;
  }

  /** Altezza del terreno (attuale) in un punto del mondo. */
  heightAt(x: number, z: number): number {
    const fi = Math.max(0, Math.min(this.n - 1.001, x * RES));
    const fj = Math.max(0, Math.min(this.n - 1.001, z * RES));
    const i = Math.floor(fi);
    const j = Math.floor(fj);
    const tx = fi - i;
    const tz = fj - j;
    const h = this.heights;
    const a = h[j * this.n + i] * (1 - tx) + h[j * this.n + i + 1] * tx;
    const b = h[(j + 1) * this.n + i] * (1 - tx) + h[(j + 1) * this.n + i + 1] * tx;
    return a * (1 - tz) + b * tz;
  }

  private baseAt(x: number, z: number): number {
    const i = Math.round(Math.max(0, Math.min(this.n - 1, x * RES)));
    const j = Math.round(Math.max(0, Math.min(this.n - 1, z * RES)));
    return this.base[j * this.n + i];
  }

  private applyHeights() {
    const pos = this.geo.getAttribute('position') as THREE.BufferAttribute;
    // PlaneGeometry ruotata: i vertici sono ordinati per righe lungo z
    for (let j = 0; j < this.n; j++) {
      for (let i = 0; i < this.n; i++) pos.setY(j * this.n + i, this.heights[j * this.n + i]);
    }
    pos.needsUpdate = true;
    this.geo.computeVertexNormals();
    this.geo.computeBoundingSphere();
    const data = this.heightTexture.image.data as Uint8Array;
    for (let k = 0; k < this.n * this.n; k++) {
      const v = (this.heights[k] - TerrainView.H_MIN) / TerrainView.H_RANGE;
      data[k * 4] = Math.max(0, Math.min(255, Math.round(v * 255)));
      data[k * 4 + 3] = 255;
    }
    this.heightTexture.needsUpdate = true;
  }

  /** Vertici per casella e per lato (per gli shader). */
  get grid() {
    return { res: RES, n: this.n };
  }

  /** Spiana il terreno sotto gli edifici e scava i fossati. */
  setFootprints(fps: Footprint[]) {
    this.footprints = fps;
    const H = this.base.slice();
    const inside = new Uint8Array(this.n * this.n);
    this.earthMask.fill(0);
    const ordered = [...fps].sort((a, b) => (a.defId === 'moat' ? -1 : 0) - (b.defId === 'moat' ? -1 : 0));
    // 1) dentro l'ingombro: quota fissa
    for (const f of ordered) {
      const lvl = f.defId === 'moat' ? -0.5 : 0;
      const i0 = Math.ceil(f.x * RES);
      const i1 = Math.floor((f.x + f.w) * RES);
      const j0 = Math.ceil(f.z * RES);
      const j1 = Math.floor((f.z + f.d) * RES);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          if (i < 0 || j < 0 || i >= this.n || j >= this.n) continue;
          const k = j * this.n + i;
          // I fossati sono processati per primi: sui vertici condivisi vince l'edificio
          H[k] = lvl;
          inside[k] = 1;
          if (!OWN_GROUND.has(f.defId)) this.earthMask[k] = 1;
        }
      }
    }
    // 2) raccordo morbido attorno agli ingombri
    for (const f of ordered) {
      const lvl = f.defId === 'moat' ? -0.5 : 0;
      const m = f.defId === 'moat' ? 0.3 : 0.6;
      const i0 = Math.floor((f.x - m) * RES);
      const i1 = Math.ceil((f.x + f.w + m) * RES);
      const j0 = Math.floor((f.z - m) * RES);
      const j1 = Math.ceil((f.z + f.d + m) * RES);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          if (i < 0 || j < 0 || i >= this.n || j >= this.n) continue;
          const k = j * this.n + i;
          if (inside[k]) continue;
          const wx = i / RES;
          const wz = j / RES;
          const dist = Math.max(f.x - wx, wx - (f.x + f.w), f.z - wz, wz - (f.z + f.d), 0);
          if (dist >= m) continue;
          const t = dist / m;
          const s = t * t * (3 - 2 * t);
          H[k] = lvl + (H[k] - lvl) * s;
          if (!OWN_GROUND.has(f.defId)) this.earthMask[k] = Math.max(this.earthMask[k], (1 - s) * 0.7);
        }
      }
    }
    this.heights = H;
    this.applyHeights();
    this.paint();
    this.updateDecorVisibility();
  }

  // ───────────── Colori ─────────────

  setSeason(season: Season) {
    this.season = season;
    this.paint();
    this.leafMat.color.setHex(FOLIAGE[season]);
    this.leaves.visible = season !== 'winter';
    this.coniferMat.color.setHex(CONIFER[season]);
    this.grassMat.color.setHex(GRASS_TUFT[season]);
    this.flowers.visible = this.detailOn && (season === 'spring' || season === 'summer');
    this.grass.visible = this.detailOn && season !== 'winter';
    this.skirtMat.color.setRGB(...PALETTE[season].grass);
  }

  private paint() {
    const p = PALETTE[this.season];
    const col = this.geo.getAttribute('color') as THREE.BufferAttribute;
    const tileCol = (x: number, z: number): Rgb => {
      if (x >= this.size) return p.bed;
      const t = tileAt(this.terrain, Math.min(this.size - 1, Math.max(0, x)), Math.min(this.size - 1, Math.max(0, z)));
      switch (t) {
        case Tile.Forest: return p.forest;
        case Tile.Rock: return p.rock;
        case Tile.Gold: return [p.rock[0] * 1.05 + 0.06, p.rock[1] * 1.0 + 0.04, p.rock[2] * 0.8];
        case Tile.Sand: return p.sand;
        case Tile.River:
        case Tile.Sea: return p.bed;
        default: return p.grass;
      }
    };
    const out: Rgb = [0, 0, 0];
    for (let j = 0; j < this.n; j++) {
      for (let i = 0; i < this.n; i++) {
        const k = j * this.n + i;
        const wx = i / RES - 0.5;
        const wz = j / RES - 0.5;
        const x0 = Math.floor(wx);
        const z0 = Math.floor(wz);
        const fx = wx - x0;
        const fz = wz - z0;
        const c00 = tileCol(x0, z0);
        const c10 = tileCol(x0 + 1, z0);
        const c01 = tileCol(x0, z0 + 1);
        const c11 = tileCol(x0 + 1, z0 + 1);
        for (let c = 0; c < 3; c++) {
          out[c] = (c00[c] * (1 - fx) + c10[c] * fx) * (1 - fz) + (c01[c] * (1 - fx) + c11[c] * fx) * fz;
        }
        const h = this.heights[k];
        // Rive bagnate e fondale
        if (h < WATER_LEVEL + 0.06) {
          const t = Math.min(1, (WATER_LEVEL + 0.06 - h) / 0.25);
          for (let c = 0; c < 3; c++) out[c] = out[c] * (1 - t) + p.bed[c] * t;
          if (h > WATER_LEVEL - 0.1) for (let c = 0; c < 3; c++) out[c] *= 0.85;
        }
        // Terra battuta attorno agli edifici
        const e = this.earthMask[k];
        if (e > 0) for (let c = 0; c < 3; c++) out[c] = out[c] * (1 - e) + p.earth[c] * e;
        const v = 0.9 + this.noise[k] * 0.18;
        col.setXYZ(k, out[0] * v, out[1] * v, out[2] * v);
      }
    }
    col.needsUpdate = true;
  }

  // ───────────── Vegetazione ─────────────

  private detailOn = true;

  setDetail(on: boolean) {
    this.detailOn = on;
    this.grass.visible = on && this.season !== 'winter';
    this.flowers.visible = on && (this.season === 'spring' || this.season === 'summer');
  }

  private register(tile: number, mesh: THREE.InstancedMesh, index: number, matrix: THREE.Matrix4) {
    if (!this.decorByTile.has(tile)) this.decorByTile.set(tile, []);
    this.decorByTile.get(tile)!.push({ mesh, index, matrix: matrix.clone() });
  }

  private buildVegetation() {
    const t = this.terrain;
    const rand = mulberry32(t.seed + 99);
    const bark = new THREE.MeshStandardMaterial({ color: 0x5a3e26, roughness: 1 });

    // Geometrie prototipo
    const conGeo = mergeGeometries([
      new THREE.ConeGeometry(0.42, 0.7, 7).translate(0, 0.65, 0),
      new THREE.ConeGeometry(0.34, 0.6, 7).translate(0, 1.0, 0),
      new THREE.ConeGeometry(0.24, 0.5, 7).translate(0, 1.32, 0),
    ].map(ni))!;
    const trunkGeo = new THREE.CylinderGeometry(0.05, 0.08, 0.6, 6).translate(0, 0.3, 0);
    const branchGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.05, 0.08, 0.75, 6).translate(0, 0.37, 0).toNonIndexed(),
      new THREE.CylinderGeometry(0.02, 0.035, 0.45, 5).rotateZ(0.7).translate(-0.14, 0.82, 0).toNonIndexed(),
      new THREE.CylinderGeometry(0.02, 0.035, 0.4, 5).rotateZ(-0.6).translate(0.12, 0.85, 0.03).toNonIndexed(),
      new THREE.CylinderGeometry(0.02, 0.03, 0.35, 5).rotateX(0.6).translate(0, 0.9, 0.1).toNonIndexed(),
    ])!;
    // Chioma a "nuvole" di icosaedri semplici: tante forme, pochi triangoli
    const leafGeo = mergeGeometries([
      new THREE.IcosahedronGeometry(0.36, 0).translate(0, 1.05, 0),
      new THREE.IcosahedronGeometry(0.28, 0).translate(-0.22, 0.9, 0.08),
      new THREE.IcosahedronGeometry(0.27, 0).translate(0.2, 0.95, -0.1),
      new THREE.IcosahedronGeometry(0.24, 0).rotateY(0.5).translate(0.04, 1.34, 0.05),
      new THREE.IcosahedronGeometry(0.22, 0).rotateX(0.4).translate(-0.05, 0.98, -0.24),
      new THREE.IcosahedronGeometry(0.2, 0).rotateZ(0.4).translate(0.05, 0.92, 0.25),
    ].map(ni))!;
    const bushGeo = mergeGeometries([
      new THREE.IcosahedronGeometry(0.16, 0).translate(0, 0.1, 0),
      new THREE.IcosahedronGeometry(0.12, 0).rotateY(0.6).translate(0.12, 0.07, 0.04),
      new THREE.IcosahedronGeometry(0.11, 0).rotateX(0.5).translate(-0.1, 0.07, -0.05),
    ].map(ni))!;
    const rockGeo = new THREE.DodecahedronGeometry(0.2, 0);
    const tuftGeo = mergeGeometries(
      [0, 1, 2, 3].map((i) =>
        new THREE.PlaneGeometry(0.035, 0.16).translate(0, 0.08, 0).rotateZ((i - 1.5) * 0.25).rotateY(i * 0.8).toNonIndexed(),
      ),
    )!;
    const flowerGeo = new THREE.IcosahedronGeometry(0.025, 0).translate(0, 0.1, 0);

    // Conteggio delle istanze
    const conifers: THREE.Matrix4[] = [];
    const decid: THREE.Matrix4[] = [];
    const bushes: Array<[THREE.Matrix4, number]> = [];
    const rocks: Array<[THREE.Matrix4, number]> = [];
    const tufts: Array<[THREE.Matrix4, number]> = [];
    const flowers: Array<[THREE.Matrix4, number]> = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
    const sc = new THREE.Vector3();
    const place = (x: number, z: number, s: number, sy = s) => {
      pos.set(x, this.baseAt(x, z) - 0.02, z);
      q.setFromAxisAngle(up, rand() * Math.PI * 2);
      sc.set(s, sy, s);
      return m.compose(pos, q, sc).clone();
    };
    for (let z = 0; z < t.size; z++) {
      for (let x = 0; x < t.size; x++) {
        const tile = tileAt(t, x, z);
        const key = z * t.size + x;
        if (tile === Tile.Forest) {
          const nTrees = 2 + (rand() < 0.6 ? 1 : 0);
          for (let k = 0; k < nTrees; k++) {
            const s = 0.7 + rand() * 0.65;
            const mat = place(x + 0.15 + rand() * 0.7, z + 0.15 + rand() * 0.7, s, s * (0.85 + rand() * 0.4));
            (rand() < 0.55 ? conifers : decid).push(mat);
          }
          if (rand() < 0.5) bushes.push([place(x + rand(), z + rand(), 0.8 + rand() * 0.6), key]);
        } else if (tile === Tile.Grass) {
          if (rand() < 0.05) bushes.push([place(x + 0.2 + rand() * 0.6, z + 0.2 + rand() * 0.6, 0.7 + rand() * 0.6), key]);
          if (rand() < 0.012) decid.push(place(x + 0.5, z + 0.5, 0.8 + rand() * 0.4));
          if (rand() < 0.03) rocks.push([place(x + rand(), z + rand(), 0.3 + rand() * 0.4), key]);
          for (let k = 0; k < this.tuftsPerTile; k++) tufts.push([place(x + rand(), z + rand(), 0.7 + rand() * 0.8), key]);
          if (rand() < 0.5) for (let k = 0; k < 3; k++) flowers.push([place(x + rand(), z + rand(), 0.8 + rand() * 0.5), key]);
        } else if (tile === Tile.Rock || tile === Tile.Gold) {
          for (let k = 0; k < 2; k++) rocks.push([place(x + rand(), z + rand(), 0.6 + rand() * 1.0, 0.4 + rand() * 0.6), key]);
        } else if (tile === Tile.Sand && rand() < 0.15) {
          rocks.push([place(x + rand(), z + rand(), 0.3 + rand() * 0.3), key]);
        }
      }
    }

    const inst = (geo: THREE.BufferGeometry, mat: THREE.Material, list: THREE.Matrix4[], shadow = true) => {
      const im = new THREE.InstancedMesh(geo, mat, Math.max(1, list.length));
      im.count = list.length;
      list.forEach((mx, i) => im.setMatrixAt(i, mx));
      im.castShadow = shadow;
      im.receiveShadow = true;
      this.group.add(im);
      return im;
    };
    const tint = (im: THREE.InstancedMesh, n: number, spread: number) => {
      const c = new THREE.Color();
      for (let i = 0; i < n; i++) {
        c.setRGB(1, 1, 1).offsetHSL((rand() - 0.5) * spread, 0, (rand() - 0.5) * 0.2);
        im.setColorAt(i, c);
      }
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    };

    const con = inst(conGeo, this.coniferMat, conifers);
    tint(con, conifers.length, 0.04);
    inst(trunkGeo, bark, conifers);
    const leaves = inst(leafGeo, this.leafMat, decid);
    tint(leaves, decid.length, 0.06);
    inst(branchGeo, bark, decid);
    const bush = inst(bushGeo, this.leafMat, bushes.map((b) => b[0]));
    tint(bush, bushes.length, 0.05);
    const rock = inst(rockGeo, new THREE.MeshStandardMaterial({ color: 0x8a857d, roughness: 1, flatShading: true }), rocks.map((r) => r[0]));
    tint(rock, rocks.length, 0.02);
    const grass = inst(tuftGeo, this.grassMat, tufts.map((r) => r[0]), false);
    tint(grass, tufts.length, 0.05);
    const flowerMesh = inst(flowerGeo, new THREE.MeshStandardMaterial({ roughness: 0.8 }), flowers.map((r) => r[0]), false);
    const palette = [0xf4f0e0, 0xf2d040, 0xd84a4a, 0x9a6ad0, 0x6a8ae0].map((h) => new THREE.Color(h));
    flowers.forEach((_, i) => flowerMesh.setColorAt(i, palette[Math.floor(rand() * palette.length)]));
    if (flowerMesh.instanceColor) flowerMesh.instanceColor.needsUpdate = true;

    bushes.forEach(([mx, key], i) => this.register(key, bush, i, mx));
    rocks.forEach(([mx, key], i) => this.register(key, rock, i, mx));
    tufts.forEach(([mx, key], i) => this.register(key, grass, i, mx));
    flowers.forEach(([mx, key], i) => this.register(key, flowerMesh, i, mx));
    return { leaves, grass, flowers: flowerMesh };
  }

  /** Nasconde erba, cespugli e sassi sotto gli edifici. */
  private updateDecorVisibility() {
    const occupied = new Set<number>();
    for (const f of this.footprints) {
      for (let z = f.z; z < f.z + f.d; z++) for (let x = f.x; x < f.x + f.w; x++) occupied.add(z * this.size + x);
    }
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    const touched = new Set<THREE.InstancedMesh>();
    for (const key of occupied) {
      if (this.hidden.has(key)) continue;
      for (const d of this.decorByTile.get(key) ?? []) {
        d.mesh.setMatrixAt(d.index, zero);
        touched.add(d.mesh);
      }
    }
    for (const key of this.hidden) {
      if (occupied.has(key)) continue;
      for (const d of this.decorByTile.get(key) ?? []) {
        d.mesh.setMatrixAt(d.index, d.matrix);
        touched.add(d.mesh);
      }
    }
    this.hidden = occupied;
    for (const m of touched) m.instanceMatrix.needsUpdate = true;
  }
}
