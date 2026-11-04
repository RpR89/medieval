import * as THREE from 'three';
import { mulberry32 } from '../game/world/terrain';
import { box, cone, cyl, gableRoof, mats, smoke, sphere } from './kit';

/** Elementi architettonici condivisi dai modelli. */

type G = THREE.Group;
const PI = Math.PI;
void mulberry32;
void gableRoof;
void cone;

// ───────────── Elementi architettonici ricorrenti ─────────────

/** Parete a graticcio: intonaco con travi a vista su tutti i lati. */
export function timberFrame(g: G, w: number, h: number, d: number, x = 0, y = 0, z = 0) {
  const k = mats();
  g.add(box(w, h, d, k.plaster, x, y, z));
  const t = 0.035;
  const faces: Array<{ len: number; axis: 'x' | 'z'; off: number }> = [
    { len: w, axis: 'x', off: d / 2 },
    { len: w, axis: 'x', off: -d / 2 },
    { len: d, axis: 'z', off: w / 2 },
    { len: d, axis: 'z', off: -w / 2 },
  ];
  for (const f of faces) {
    const place = (a: number, b: number, bw: number, bh: number, by: number) => {
      const bx = f.axis === 'x' ? x + a : x + f.off;
      const bz = f.axis === 'x' ? z + f.off : z + a;
      const m = box(f.axis === 'x' ? bw : t, bh, f.axis === 'x' ? t : bw, k.beam, bx, y + by, bz);
      void b;
      return m;
    };
    g.add(place(0, 0, f.len + t, t, 0));
    g.add(place(0, 0, f.len + t, t, h - t));
    g.add(place(0, 0, f.len + t, t, h * 0.5));
    const posts = Math.max(2, Math.round(f.len / 0.3));
    for (let i = 0; i <= posts; i++) g.add(place(-f.len / 2 + (i * f.len) / posts, 0, t, h, 0));
    // Controventi diagonali nelle campate esterne
    for (const s of [-1, 1]) {
      const bay = f.len / posts;
      const len = Math.hypot(bay, h * 0.5);
      const br = place(s * (f.len / 2 - bay / 2), 0, t, len, h * 0.5 - len / 2 + h * 0.25 - 0.0);
      br.geometry.translate(0, -len / 2, 0);
      br.position.y = y + h * 0.75;
      if (f.axis === 'x') br.rotation.z = s * Math.atan2(bay, h * 0.5);
      else br.rotation.x = -s * Math.atan2(bay, h * 0.5);
      g.add(br);
    }
  }
}

/** Finestra con scuri aperti, sul fronte che guarda +z (ruotata di rotY). */
export function windowShutters(g: G, x: number, y: number, z: number, rotY = 0, w = 0.1, h = 0.13) {
  const k = mats();
  const sub = new THREE.Group();
  sub.position.set(x, y, z);
  sub.rotation.y = rotY;
  sub.add(box(w, h, 0.02, k.dark, 0, 0, 0));
  for (const s of [-1, 1]) {
    const sh = box(w / 2, h, 0.015, k.darkPlanks, s * (w * 0.75), 0, 0.02);
    sh.rotation.y = s * 0.5;
    sub.add(sh);
  }
  g.add(sub);
}

export function door(g: G, x: number, z: number, rotY = 0, w = 0.16, h = 0.3) {
  const k = mats();
  const d = box(w, h, 0.03, k.darkPlanks, x, 0, z);
  d.rotation.y = rotY;
  g.add(d);
  const lintel = box(w + 0.06, 0.04, 0.04, k.beam, x, h, z);
  lintel.rotation.y = rotY;
  g.add(lintel);
}

export function chimney(g: G, x: number, y: number, z: number, h = 0.35) {
  const k = mats();
  g.add(box(0.12, h, 0.12, k.stone, x, y, z));
  g.add(box(0.15, 0.04, 0.15, k.stoneDark, x, y + h, z));
  g.add(smoke(x, y + h + 0.05, z, 4, 0.8));
}

/** Merli su un perimetro rettangolare. */
export function crenels(g: G, w: number, d: number, y: number, m: THREE.Material, size = 0.13, h = 0.16) {
  const step = size * 1.9;
  const along = (len: number, place: (t: number) => void) => {
    const n = Math.max(1, Math.floor(len / step));
    for (let i = 0; i < n; i++) place(-len / 2 + size / 2 + (i * (len - size)) / Math.max(1, n - 1));
  };
  along(w, (t) => {
    g.add(box(size, h, size * 0.8, m, t, y, -d / 2 + size * 0.4));
    g.add(box(size, h, size * 0.8, m, t, y, d / 2 - size * 0.4));
  });
  along(d - size * 2, (t) => {
    g.add(box(size * 0.8, h, size, m, -w / 2 + size * 0.4, y, t));
    g.add(box(size * 0.8, h, size, m, w / 2 - size * 0.4, y, t));
  });
}

