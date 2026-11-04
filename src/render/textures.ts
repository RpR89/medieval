import * as THREE from 'three';
import { mulberry32 } from '../game/world/terrain';

/**
 * Texture procedurali disegnate su canvas: nessun file esterno da scaricare.
 * Ogni texture copre 1 unità di mondo (= 1 casella) e si ripete.
 */

type Draw = (ctx: CanvasRenderingContext2D, size: number, rand: () => number) => void;

function make(size: number, seed: number, draw: Draw, srgb = true): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  draw(ctx, size, mulberry32(seed));
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const hsl = (h: number, s: number, l: number) => `hsl(${h},${s}%,${l}%)`;

function speckle(ctx: CanvasRenderingContext2D, size: number, rand: () => number, n: number, alpha = 0.08) {
  for (let i = 0; i < n; i++) {
    const v = rand() < 0.5 ? 0 : 255;
    ctx.fillStyle = `rgba(${v},${v},${v},${alpha * rand()})`;
    const s = 1 + rand() * 2.5;
    ctx.fillRect(rand() * size, rand() * size, s, s);
  }
}

/** Conci di pietra squadrati con malta. */
function stone(ctx: CanvasRenderingContext2D, size: number, rand: () => number) {
  ctx.fillStyle = '#6d675e';
  ctx.fillRect(0, 0, size, size);
  const rows = 7;
  const rh = size / rows;
  for (let r = 0; r < rows; r++) {
    let x = -rand() * rh * 1.5;
    while (x < size) {
      const w = rh * (1.1 + rand() * 1.2);
      const l = 52 + rand() * 16;
      const g = ctx.createLinearGradient(0, r * rh, 0, (r + 1) * rh);
      g.addColorStop(0, hsl(35 + rand() * 12, 8 + rand() * 8, l + 6));
      g.addColorStop(1, hsl(35 + rand() * 12, 8 + rand() * 8, l - 6));
      ctx.fillStyle = g;
      const m = 2.5;
      ctx.beginPath();
      ctx.roundRect(x + m, r * rh + m, w - 2 * m, rh - 2 * m, 3);
      ctx.fill();
      // Ripete a cavallo del bordo per la piastrellatura
      if (x + w > size) {
        ctx.beginPath();
        ctx.roundRect(x - size + m, r * rh + m, w - 2 * m, rh - 2 * m, 3);
        ctx.fill();
      }
      x += w;
    }
  }
  speckle(ctx, size, rand, size * 12, 0.12);
}

