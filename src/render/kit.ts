import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { textures } from './textures';
import { addSnow } from './effects';

/**
 * Kit di costruzione per i modelli: materiali con texture procedurali,
 * primitive con UV proporzionate alle dimensioni reali, tetti e fusione
 * delle geometrie (pochi draw call anche con modelli dettagliati).
 */

type MatOpts = Partial<THREE.MeshStandardMaterialParameters>;

function textured(map: THREE.Texture, color: number, opts: MatOpts = {}, bump = 0.6) {
  return new THREE.MeshStandardMaterial({ map, bumpMap: map, bumpScale: bump, color, roughness: 0.92, ...opts });
}

function plain(color: number, opts: MatOpts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.9, ...opts });
}

function build() {
  const t = textures();
  return {
    stone: textured(t.stone, 0xcfc8ba),
    stoneDark: textured(t.stone, 0x9a9388),
    stoneLight: textured(t.stone, 0xe2dbcd),
    planks: textured(t.planks, 0xd2b08a),
    darkPlanks: textured(t.planks, 0x8a6a4c),
    log: textured(t.bark, 0xc9a27a),
    beam: plain(0x3b2a1c),
    thatch: textured(t.thatch, 0xf0d9a0, {}, 1.2),
    roofTile: textured(t.roofTiles, 0xf0c0a8, {}, 1),
    slate: textured(t.roofTiles, 0x7a8692, {}, 0.8),
    shingle: textured(t.planks, 0xb89a74, {}, 0.9),
    logWall: textured(t.bark, 0xb08860, {}, 0.8),
    plaster: textured(t.plaster, 0xffffff, {}, 0.3),
    wattle: textured(t.plaster, 0xc9b58f, {}, 0.5),
    soil: textured(t.soil, 0xffffff, {}, 1),
    earth: plain(0x6b5536),
    grassMound: textured(t.ground, 0x557a2e, {}, 0.3),
    dark: plain(0x15100b, { roughness: 1 }),
    iron: plain(0x3d3d40, { metalness: 0.7, roughness: 0.5 }),
    gold: plain(0xe8c040, { metalness: 0.8, roughness: 0.35 }),
    straw: plain(0xd6b85a),
    leafGreen: plain(0x4f7d32),
    rope: plain(0xb9a27a),
    water: plain(0x3d7c9a, { roughness: 0.1, metalness: 0.2 }),
    cloth: [0xb83a32, 0x2f5fa8, 0xd8a83a, 0x3f8a4a, 0x7a3a8a].map((c) =>
      new THREE.MeshStandardMaterial({ map: t.stripes, color: c, roughness: 0.95, side: THREE.DoubleSide }),
    ),
    flag: new THREE.MeshStandardMaterial({ color: 0xb02a2a, roughness: 0.9, side: THREE.DoubleSide }),
    flagGold: new THREE.MeshStandardMaterial({ color: 0xd9a83a, roughness: 0.9, side: THREE.DoubleSide }),
    flagBlue: new THREE.MeshStandardMaterial({ color: 0x2f5fb8, roughness: 0.9, side: THREE.DoubleSide }),
    smoke: new THREE.MeshStandardMaterial({ color: 0x9a9690, transparent: true, opacity: 0.45, depthWrite: false }),
    fire: new THREE.MeshStandardMaterial({ color: 0xff7a20, emissive: 0xff5a10, emissiveIntensity: 2.5 }),
    road: textured(t.ground, 0x8a7052, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }, 0.4),
    paving: textured(t.stone, 0xb0a898, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }, 0.8),
    target: plain(0xe6dcc0),
    targetRed: plain(0xb8322a),
    cowBrown: plain(0x7b4a2a),
    cowWhite: plain(0xece4d4),
    cowBlack: plain(0x2a2420),
    pig: plain(0xe0a49c),
    goat: plain(0xd8d0c0),
    goatDark: plain(0x6b5a48),
    horn: plain(0xd8ccb0),
    horse: plain(0x5a3a22),
    horseDark: plain(0x2e1e12),
  };
}