export function roundCrenels(g: G, r: number, y: number, m: THREE.Material, n = 14, x = 0, z = 0) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * PI * 2;
    const c = box(0.13, 0.17, 0.1, m, x + Math.cos(a) * r, y, z + Math.sin(a) * r);
    c.rotation.y = -a + PI / 2;
    g.add(c);
  }
}

/** Beccatelli (mensole sotto il parapetto) su un perimetro rettangolare. */
export function corbels(g: G, w: number, d: number, y: number, m: THREE.Material) {
  const n = Math.round(w / 0.2);
  for (let i = 0; i <= n; i++) {
    const t = -w / 2 + (i * w) / n;
    g.add(box(0.06, 0.1, 0.08, m, t, y, d / 2 + 0.02));
    g.add(box(0.06, 0.1, 0.08, m, t, y, -d / 2 - 0.02));
  }
  const nd = Math.round(d / 0.2);
  for (let i = 1; i < nd; i++) {
    const t = -d / 2 + (i * d) / nd;
    g.add(box(0.08, 0.1, 0.06, m, w / 2 + 0.02, y, t));
    g.add(box(0.08, 0.1, 0.06, m, -w / 2 - 0.02, y, t));
  }
}

export function barrel(g: G, x: number, z: number, s = 1) {
  const k = mats();
  g.add(cyl(0.07 * s, 0.07 * s, 0.18 * s, k.planks, x, 0, z, 8));
  g.add(cyl(0.075 * s, 0.075 * s, 0.02 * s, k.iron, x, 0.03 * s, z, 8));
  g.add(cyl(0.075 * s, 0.075 * s, 0.02 * s, k.iron, x, 0.13 * s, z, 8));
}

export function crate(g: G, x: number, z: number, s = 0.14, y = 0) {
  g.add(box(s, s, s, mats().planks, x, y, z));
}

export function sack(g: G, x: number, z: number) {
  const s = sphere(0.07, mats().rope, x, 0.06, z, 0);
  s.scale.set(1, 1.2, 1);
  g.add(s);
}

export function logPile(g: G, x: number, z: number, rotY = 0, rows = 3) {
  const k = mats();
  const pile = new THREE.Group();
  pile.position.set(x, 0, z);
  pile.rotation.y = rotY;
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < rows - r; i++) {
      const l = cyl(0.055, 0.055, 0.5, k.log, 0, 0, 0, 7);
      l.rotation.z = PI / 2;
      l.position.set(0.25, 0.055 + r * 0.095, -((rows - r - 1) * 0.11) / 2 + i * 0.11);
      l.position.x = 0;
      l.geometry.translate(0, -0.25, 0);
      pile.add(l);
    }
  }
  g.add(pile);
}

/** Recinzione a pali e due traverse lungo il perimetro w×d, con apertura sul lato +z. */
export function fence(g: G, w: number, d: number, gap = 0.5) {
  const k = mats();
  const hw = w / 2 - 0.06;
  const hd = d / 2 - 0.06;
  const post = (x: number, z: number) => g.add(box(0.05, 0.32, 0.05, k.beam, x, 0, z));
  const railX = (x0: number, x1: number, z: number) => {
    for (const y of [0.13, 0.26]) g.add(box(x1 - x0, 0.03, 0.025, k.planks, (x0 + x1) / 2, y, z));
  };
  const railZ = (z0: number, z1: number, x: number) => {
    for (const y of [0.13, 0.26]) g.add(box(0.025, 0.03, z1 - z0, k.planks, x, y, (z0 + z1) / 2));
  };
  const n = Math.round(w / 0.4);
  for (let i = 0; i <= n; i++) {
    const x = -hw + (i * 2 * hw) / n;
    post(x, -hd);
    if (Math.abs(x) >= gap / 2 - 0.01) post(x, hd);
  }
  const nd = Math.round(d / 0.4);
  for (let i = 1; i < nd; i++) {
    post(-hw, -hd + (i * 2 * hd) / nd);
    post(hw, -hd + (i * 2 * hd) / nd);
  }
  railX(-hw, hw, -hd);
  railX(-hw, -gap / 2, hd);
  railX(gap / 2, hw, hd);
  railZ(-hd, hd, -hw);
  railZ(-hd, hd, hw);
}

