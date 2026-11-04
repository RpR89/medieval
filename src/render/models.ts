import * as THREE from 'three';
import type { Season } from '../game/data/calendar';
import type { BuildingDef, Species } from '../game/data/buildings';

/**
 * Modelli 3D procedurali (low-poly) costruiti con primitive.
 * Sono segnaposto pensati per essere sostituiti in seguito da modelli GLB:
 * basta far restituire a `buildModel` un oggetto caricato con GLTFLoader.
 */

const mat = (color: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.9, flatShading: true, ...extra });

export const M = {
  wood: mat(0x8b5a2b),
  darkWood: mat(0x5c3b1e),
  log: mat(0x7a4e26),
  stone: mat(0x9a958c),
  stoneDark: mat(0x6f6a62),
  stoneLight: mat(0xb8b2a6),
  plaster: mat(0xe8dcc0),
  roofTile: mat(0xa4452c),
  thatch: mat(0xc9a74e),
  earth: mat(0x6e5a3a),
  motte: mat(0x6b7a3a),
  dark: mat(0x1d1712),
  water: mat(0x2f6f8f, { roughness: 0.25, metalness: 0.1 }),
  gold: mat(0xe0b83c, { metalness: 0.6, roughness: 0.4 }),
  cloth: [mat(0xb33a3a), mat(0x3a6db3), mat(0xd9b23a), mat(0x3f8f4f)],
  flag: mat(0xb02a2a),
  smoke: mat(0x8c8c8c, { transparent: true, opacity: 0.6 }),
  hay: mat(0xd6b85a),
  target: mat(0xe6e0d0),
  targetRed: mat(0xc0392b),
  cattle: mat(0x7b4a2a),
  cattleWhite: mat(0xece4d4),
  pig: mat(0xe3a3a0),
  goat: mat(0xcfc8b8),
  horse: mat(0x5a3a22),
};

function box(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y + h / 2, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function cyl(rt: number, rb: number, h: number, m: THREE.Material, x = 0, y = 0, z = 0, seg = 10): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m);
  mesh.position.set(x, y + h / 2, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function cone(r: number, h: number, m: THREE.Material, x = 0, y = 0, z = 0, seg = 4): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.ConeGeometry(r, h, seg), m);
  mesh.position.set(x, y + h / 2, z);
  if (seg === 4) mesh.rotation.y = Math.PI / 4;
  mesh.castShadow = true;
  return mesh;
}

/** Tetto a due spioventi lungo l'asse x. */
function gable(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const shape = new THREE.Shape();
  shape.moveTo(-d / 2, 0);
  shape.lineTo(d / 2, 0);
  shape.lineTo(0, h);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: w, bevelEnabled: false });
  geo.translate(0, 0, -w / 2);
  const mesh = new THREE.Mesh(geo, m);
  mesh.rotation.y = Math.PI / 2;
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  return mesh;
}

function merlons(group: THREE.Group, w: number, d: number, y: number, m: THREE.Material, size = 0.18) {
  const step = size * 2;
  for (let x = -w / 2 + size / 2; x <= w / 2 - size / 2 + 1e-6; x += step) {
    group.add(box(size, size, size, m, x, y, -d / 2 + size / 2));
    group.add(box(size, size, size, m, x, y, d / 2 - size / 2));
  }
  for (let z = -d / 2 + size / 2 + step; z <= d / 2 - size / 2 - step + 1e-6; z += step) {
    group.add(box(size, size, size, m, -w / 2 + size / 2, y, z));
    group.add(box(size, size, size, m, w / 2 - size / 2, y, z));
  }
}

function roundMerlons(group: THREE.Group, r: number, y: number, m: THREE.Material, n = 12) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    group.add(box(0.18, 0.2, 0.18, m, Math.cos(a) * r, y, Math.sin(a) * r));
  }
}