/** Materiali su cui si posa la neve d'inverno. */
const SNOWY: Array<keyof ReturnType<typeof build>> = [
  'road', 'paving', 'slate', 'shingle', 'stone', 'stoneDark', 'stoneLight', 'planks', 'darkPlanks', 'log', 'thatch', 'roofTile', 'grassMound', 'straw', 'earth',
];

let cache: ReturnType<typeof build> | null = null;
export function mats() {
  if (!cache) {
    cache = build();
    for (const name of SNOWY) addSnow(cache[name] as THREE.Material, name === 'grassMound' ? 1 : 0.9);
  }
  return cache;
}

// ───────────── Primitive ─────────────

function finish(geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) {
  const mesh = new THREE.Mesh(geo, m);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Scala le UV di una BoxGeometry perché la texture abbia densità costante. */
function scaleBoxUV(geo: THREE.BufferGeometry, w: number, h: number, d: number) {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  // Ordine delle facce in BoxGeometry: +x, -x, +y, -y, +z, -z (4 vertici ciascuna)
  const dims: Array<[number, number]> = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      uv.setXY(i, uv.getX(i) * dims[f][0], uv.getY(i) * dims[f][1]);
    }
  }
}

/** Parallelepipedo con base a quota y. */
export function box(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const geo = new THREE.BoxGeometry(w, h, d);
  scaleBoxUV(geo, w, h, d);
  geo.translate(0, h / 2, 0);
  return finish(geo, m, x, y, z);
}

/** Cilindro (o tronco di cono) con base a quota y. */
export function cyl(rt: number, rb: number, h: number, m: THREE.Material, x = 0, y = 0, z = 0, seg = 12): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(rt, rb, h, seg);
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  const circ = Math.PI * 2 * Math.max(rt, rb, 0.05);
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * circ, uv.getY(i) * h);
  geo.translate(0, h / 2, 0);
  return finish(geo, m, x, y, z);
}

/** Cono (o piramide con seg=4) con base a quota y. */
export function cone(r: number, h: number, m: THREE.Material, x = 0, y = 0, z = 0, seg = 4): THREE.Mesh {
  const geo = new THREE.ConeGeometry(r, h, seg);
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  const slant = Math.hypot(r, h);
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.PI * 2 * r, uv.getY(i) * slant);
  if (seg === 4) geo.rotateY(Math.PI / 4);
  geo.translate(0, h / 2, 0);
  return finish(geo, m, x, y, z);
}

export function sphere(r: number, m: THREE.Material, x = 0, y = 0, z = 0, detail = 1): THREE.Mesh {
  return finish(new THREE.IcosahedronGeometry(r, detail), m, x, y, z);
}

/** Tetto a piramide (w lungo x, d lungo z). */
export function hipRoof(w: number, d: number, h: number, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const mesh = cone(Math.SQRT1_2, h, m, x, y, z, 4);
  mesh.scale.set(w, 1, d);
  return mesh;
}

/**
 * Tetto a due falde con colmo lungo x: due lastre inclinate + timpani.
 * `len` lunghezza del colmo, `span` larghezza dell'edificio, `h` altezza del tetto.
 */
export function gableRoof(
  len: number,
  span: number,
  h: number,
  roof: THREE.Material,
  gable: THREE.Material | null,
  x = 0,
  y = 0,
  z = 0,
  overhang = 0.12,
): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  const half = span / 2 + overhang;
  const slope = Math.hypot(half, h * (half / (span / 2)));
  const angle = Math.atan2(h, span / 2);
  const thick = 0.05;
  for (const side of [-1, 1]) {
    const slab = box(len + overhang * 2, thick, slope, roof, 0, 0, 0);
    slab.geometry.translate(0, -thick / 2, 0);
    // Ruota attorno al colmo: la falda scende verso ±z
    slab.rotation.x = side * angle;
    slab.position.set(0, h - (slope * Math.sin(angle)) / 2, (side * slope * Math.cos(angle)) / 2);
    g.add(slab);
  }
  if (gable) {
    const shape = new THREE.Shape();
    shape.moveTo(-span / 2, 0);
    shape.lineTo(span / 2, 0);
    shape.lineTo(0, h);
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: len - 0.02, bevelEnabled: false });
    geo.translate(0, 0, -(len - 0.02) / 2);
    geo.rotateY(Math.PI / 2);
    g.add(finish(geo, gable, 0, 0, 0));
  }
  return g;
}