/** Assi di legno verticali con venature. */
function planks(ctx: CanvasRenderingContext2D, size: number, rand: () => number) {
  const n = 6;
  const pw = size / n;
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = hsl(26 + rand() * 6, 38 + rand() * 12, 30 + rand() * 10);
    ctx.fillRect(i * pw, 0, pw, size);
    for (let k = 0; k < 9; k++) {
      ctx.strokeStyle = `rgba(30,15,5,${0.15 + rand() * 0.2})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const x0 = i * pw + rand() * pw;
      ctx.moveTo(x0, 0);
      for (let y = 0; y <= size; y += 16) ctx.lineTo(x0 + Math.sin(y * 0.03 + k) * 2, y);
      ctx.stroke();
    }
    if (rand() < 0.5) {
      ctx.fillStyle = 'rgba(40,20,8,0.5)';
      ctx.beginPath();
      ctx.ellipse(i * pw + pw / 2, rand() * size, 3, 5, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(20,10,4,0.7)';
    ctx.fillRect(i * pw, 0, 2, size);
  }
}

/** Corteccia per tronchi e pali. */
function bark(ctx: CanvasRenderingContext2D, size: number, rand: () => number) {
  ctx.fillStyle = '#5b3d22';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < size * 1.5; i++) {
    const x = rand() * size;
    ctx.strokeStyle = rand() < 0.5 ? 'rgba(30,18,8,0.5)' : 'rgba(140,100,60,0.25)';
    ctx.lineWidth = 1 + rand() * 2;
    ctx.beginPath();
    ctx.moveTo(x, rand() * size);
    ctx.lineTo(x + (rand() - 0.5) * 4, rand() * size);
    ctx.stroke();
  }
}

/** Paglia: fasci di steli. */
function thatch(ctx: CanvasRenderingContext2D, size: number, rand: () => number) {
  ctx.fillStyle = '#9c7a38';
  ctx.fillRect(0, 0, size, size);
  const courses = 6;
  for (let c = 0; c < courses; c++) {
    const y0 = (c / courses) * size;
    for (let i = 0; i < size * 2.2; i++) {
      const x = rand() * size;
      const y = y0 + rand() * (size / courses) * 1.1;
      ctx.strokeStyle = hsl(40 + rand() * 10, 45 + rand() * 20, 35 + rand() * 30);
      ctx.lineWidth = 1 + rand();
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (rand() - 0.5) * 3, y + size / courses * (0.6 + rand() * 0.5));
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(40,25,5,0.35)';
    ctx.fillRect(0, y0 + size / courses - 3, size, 3);
  }
}

/** Coppi in laterizio. */
function roofTiles(ctx: CanvasRenderingContext2D, size: number, rand: () => number) {
  ctx.fillStyle = '#5e2414';
  ctx.fillRect(0, 0, size, size);
  const rows = 8;
  const cols = 8;
  const rh = size / rows;
  const cw = size / cols;
  for (let r = 0; r < rows; r++) {
    for (let c = -1; c <= cols; c++) {
      const x = c * cw + (r % 2) * cw * 0.5;
      const g = ctx.createLinearGradient(x, 0, x + cw, 0);
      const l = 36 + rand() * 12;
      g.addColorStop(0, hsl(12 + rand() * 8, 55, l - 10));
      g.addColorStop(0.5, hsl(14 + rand() * 8, 60, l + 6));
      g.addColorStop(1, hsl(12 + rand() * 8, 55, l - 12));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.roundRect(x + 1, r * rh, cw - 2, rh + 2, [0, 0, cw / 2, cw / 2]);
      ctx.fill();
    }
  }
  speckle(ctx, size, rand, size * 6, 0.1);
}

/** Intonaco a calce. */
function plaster(ctx: CanvasRenderingContext2D, size: number, rand: () => number) {
  ctx.fillStyle = '#e4d9c2';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 60; i++) {
    const r = 10 + rand() * 40;
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    const dark = rand() < 0.6;
    g.addColorStop(0, dark ? 'rgba(120,100,70,0.08)' : 'rgba(255,255,255,0.1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save();
    ctx.translate(rand() * size, rand() * size);
    ctx.fillStyle = g;
    ctx.fillRect(-r, -r, r * 2, r * 2);
    ctx.restore();
  }
  speckle(ctx, size, rand, size * 8, 0.06);
}

/** Terra arata a solchi. */
function soil(ctx: CanvasRenderingContext2D, size: number, rand: () => number) {
  const rows = 10;
  for (let r = 0; r < rows; r++) {
    const g = ctx.createLinearGradient(0, (r / rows) * size, 0, ((r + 1) / rows) * size);
    g.addColorStop(0, '#5a4128');
    g.addColorStop(0.5, '#7a5a38');
    g.addColorStop(1, '#4a3420');
    ctx.fillStyle = g;
    ctx.fillRect(0, (r / rows) * size, size, size / rows);
  }
  speckle(ctx, size, rand, size * 10, 0.15);
}

/** Dettaglio per il terreno: chiazze e fili d'erba quasi bianchi (si moltiplica ai colori dei vertici). */
function groundDetail(ctx: CanvasRenderingContext2D, size: number, rand: () => number) {
  ctx.fillStyle = '#e8e8e8';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 400; i++) {
    const r = 6 + rand() * 30;
    const v = 200 + rand() * 55;
    ctx.fillStyle = `rgba(${v},${v},${v},0.25)`;
    ctx.beginPath();
    ctx.arc(rand() * size, rand() * size, r, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < size * 6; i++) {
    const v = rand() < 0.5 ? 170 : 255;
    ctx.strokeStyle = `rgba(${v},${v},${v},0.35)`;
    ctx.lineWidth = 1;
    const x = rand() * size;
    const y = rand() * size;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rand() - 0.5) * 3, y - 3 - rand() * 4);
    ctx.stroke();
  }
}

/** Strisce per tende e stendardi (bianco/grigio: il colore lo dà il materiale). */
function stripes(ctx: CanvasRenderingContext2D, size: number) {
  const n = 8;
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = i % 2 ? '#ffffff' : '#c8c0b0';
    ctx.fillRect((i / n) * size, 0, size / n, size);
  }
}

/** Mappa delle normali per l'acqua, da rumore sovrapposto. */
function waterNormals(size: number, seed: number): THREE.Texture {
  const rand = mulberry32(seed);
  const h = new Float32Array(size * size);
  const waves = Array.from({ length: 14 }, () => ({
    fx: Math.round((rand() - 0.5) * 12),
    fz: Math.round((rand() - 0.5) * 12),
    ph: rand() * Math.PI * 2,
    a: 0.3 + rand(),
  }));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0;
      for (const w of waves) v += w.a * Math.sin(((x * w.fx + y * w.fz) / size) * Math.PI * 2 + w.ph);
      h[y * size + x] = v;
    }
  }
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = h[y * size + ((x - 1 + size) % size)];
      const r = h[y * size + ((x + 1) % size)];
      const u = h[((y - 1 + size) % size) * size + x];
      const d = h[((y + 1) % size) * size + x];
      const n = new THREE.Vector3((l - r) * 0.5, (u - d) * 0.5, 1).normalize();
      const i = (y * size + x) * 4;
      data[i] = (n.x * 0.5 + 0.5) * 255;
      data[i + 1] = (n.y * 0.5 + 0.5) * 255;
      data[i + 2] = (n.z * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, size, size);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

let cache: ReturnType<typeof build> | null = null;

function build() {
  return {
    stone: make(512, 1, stone),
    planks: make(512, 2, planks),
    bark: make(256, 3, bark),
    thatch: make(512, 4, thatch),
    roofTiles: make(512, 5, roofTiles),
    plaster: make(512, 6, plaster),
    soil: make(512, 7, soil),
    ground: make(256, 8, groundDetail),
    stripes: make(64, 9, (c, s) => stripes(c, s)),
    waterNormals: waterNormals(256, 10),
  };
}

export function textures() {
  if (!cache) cache = build();
  return cache;
}