function hut(group: THREE.Group, x: number, z: number, roof = M.thatch, walls = M.wood, s = 1) {
  group.add(box(0.7 * s, 0.5 * s, 0.7 * s, walls, x, 0, z));
  group.add(cone(0.62 * s, 0.5 * s, roof, x, 0.5 * s, z));
}

function fence(group: THREE.Group, w: number, d: number) {
  const posts: Array<[number, number]> = [];
  const hw = w / 2 - 0.08;
  const hd = d / 2 - 0.08;
  for (let x = -hw; x <= hw + 1e-6; x += w / Math.round(w * 2)) posts.push([x, -hd], [x, hd]);
  for (let z = -hd; z <= hd + 1e-6; z += d / Math.round(d * 2)) posts.push([-hw, z], [hw, z]);
  for (const [x, z] of posts) group.add(box(0.06, 0.35, 0.06, M.darkWood, x, 0, z));
  group.add(box(w - 0.16, 0.04, 0.04, M.wood, 0, 0.25, -hd));
  group.add(box(w - 0.16, 0.04, 0.04, M.wood, 0, 0.25, hd));
  group.add(box(0.04, 0.04, d - 0.16, M.wood, -hw, 0.25, 0));
  group.add(box(0.04, 0.04, d - 0.16, M.wood, hw, 0.25, 0));
}

export function animalMesh(species: Species): THREE.Group {
  const g = new THREE.Group();
  if (species === 'cattle') {
    g.add(box(0.36, 0.2, 0.16, M.cattle, 0, 0.12, 0));
    g.add(box(0.12, 0.12, 0.12, M.cattleWhite, 0.22, 0.22, 0));
  } else if (species === 'pigs') {
    g.add(box(0.24, 0.14, 0.14, M.pig, 0, 0.05, 0));
    g.add(box(0.07, 0.07, 0.08, M.pig, 0.15, 0.08, 0));
  } else {
    g.add(box(0.2, 0.12, 0.1, M.goat, 0, 0.12, 0));
    g.add(box(0.07, 0.1, 0.07, M.goat, 0.12, 0.2, 0));
  }
  return g;
}

const FIELD_COLORS: Record<string, Record<Season, number>> = {
  field_grain: { spring: 0x7fae4a, summer: 0xd9b54a, autumn: 0xa58d52, winter: 0x6b5a40 },
  field_vegetables: { spring: 0x5f9a3c, summer: 0x4e8f35, autumn: 0x6c8a3a, winter: 0x5a4a35 },
  hay_meadow: { spring: 0x8dbd55, summer: 0xb9b65a, autumn: 0x9aa85a, winter: 0x7d7a55 },
};

/** Ricolora un campo secondo la stagione. */
export function applySeason(obj: THREE.Object3D, defId: string, season: Season) {
  const colors = FIELD_COLORS[defId];
  if (!colors) return;
  obj.traverse((o) => {
    if (o.userData.crop && o instanceof THREE.Mesh) {
      (o.material as THREE.MeshStandardMaterial).color.setHex(colors[season]);
    }
    if (o.userData.haystack) o.visible = season === 'summer' || season === 'autumn';
    if (o.userData.sprout) o.visible = season !== 'winter';
  });
}

function field(group: THREE.Group, def: BuildingDef) {
  const [w, d] = def.size;
  const crop = new THREE.Mesh(new THREE.BoxGeometry(w - 0.1, 0.06, d - 0.1), mat(0x7fae4a));
  crop.position.y = 0.03;
  crop.receiveShadow = true;
  crop.userData.crop = true;
  group.add(crop);
  if (def.id === 'field_grain' || def.id === 'field_vegetables') {
    const rows = Math.round(d * (def.id === 'field_grain' ? 3 : 2));
    for (let i = 0; i < rows; i++) {
      const z = -d / 2 + (i + 0.5) * (d / rows);
      const row = box(w - 0.3, def.id === 'field_grain' ? 0.12 : 0.09, 0.12, mat(0x7fae4a), 0, 0.06, z);
      row.userData.crop = true;
      row.userData.sprout = true;
      group.add(row);
    }
  }
  if (def.id === 'hay_meadow') {
    for (const [x, z] of [[-0.8, -0.4], [0.3, 0.3], [0.9, -0.3]]) {
      const stack = cone(0.25, 0.45, M.hay, x, 0.06, z, 7);
      stack.userData.haystack = true;
      group.add(stack);
    }
  }
}