/** Bandiera animata su asta. */
export function flag(m: THREE.Material, x: number, y: number, z: number, size = 0.32): THREE.Group {
  const k = mats();
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.add(cyl(0.02, 0.025, 0.75, k.beam, 0, 0, 0, 5));
  const geo = new THREE.PlaneGeometry(size, size * 0.6, 8, 3);
  geo.translate(size / 2, 0, 0);
  const cloth = new THREE.Mesh(geo, m);
  cloth.position.y = 0.75 - size * 0.32;
  cloth.castShadow = true;
  cloth.userData.flag = geo.getAttribute('position').array.slice();
  g.add(cloth);
  g.userData.keep = true;
  return g;
}

/** Sbuffi di fumo animati (camini, carbonaie). */
export function smoke(x: number, y: number, z: number, puffs = 4, scale = 1): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.userData.keep = true;
  g.userData.smoke = { scale };
  for (let i = 0; i < puffs; i++) {
    const p = new THREE.Mesh(new THREE.IcosahedronGeometry(0.1 * scale, 0), mats().smoke);
    p.userData.phase = i / puffs;
    g.add(p);
  }
  return g;
}

/** Feritoia o finestra scura sul fronte +z di un elemento. */
export function slit(x: number, y: number, z: number, w = 0.06, h = 0.22, rotY = 0): THREE.Mesh {
  const m = box(w, h, 0.03, mats().dark, x, y, z);
  m.rotation.y = rotY;
  m.castShadow = false;
  return m;
}

/** Finestra ad arco: rettangolo + semicerchio. */
export function archWindow(x: number, y: number, z: number, w: number, h: number, rotY = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = rotY;
  g.add(box(w, h - w / 2, 0.03, mats().dark, 0, 0, 0));
  const top = cyl(w / 2, w / 2, 0.03, mats().dark, 0, h - w / 2, 0.015, 10);
  top.rotation.x = Math.PI / 2;
  top.position.y = h - w / 2;
  g.add(top);
  return g;
}

// ───────────── Fusione ─────────────

/**
 * Fonde tutte le mesh statiche del gruppo in una mesh per materiale.
 * I figli con userData.keep (bandiere, fumo, animali, colture stagionali) restano separati.
 */
export function bake(root: THREE.Group): THREE.Group {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const kept: THREE.Object3D[] = [];
  const visit = (o: THREE.Object3D) => {
    for (const c of [...o.children]) {
      if (c.userData.keep) {
        kept.push(c);
        continue;
      }
      if (c instanceof THREE.Mesh) {
        let geo = (c.geometry as THREE.BufferGeometry).clone();
        if (geo.index) geo = geo.toNonIndexed();
        for (const name of Object.keys(geo.attributes)) {
          if (name !== 'position' && name !== 'normal' && name !== 'uv') geo.deleteAttribute(name);
        }
        if (!geo.getAttribute('uv')) {
          geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geo.getAttribute('position').count * 2), 2));
        }
        geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, c.matrixWorld));
        const m = c.material as THREE.Material;
        if (!byMat.has(m)) byMat.set(m, []);
        byMat.get(m)!.push(geo);
      }
      visit(c);
    }
  };
  visit(root);
  const out = new THREE.Group();
  out.userData = { ...root.userData };
  for (const [m, geos] of byMat) {
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, m);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    out.add(mesh);
    for (const g of geos) g.dispose();
  }
  for (const k of kept) {
    // Mantiene la trasformazione relativa alla radice
    k.updateMatrixWorld(true);
    const local = new THREE.Matrix4().multiplyMatrices(inv, k.matrixWorld);
    k.removeFromParent();
    local.decompose(k.position, k.quaternion, k.scale);
    out.add(k);
  }
  return out;
}