function pasture(group: THREE.Group, def: BuildingDef) {
  const [w, d] = def.size;
  const ground = new THREE.Mesh(new THREE.BoxGeometry(w - 0.1, 0.03, d - 0.1), mat(0x6f8f3f));
  ground.position.y = 0.015;
  ground.receiveShadow = true;
  group.add(ground);
  fence(group, w, d);
  group.add(box(0.7, 0.4, 0.5, M.wood, w / 2 - 0.55, 0, -d / 2 + 0.4));
  group.add(gable(0.8, 0.3, 0.6, M.thatch, w / 2 - 0.55, 0.4, -d / 2 + 0.4));
  const animals = new THREE.Group();
  animals.userData.animals = true;
  group.add(animals);
}

/** Posiziona `count` animali nel recinto, in modo stabile. */
export function updateHerd(obj: THREE.Object3D, def: BuildingDef, count: number) {
  if (!def.herd) return;
  const holder = obj.children.find((c) => c.userData.animals) as THREE.Group | undefined;
  if (!holder || holder.userData.count === count) return;
  holder.userData.count = count;
  holder.clear();
  const [w, d] = def.size;
  const visible = Math.min(count, 14);
  for (let i = 0; i < visible; i++) {
    const a = animalMesh(def.herd.species);
    const h = Math.sin(i * 12.9898 + w) * 43758.5453;
    const fx = h - Math.floor(h);
    const h2 = Math.sin(i * 78.233 + d) * 12345.678;
    const fz = h2 - Math.floor(h2);
    a.position.set((fx - 0.5) * (w - 0.6), 0.03, (fz - 0.3) * (d - 0.7));
    a.rotation.y = fx * Math.PI * 2;
    holder.add(a);
  }
}

/** Collegamenti delle mura ai vicini (+x, -x, +z, -z). */
export interface WallLinks {
  px: boolean;
  nx: boolean;
  pz: boolean;
  nz: boolean;
}

function wallSegments(group: THREE.Group, links: WallLinks, build: (len: number, axis: 'x' | 'z', offset: number) => void) {
  const any = links.px || links.nx || links.pz || links.nz;
  if (!any) {
    build(1, 'x', 0);
    return;
  }
  if (links.px) build(0.5, 'x', 0.25);
  if (links.nx) build(0.5, 'x', -0.25);
  if (links.pz) build(0.5, 'z', 0.25);
  if (links.nz) build(0.5, 'z', -0.25);
  void group;
}

function palisade(group: THREE.Group, links: WallLinks) {
  group.add(cyl(0.09, 0.09, 1.2, M.log, 0, 0, 0, 6));
  group.add(cone(0.09, 0.2, M.log, 0, 1.2, 0, 6));
  wallSegments(group, links, (len, axis, off) => {
    const n = Math.round(len * 5);
    for (let i = 0; i < n; i++) {
      const t = off - len / 2 + (i + 0.5) * (len / n);
      const x = axis === 'x' ? t : 0;
      const z = axis === 'z' ? t : 0;
      const h = 1 + ((i * 7) % 3) * 0.08;
      group.add(cyl(0.09, 0.1, h, M.log, x, 0, z, 6));
      group.add(cone(0.1, 0.2, M.log, x, h, z, 6));
    }
  });
}

function stoneWall(group: THREE.Group, links: WallLinks) {
  group.add(box(0.6, 1.6, 0.6, M.stone, 0, 0, 0));
  group.add(box(0.2, 0.2, 0.2, M.stone, 0, 1.6, 0));
  wallSegments(group, links, (len, axis, off) => {
    const w = axis === 'x' ? len : 0.5;
    const d = axis === 'z' ? len : 0.5;
    const x = axis === 'x' ? off : 0;
    const z = axis === 'z' ? off : 0;
    group.add(box(w, 1.5, d, M.stone, x, 0, z));
    const n = Math.max(1, Math.round(len * 2.5));
    for (let i = 0; i < n; i++) {
      const t = off - len / 2 + (i + 0.5) * (len / n);
      for (const side of [-0.18, 0.18]) {
        const mx = axis === 'x' ? t : side;
        const mz = axis === 'z' ? t : side;
        group.add(box(0.14, 0.2, 0.14, M.stoneLight, mx, 1.5, mz));
      }
    }
  });
}

function moat(group: THREE.Group) {
  // Il terreno sotto viene abbassato dal renderer; qui solo l'acqua.
  const water = new THREE.Mesh(new THREE.BoxGeometry(1, 0.04, 1), M.water);
  water.position.y = -0.2;
  water.receiveShadow = true;
  group.add(water);
}

function towerFlag(group: THREE.Group, y: number) {
  group.add(cyl(0.02, 0.02, 0.6, M.darkWood, 0, y, 0, 4));
  group.add(box(0.3, 0.18, 0.02, M.flag, 0.16, y + 0.4, 0));
}

/**
 * Costruisce il modello di un edificio. Il gruppo restituito è centrato
 * sull'ingombro dell'edificio, con il terreno a y=0.
 */
export function buildModel(def: BuildingDef, links: WallLinks = { px: false, nx: false, pz: false, nz: false }): THREE.Group {
  const g = new THREE.Group();
  const [w, d] = def.size;
  switch (def.id) {
    case 'palisade':
      palisade(g, links);
      break;
    case 'wall_stone':
      stoneWall(g, links);
      break;
    case 'moat':
      moat(g);
      break;
    case 'gate_wood': {
      const along = links.pz || links.nz ? 'z' : 'x';
      const inner = new THREE.Group();
      inner.add(box(0.15, 1.6, 0.15, M.log, -0.45, 0, 0));
      inner.add(box(0.15, 1.6, 0.15, M.log, 0.45, 0, 0));
      inner.add(box(1, 0.15, 0.2, M.log, 0, 1.45, 0));
      inner.add(box(0.36, 1.1, 0.06, M.darkWood, -0.2, 0, 0));
      inner.add(box(0.36, 1.1, 0.06, M.darkWood, 0.2, 0, 0));
      if (along === 'z') inner.rotation.y = Math.PI / 2;
      g.add(inner);
      break;
    }
    case 'gate_stone': {
      const along = links.pz || links.nz ? 'z' : 'x';
      const inner = new THREE.Group();
      inner.add(box(0.3, 1.8, 0.7, M.stone, -0.35, 0, 0));
      inner.add(box(0.3, 1.8, 0.7, M.stone, 0.35, 0, 0));
      inner.add(box(1, 0.5, 0.7, M.stone, 0, 1.3, 0));
      inner.add(box(0.4, 1.3, 0.05, M.darkWood, 0, 0, 0.1));
      merlons(inner, 1, 0.7, 1.8, M.stoneLight, 0.16);
      if (along === 'z') inner.rotation.y = Math.PI / 2;
      g.add(inner);
      break;
    }
    case 'tower_wood': {
      for (const [x, z] of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]]) {
        g.add(box(0.16, 2.4, 0.16, M.log, x, 0, z));
      }
      g.add(box(1.5, 0.12, 1.5, M.wood, 0, 2.2, 0));
      g.add(box(1.5, 0.4, 0.08, M.wood, 0, 2.32, -0.72));
      g.add(box(1.5, 0.4, 0.08, M.wood, 0, 2.32, 0.72));
      g.add(box(0.08, 0.4, 1.5, M.wood, -0.72, 2.32, 0));
      g.add(box(0.08, 0.4, 1.5, M.wood, 0.72, 2.32, 0));
      g.add(cone(1.15, 0.8, M.thatch, 0, 2.85, 0));
      break;
    }
    case 'tower_square':
      g.add(box(1.6, 3, 1.6, M.stone, 0, 0, 0));
      g.add(box(1.75, 0.15, 1.75, M.stoneDark, 0, 3, 0));
      merlons(g, 1.75, 1.75, 3.15, M.stoneLight, 0.22);
      for (const y of [1.2, 2.2]) g.add(box(0.1, 0.3, 0.02, M.dark, 0, y, 0.81));
      towerFlag(g, 3.15);
      break;
    case 'tower_round':
      g.add(cyl(0.8, 0.9, 3.4, M.stone, 0, 0, 0, 14));
      g.add(cyl(0.9, 0.9, 0.15, M.stoneDark, 0, 3.4, 0, 14));
      roundMerlons(g, 0.82, 3.55, M.stoneLight, 14);
      g.add(cone(0.75, 0.9, M.roofTile, 0, 3.6, 0, 14));
      break;
    case 'gatehouse':
      g.add(cyl(0.5, 0.55, 3, M.stone, -0.6, 0, 0, 12));
      g.add(cyl(0.5, 0.55, 3, M.stone, 0.6, 0, 0, 12));
      roundMerlons(g, 0.5, 3, M.stoneLight, 8);
      g.children.slice(-8).forEach((m) => (m.position.x -= 0.6));
      roundMerlons(g, 0.5, 3, M.stoneLight, 8);
      g.children.slice(-8).forEach((m) => (m.position.x += 0.6));
      g.add(box(0.9, 2.6, 1.3, M.stone, 0, 0, 0));
      g.add(box(0.5, 1.2, 1.32, M.dark, 0, 0, 0));
      merlons(g, 0.9, 1.3, 2.6, M.stoneLight, 0.18);
      towerFlag(g, 2.6);
      break;
    case 'keep_wood':
      g.add(cyl(1.0, 1.45, 0.9, M.motte, 0, 0, 0, 16));
      g.add(box(1.1, 1.6, 1.1, M.wood, 0, 0.9, 0));
      g.add(box(1.25, 0.12, 1.25, M.darkWood, 0, 2.5, 0));
      g.add(cone(0.95, 0.9, M.thatch, 0, 2.6, 0));
      for (let i = 0; i < 20; i++) {
        const a = (i / 20) * Math.PI * 2;
        g.add(cyl(0.05, 0.06, 0.55, M.log, Math.cos(a) * 0.92, 0.9, Math.sin(a) * 0.92, 5));
      }
      towerFlag(g, 3.4);
      break;
    case 'keep_stone':
      g.add(box(2.4, 0.4, 2.4, M.stoneDark, 0, 0, 0));
      g.add(box(2.2, 4, 2.2, M.stone, 0, 0.4, 0));
      merlons(g, 2.2, 2.2, 4.4, M.stoneLight, 0.24);
      for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        g.add(box(0.5, 4.8, 0.5, M.stone, x, 0, z));
        g.add(cone(0.38, 0.5, M.roofTile, x, 4.8, z));
      }
      for (const y of [1.5, 2.6, 3.5]) {
        g.add(box(0.14, 0.4, 0.02, M.dark, -0.4, y, 1.11));
        g.add(box(0.14, 0.4, 0.02, M.dark, 0.4, y, 1.11));
      }
      g.add(box(0.5, 0.8, 0.05, M.darkWood, 0, 0.4, 1.12));
      towerFlag(g, 4.4);
      break;
    case 'hut':
      hut(g, 0, 0);
      break;
    case 'house':
      g.add(box(0.5, 0.25, 0.75, M.stone, 0, 0, 0));
      g.add(box(1.7, 0.75, 0.75, M.plaster, 0, 0, 0));
      g.add(gable(1.8, 0.5, 0.9, M.roofTile, 0, 0.75, 0));
      g.add(box(0.2, 0.4, 0.02, M.darkWood, -0.4, 0, 0.38));
      g.add(box(0.15, 0.15, 0.02, M.dark, 0.3, 0.4, 0.38));
      break;
    case 'field_grain':
    case 'field_vegetables':
    case 'hay_meadow':
      field(g, def);
      break;
    case 'pasture_cattle':
    case 'pasture_pigs':
    case 'pasture_goats':
      pasture(g, def);
      break;
    case 'dairy':
      g.add(box(0.8, 0.55, 0.7, M.plaster, 0, 0, 0));
      g.add(gable(0.9, 0.35, 0.8, M.roofTile, 0, 0.55, 0));
      g.add(cyl(0.1, 0.1, 0.25, M.wood, 0.42, 0, 0.3, 8));
      break;
    case 'woodcutter':
      hut(g, -0.1, -0.1, M.thatch, M.wood, 0.8);
      for (let i = 0; i < 3; i++) {
        const l = cyl(0.07, 0.07, 0.6, M.log, 0.25, 0.07 + i * 0.12, 0.3, 6);
        l.rotation.z = Math.PI / 2;
        g.add(l);
      }
      g.add(cyl(0.12, 0.14, 0.15, M.log, -0.3, 0, 0.32, 7));
      break;
    case 'hunter':
      hut(g, 0, -0.1, M.thatch, M.darkWood, 0.85);
      g.add(box(0.3, 0.02, 0.2, M.cattle, 0.25, 0.3, 0.35));
      g.add(box(0.02, 0.35, 0.02, M.darkWood, 0.1, 0, 0.35));
      g.add(box(0.02, 0.35, 0.02, M.darkWood, 0.4, 0, 0.35));
      break;
    case 'fisher':
      for (const [x, z] of [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]]) {
        g.add(box(0.06, 0.25, 0.06, M.darkWood, x, 0, z));
      }
      g.add(box(0.7, 0.4, 0.6, M.wood, 0, 0.25, 0));
      g.add(gable(0.8, 0.3, 0.7, M.thatch, 0, 0.65, 0));
      g.add(box(0.5, 0.08, 0.18, M.darkWood, 0.15, 0, 0.42));
      break;
    case 'quarry':
      g.add(box(1.8, 0.15, 1.8, M.stoneDark, 0, -0.1, 0));
      g.add(box(1.2, 0.35, 0.6, M.stone, -0.2, 0, -0.5));
      g.add(box(0.6, 0.2, 0.4, M.stoneLight, 0.5, 0, 0.4));
      g.add(box(0.3, 0.3, 0.3, M.stoneLight, 0.1, 0, 0.5));
      g.add(box(0.06, 1.2, 0.06, M.wood, -0.6, 0, 0.5));
      g.add(box(0.9, 0.06, 0.06, M.wood, -0.2, 1.15, 0.5));
      break;
    case 'gold_mine':
      g.add(cone(1.0, 1.0, M.stoneDark, 0, 0, -0.2, 7));
      g.add(box(0.5, 0.6, 0.1, M.dark, 0, 0, 0.55));
      g.add(box(0.08, 0.7, 0.08, M.wood, -0.3, 0, 0.6));
      g.add(box(0.08, 0.7, 0.08, M.wood, 0.3, 0, 0.6));
      g.add(box(0.7, 0.08, 0.1, M.wood, 0, 0.65, 0.6));
      g.add(box(0.3, 0.15, 0.2, M.darkWood, 0.5, 0.05, 0.8));
      g.add(box(0.2, 0.06, 0.12, M.gold, 0.5, 0.2, 0.8));
      break;
    case 'charcoal_kiln': {
      const dome = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), M.earth);
      dome.castShadow = true;
      g.add(dome);
      const smoke = new THREE.Group();
      smoke.userData.smoke = true;
      for (let i = 0; i < 3; i++) {
        const puff = new THREE.Mesh(new THREE.SphereGeometry(0.12 + i * 0.04, 6, 5), M.smoke);
        puff.position.set(0, 0.5 + i * 0.35, 0);
        smoke.add(puff);
      }
      g.add(smoke);
      g.add(box(0.4, 0.2, 0.2, M.log, 0.35, 0, 0.3));
      break;
    }
    case 'granary':
      g.add(box(1.5, 0.2, 1.3, M.stone, 0, 0, 0));
      g.add(box(1.4, 0.9, 1.2, M.wood, 0, 0.2, 0));
      g.add(gable(1.6, 0.7, 1.4, M.thatch, 0, 1.1, 0));
      g.add(box(0.4, 0.6, 0.02, M.darkWood, 0, 0.2, 0.61));
      break;
    case 'market':
      for (const [i, [x, z]] of [[-0.45, -0.45], [0.45, -0.45], [-0.45, 0.45], [0.45, 0.45]].entries()) {
        for (const [px, pz] of [[-0.28, -0.2], [0.28, -0.2], [-0.28, 0.2], [0.28, 0.2]]) {
          g.add(box(0.04, 0.55, 0.04, M.darkWood, x + px, 0, z + pz));
        }
        g.add(box(0.5, 0.15, 0.3, M.wood, x, 0.2, z));
        g.add(gable(0.7, 0.2, 0.55, M.cloth[i], x, 0.55, z));
      }
      g.add(box(0.15, 0.6, 0.15, M.stone, 0, 0, 0));
      break;
    case 'barracks':
      g.add(box(1.7, 0.7, 1.1, M.wood, 0, 0, 0));
      g.add(gable(1.8, 0.5, 1.2, M.thatch, 0, 0.7, 0));
      towerFlag(g, 0.9);
      g.children.at(-1)!.position.x += 0.7;
      g.children.at(-2)!.position.x += 0.7;
      break;
    case 'archery':
      hut(g, -0.5, -0.5, M.thatch, M.wood, 0.8);
      for (const x of [-0.5, 0.2, 0.8]) {
        const t = cyl(0.2, 0.2, 0.05, M.target, x, 0.35, 0.6, 12);
        t.rotation.x = Math.PI / 2;
        g.add(t);
        const c = cyl(0.08, 0.08, 0.06, M.targetRed, x, 0.35, 0.6, 10);
        c.rotation.x = Math.PI / 2;
        g.add(c);
        g.add(box(0.04, 0.35, 0.04, M.darkWood, x, 0, 0.62));
      }
      break;
    case 'stable':
      g.add(box(2.6, 0.6, 1, M.wood, 0, 0, -0.35));
      g.add(gable(2.7, 0.45, 1.1, M.thatch, 0, 0.6, -0.35));
      for (const x of [-0.8, 0, 0.8]) {
        const h = new THREE.Group();
        h.add(box(0.36, 0.2, 0.14, M.horse, 0, 0.18, 0));
        h.add(box(0.1, 0.22, 0.1, M.horse, 0.2, 0.3, 0));
        for (const [lx, lz] of [[-0.14, -0.05], [0.14, -0.05], [-0.14, 0.05], [0.14, 0.05]]) {
          h.add(box(0.04, 0.18, 0.04, M.horse, lx, 0, lz));
        }
        h.position.set(x, 0, 0.55);
        g.add(h);
      }
      break;
    default:
      g.add(box(w * 0.8, 0.8, d * 0.8, M.wood, 0, 0, 0));
      g.add(cone(Math.max(w, d) * 0.6, 0.6, M.thatch, 0, 0.8, 0));
  }
  return g;
}

/** Tipi che formano una cinta continua e si collegano tra loro. */
export const WALL_FAMILY = new Set([
  'palisade',
  'wall_stone',
  'gate_wood',
  'gate_stone',
  'tower_wood',
  'tower_square',
  'tower_round',
  'gatehouse',
  'keep_wood',
  'keep_stone',
]);

/** Tipi il cui aspetto dipende dai vicini. */
export const LINKED_TYPES = new Set(['palisade', 'wall_stone', 'gate_wood', 'gate_stone']);
