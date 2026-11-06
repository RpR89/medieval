import * as THREE from 'three';
import { mulberry32 } from '../game/world/terrain';
import { archWindow, box, cone, cyl, flag, gableRoof, hipRoof, mats, slit, smoke, sphere } from './kit';
import { corbels, crenels, door, roundCrenels } from './parts';

/**
 * Modelli delle fortificazioni, delle strade e dei ponti.
 * Mura e strade si collegano in 8 direzioni (anche in diagonale) e si
 * allungano fin dentro torri e mastio, così la cinta appare continua.
 */

type G = THREE.Group;
const PI = Math.PI;

/** Collegamento verso una casella vicina: direzione e allungamento extra (per torri e mastio). */
export interface Link {
  dx: number;
  dz: number;
  ext: number;
}

export type HpVisual = 'ok' | 'damaged' | 'ruin';

export interface ModelCtx {
  links?: Link[];
  upgrades?: string[];
  state?: HpVisual;
  seed?: number;
  /** Direzione verso l'esterno della cinta (per bertesche e ponte levatoio). */
  outDir?: [number, number];
  /** Lato della porta su cui c'è il fossato. */
  moatDir?: [number, number] | null;
  /** Profondità del fossato (1-3) e se è allagato. */
  depth?: number;
  flooded?: boolean;
  /** Cantiere: stadio dei lavori (0-3). */
  site?: number;
  /** Lavori in corso su un edificio finito (impalcature). */
  works?: boolean;
}

const has = (c: ModelCtx, u: string) => !!c.upgrades?.includes(u);

/**
 * Esegue `build` in un sottogruppo ruotato verso (dx, dz): dentro, il segmento va da x=0 a x=len.
 */
function along(g: G, l: Link, build: (sub: G, len: number) => void) {
  const diag = l.dx !== 0 && l.dz !== 0;
  const len = (diag ? Math.SQRT2 / 2 : 0.5) + l.ext + 0.02;
  const sub = new THREE.Group();
  sub.rotation.y = Math.atan2(-l.dz, l.dx);
  build(sub, len);
  g.add(sub);
}

function linksOrDefault(c: ModelCtx): Link[] {
  return c.links && c.links.length ? c.links : [{ dx: 1, dz: 0, ext: 0 }, { dx: -1, dz: 0, ext: 0 }];
}

/** Macerie sparse alla base. */
function rubble(g: G, seed: number, n: number, m: THREE.Material, spread = 0.45) {
  const rand = mulberry32(seed);
  for (let i = 0; i < n; i++) {
    const s = 0.05 + rand() * 0.08;
    const r = box(s * 1.4, s, s, m, (rand() - 0.5) * spread * 2, 0, (rand() - 0.5) * spread * 2);
    r.rotation.y = rand() * PI;
    g.add(r);
  }
}

// ───────────── Palizzata ─────────────

export function palisade(g: G, c: ModelCtx, double = false) {
  const k = mats();
  const rand = mulberry32(c.seed ?? 1);
  const ruin = c.state === 'ruin';
  const damaged = c.state === 'damaged';
  const stake = (sub: G, x: number, z: number) => {
    if (ruin && rand() < 0.65) return;
    if (damaged && rand() < 0.2) return;
    const h = (ruin ? 0.35 : 1.05) + rand() * 0.2;
    const r = 0.075 + rand() * 0.02;
    const s = cyl(r, r * 1.1, h, k.log, x, 0, z, 7);
    s.rotation.z = (rand() - 0.5) * (ruin || damaged ? 0.4 : 0.05);
    sub.add(s);
    if (!ruin) sub.add(cone(r, 0.18, k.log, x, h, z, 7));
  };
  const rows = double ? [-0.15, 0.15] : [0];
  for (const z of rows) stake(g, 0, z);
  if (double && !ruin) {
    g.add(box(0.3, 0.55, 0.3, k.earth, 0, 0, 0));
    g.add(box(0.34, 0.04, 0.34, k.planks, 0, 0.78, 0));
  }
  for (const l of linksOrDefault(c)) {
    along(g, l, (sub, len) => {
      const n = Math.max(1, Math.round(len * 6));
      for (const z of rows) for (let i = 0; i < n; i++) stake(sub, ((i + 0.5) * len) / n, z);
      if (ruin) return;
      if (double) {
        // Riempimento di terra tra le due file e ballatoio in cima
        sub.add(box(len, 0.55, 0.26, k.earth, len / 2, 0, 0));
        sub.add(box(len, 0.04, 0.3, k.planks, len / 2, 0.78, 0));
        sub.add(box(len, 0.06, 0.05, k.beam, len / 2, 0.7, 0.2));
        sub.add(box(len, 0.06, 0.05, k.beam, len / 2, 0.7, -0.2));
        return;
      }
      sub.add(box(len, 0.06, 0.05, k.beam, len / 2, 0.7, 0.1));
      if (has(c, 'earthbank')) {
        const bank = box(len, 0.28, 0.42, k.earth, len / 2, -0.05, 0);
        sub.add(bank);
        sub.add(box(len, 0.06, 0.3, k.grassMound, len / 2, 0.22, 0));
      }
      if (has(c, 'walkway_wood')) {
        sub.add(box(len, 0.04, 0.24, k.planks, len / 2, 0.6, 0.2));
        sub.add(box(0.04, 0.6, 0.04, k.beam, len / 2, 0, 0.3));
      }
    });
  }
  if (ruin || damaged) rubble(g, (c.seed ?? 1) + 3, ruin ? 6 : 2, k.log, 0.4);
}

// ───────────── Mura in pietra ─────────────

export type WallStyle = 'rubble' | 'mortar' | 'curtain' | 'bastion';

const WALL_STYLES: Record<WallStyle, { W: number; H: number; batter: number; batterH: number }> = {
  rubble: { W: 0.5, H: 1.05, batter: 0.14, batterH: 0.3 },
  mortar: { W: 0.5, H: 1.35, batter: 0.12, batterH: 0.25 },
  curtain: { W: 0.58, H: 1.7, batter: 0.4, batterH: 0.6 },
  bastion: { W: 0.72, H: 1.55, batter: 0.55, batterH: 0.85 },
};

export function stoneWall(g: G, c: ModelCtx, style: WallStyle = 'mortar') {
  const k = mats();
  const ruin = c.state === 'ruin';
  const damaged = c.state === 'damaged';
  const rand = mulberry32(c.seed ?? 1);
  const thick = has(c, 'thicken');
  const walk = has(c, 'walkway');
  const hoard = has(c, 'hoarding_wall');
  const S = WALL_STYLES[style];
  const rough = style === 'rubble';
  const body = rough ? k.stoneDark : k.stone;
  const W = S.W + (thick ? 0.16 : 0);
  const H = ruin ? 0.45 + rand() * 0.25 : S.H + (walk && style === 'mortar' ? 0.15 : 0);
  // Pilastro centrale (giunto)
  g.add(box(W + 0.12, H + (ruin ? 0 : 0.15), W + 0.12, body, 0, 0, 0));
  g.add(box(W + 0.12 + S.batter, S.batterH, W + 0.12 + S.batter, k.stoneDark, 0, 0, 0));
  if (!ruin && !rough) crenels(g, W + 0.12, W + 0.12, H + 0.15, k.stoneLight, style === 'bastion' ? 0.15 : 0.11, 0.17);
  if (!ruin && rough) g.add(box(W + 0.1, 0.04, W + 0.1, k.planks, 0, H + 0.15, 0));
  for (const l of linksOrDefault(c)) {
    // Lato esterno nel sistema locale del segmento (z locale = (sinθ, cosθ) nel mondo)
    const th = Math.atan2(-l.dz, l.dx);
    const o = c.outDir;
    const out = o ? (o[0] * Math.sin(th) + o[1] * Math.cos(th) >= 0 ? 1 : -1) : -1;
    along(g, l, (sub, len) => {
      const h = ruin ? H * (0.6 + rand() * 0.5) : H;
      sub.add(box(len, h, W, body, len / 2, 0, 0));
      // Scarpa alla base (molto pronunciata nella cortina e nelle mura bastionate)
      sub.add(box(len, S.batterH, W + S.batter + (thick ? 0.1 : 0), k.stoneDark, len / 2, 0, 0));
      if (S.batter > 0.3) sub.add(box(len, S.batterH * 0.5, W + S.batter * 1.5, k.stoneDark, len / 2, 0, 0));
      if (thick && S.batter < 0.3) sub.add(box(len, 0.5, W + 0.12, k.stoneDark, len / 2, 0, 0));
      if (ruin) return;
      if (rough) {
        // Pietrame: blocchi irregolari in facciata e parapetto di tavole
        for (let i = 0; i < Math.round(len * 5); i++) {
          const bx = rand() * len;
          const by = 0.25 + rand() * (h - 0.4);
          sub.add(box(0.14 + rand() * 0.1, 0.09 + rand() * 0.06, W + 0.03, rand() < 0.5 ? k.stone : k.stoneDark, bx, by, 0));
        }
        sub.add(box(len, 0.22, 0.05, k.darkPlanks, len / 2, h, out * (W / 2 - 0.03)));
        sub.add(box(len, 0.03, W - 0.1, k.planks, len / 2, h - 0.02, 0));
        for (let i = 0; i <= Math.round(len * 3); i++) sub.add(box(0.04, 0.3, 0.04, k.beam, (i * len) / Math.max(1, Math.round(len * 3)), h - 0.05, out * (W / 2 - 0.03)));
        return;
      }
      sub.add(box(len, 0.05, W + 0.04, k.stoneLight, len / 2, h - 0.05, 0));
      if (style !== 'mortar') sub.add(box(len, 0.06, W + 0.06, k.stoneLight, len / 2, S.batterH, 0));
      const n = Math.max(1, Math.round(len * 3.2));
      for (let i = 0; i < n; i++) {
        if (damaged && rand() < 0.4) continue;
        const t = ((i + 0.5) * len) / n;
        // Merli sul lato esterno; con il cammino di ronda anche parapetto interno basso
        sub.add(box(0.13, 0.2, 0.1, k.stoneLight, t, h, out * (W / 2 - 0.05)));
        sub.add(box(0.13, walk ? 0.1 : 0.2, 0.1, k.stoneLight, t, h, -out * (W / 2 - 0.05)));
      }
      if (walk) {
        // Camminamento lastricato e accesso con scaletta
        sub.add(box(len, 0.02, W - 0.2, k.stoneDark, len / 2, h - 0.01, 0));
      }
      if (hoard) {
        const side = out;
        sub.add(box(len, 0.3, 0.2, k.darkPlanks, len / 2, h + 0.05, side * (W / 2 + 0.06)));
        sub.add(box(len + 0.02, 0.04, 0.32, k.planks, len / 2, h + 0.35, side * (W / 2 + 0.02)));
        for (let i = 0; i <= Math.round(len * 3); i++) {
          sub.add(box(0.03, 0.15, 0.12, k.beam, (i * len) / Math.max(1, Math.round(len * 3)), h - 0.12, side * (W / 2 + 0.06)));
        }
      }
    });
  }
  if (damaged || ruin) rubble(g, (c.seed ?? 1) + 7, ruin ? 9 : 3, k.stone, 0.5);
}

// ───────────── Torri ─────────────

function hoardingRing(g: G, r: number, y: number, round: boolean) {
  const k = mats();
  if (round) {
    g.add(cyl(r + 0.1, r + 0.1, 0.32, k.darkPlanks, 0, y, 0, 16));
    g.add(cone(r + 0.2, 0.35, k.planks, 0, y + 0.32, 0, 16));
  } else {
    g.add(box(r * 2 + 0.2, 0.32, r * 2 + 0.2, k.darkPlanks, 0, y, 0));
    g.add(hipRoof(r * 2 + 0.4, r * 2 + 0.4, 0.4, k.planks, 0, y + 0.32, 0));
  }
}

export function towerWood(g: G, c: ModelCtx) {
  const k = mats();
  const ruin = c.state === 'ruin';
  const legs: Array<[number, number]> = [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]];
  for (const [x, z] of legs) g.add(cyl(0.07, 0.08, ruin ? 0.9 : 2.4, k.log, x, 0, z, 7));
  if (ruin) {
    rubble(g, c.seed ?? 3, 10, k.log, 0.8);
    return;
  }
  for (const [ax, az, rot] of [[0, -0.6, 0], [0, 0.6, 0], [-0.6, 0, PI / 2], [0.6, 0, PI / 2]] as const) {
    for (const s of [-1, 1]) {
      const b = box(1.65, 0.05, 0.05, k.log, ax, 0, az);
      b.rotation.set(0, rot, s * 0.62);
      b.position.y = 1.05;
      g.add(b);
    }
  }
  g.add(box(1.55, 0.1, 1.55, k.planks, 0, 2.15, 0));
  for (const s of [-1, 1]) {
    g.add(box(1.55, 0.45, 0.06, k.darkPlanks, 0, 2.25, s * 0.75));
    g.add(box(0.06, 0.45, 1.55, k.darkPlanks, s * 0.75, 2.25, 0));
  }
  for (const [x, z] of legs) g.add(box(0.06, 0.75, 0.06, k.log, x, 2.25, z));
  if (has(c, 'hoarding')) {
    g.add(box(1.85, 0.3, 1.85, k.darkPlanks, 0, 2.6, 0));
    g.add(hipRoof(2.0, 2.0, 0.85, k.thatch, 0, 2.9, 0));
  } else {
    g.add(hipRoof(1.75, 1.75, 0.75, k.thatch, 0, 3.0, 0));
  }
  const ladder = new THREE.Group();
  for (const s of [-0.1, 0.1]) ladder.add(box(0.03, 2.3, 0.03, k.planks, s, 0, 0));
  for (let i = 1; i < 11; i++) ladder.add(box(0.2, 0.02, 0.02, k.planks, 0, i * 0.2, 0));
  ladder.position.set(0.2, 0, 0.95);
  ladder.rotation.x = -0.18;
  g.add(ladder);
}

export function towerSquare(g: G, c: ModelCtx) {
  const k = mats();
  const ruin = c.state === 'ruin';
  const thick = has(c, 'thicken');
  const s = thick ? 1.72 : 1.6;
  const H = ruin ? 1.2 : 3.1;
  g.add(box(s + 0.18, thick ? 0.6 : 0.35, s + 0.18, k.stoneDark, 0, 0, 0));
  g.add(box(s, H, s, k.stone, 0, 0.2, 0));
  if (ruin) {
    rubble(g, c.seed ?? 5, 14, k.stone, 0.9);
    return;
  }
  g.add(box(s + 0.06, 0.05, s + 0.06, k.stoneLight, 0, 1.7, 0));
  if (has(c, 'machicolation')) corbels(g, s, s, 3.15, k.stoneDark);
  g.add(box(s + 0.16, 0.12, s + 0.16, k.stoneDark, 0, 3.25, 0));
  if (has(c, 'hoarding')) hoardingRing(g, s / 2 + 0.05, 3.37, false);
  else if (has(c, 'tower_roof')) {
    crenels(g, s + 0.16, s + 0.16, 3.37, k.stoneLight, 0.15, 0.22);
    g.add(hipRoof(s + 0.3, s + 0.3, 1.0, k.roofTile, 0, 3.6, 0));
  } else crenels(g, s + 0.16, s + 0.16, 3.37, k.stoneLight, 0.15, 0.22);
  for (const [fx, fz, r] of [[0, s / 2 + 0.01, 0], [0, -s / 2 - 0.01, PI], [s / 2 + 0.01, 0, PI / 2], [-s / 2 - 0.01, 0, -PI / 2]] as const) {
    for (const y of [0.9, 2.3]) g.add(slit(fx, y, fz, 0.06, 0.28, r));
  }
  if (c.state === 'damaged') rubble(g, c.seed ?? 5, 5, k.stone, 0.9);
  g.add(flag(k.flag, 0.5, has(c, 'tower_roof') || has(c, 'hoarding') ? 4.4 : 3.37, 0.5));
}

export function towerRound(g: G, c: ModelCtx) {
  const k = mats();
  const ruin = c.state === 'ruin';
  const thick = has(c, 'thicken');
  const r = thick ? 0.88 : 0.8;
  const H = ruin ? 1.3 : 3.4;
  g.add(cyl(r + 0.08, r + 0.2, thick ? 0.7 : 0.45, k.stoneDark, 0, 0, 0, 18));
  g.add(cyl(r, r + 0.06, H, k.stone, 0, 0.3, 0, 18));
  if (ruin) {
    rubble(g, c.seed ?? 7, 14, k.stone, 0.9);
    return;
  }
  g.add(cyl(r + 0.04, r + 0.04, 0.05, k.stoneLight, 0, 1.8, 0, 18));
  if (has(c, 'machicolation')) {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * PI * 2;
      const cb = box(0.07, 0.12, 0.1, k.stoneDark, Math.cos(a) * (r + 0.05), 3.45, Math.sin(a) * (r + 0.05));
      cb.rotation.y = -a;
      g.add(cb);
    }
  }
  g.add(cyl(r + 0.12, r + 0.02, 0.18, k.stoneDark, 0, 3.55, 0, 18));
  if (has(c, 'hoarding')) hoardingRing(g, r + 0.02, 3.73, true);
  else {
    roundCrenels(g, r + 0.06, 3.73, k.stoneLight, 16);
    g.add(cone(r + 0.02, 1.1, k.roofTile, 0, 3.75, 0, 18));
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * PI * 2 + PI / 4;
    for (const y of [1.0, 2.5]) g.add(slit(Math.cos(a) * (r + 0.03), y, Math.sin(a) * (r + 0.03), 0.06, 0.28, -a + PI / 2));
  }
  if (c.state === 'damaged') rubble(g, c.seed ?? 7, 5, k.stone, 0.9);
}

/** Torrione: torre bassa e massiccia, scarpata, con cannoniere e piattaforma. */
export function towerBastion(g: G, c: ModelCtx) {
  const k = mats();
  const ruin = c.state === 'ruin';
  const r = 0.9;
  const H = ruin ? 1.0 : 2.5;
  g.add(cyl(r + 0.02, r + 0.12, 1.0, k.stoneDark, 0, 0, 0, 22));
  g.add(cyl(r, r + 0.02, H, k.stone, 0, 0.2, 0, 22));
  if (ruin) {
    rubble(g, c.seed ?? 9, 16, k.stone, 0.95);
    return;
  }
  g.add(cyl(r + 0.05, r + 0.05, 0.07, k.stoneLight, 0, 1.0, 0, 22));
  // Cannoniere e feritoie su due ordini
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * PI * 2;
    const gp = box(0.16, 0.12, 0.08, k.dark, Math.cos(a) * (r + 0.01), 1.3, Math.sin(a) * (r + 0.01));
    gp.rotation.y = -a + PI / 2;
    g.add(gp);
    const a2 = a + PI / 6;
    g.add(slit(Math.cos(a2) * (r + 0.02), 2.0, Math.sin(a2) * (r + 0.02), 0.06, 0.24, -a2 + PI / 2));
  }
  if (has(c, 'machicolation')) {
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * PI * 2;
      const cb = box(0.07, 0.12, 0.1, k.stoneDark, Math.cos(a) * (r + 0.06), 2.58, Math.sin(a) * (r + 0.06));
      cb.rotation.y = -a;
      g.add(cb);
    }
  }
  g.add(cyl(r + 0.12, r + 0.04, 0.16, k.stoneDark, 0, 2.7, 0, 22));
  if (has(c, 'hoarding')) hoardingRing(g, r + 0.04, 2.86, true);
  else roundCrenels(g, r + 0.07, 2.86, k.stoneLight, 20);
  // Piattaforma con una macchina da lancio
  g.add(cyl(r - 0.05, r - 0.05, 0.04, k.planks, 0, 2.84, 0, 22));
  g.add(box(0.34, 0.16, 0.5, k.darkPlanks, 0.1, 2.88, 0));
  const arm = box(0.05, 0.05, 0.7, k.log, 0.1, 3.1, 0);
  arm.rotation.x = 0.5;
  g.add(arm);
  if (c.state === 'damaged') rubble(g, c.seed ?? 9, 6, k.stone, 0.95);
  g.add(flag(k.flag, 0, 2.86, 0, 0.45));
}

// ───────────── Impalcature dei cantieri ─────────────

/**
 * Trasforma il modello di un edificio in cantiere: la struttura cresce con lo stadio
 * dei lavori (0-3), circondata da impalcature e materiali. Con `site` assente
 * aggiunge solo le impalcature (lavori su un edificio finito).
 */
export function scaffold(g: G, w: number, d: number, site: number | undefined, stone: boolean, seed: number) {
  const k = mats();
  const rand = mulberry32(seed);
  g.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(g);
  const fullH = Math.max(0.1, bounds.max.y);
  const frac = site === undefined ? 1 : 0.15 + site * 0.22;
  if (site !== undefined) {
    // La struttura non è ancora finita: si mostra solo fino all'altezza raggiunta
    const sub = new THREE.Group();
    for (const ch of [...g.children]) sub.add(ch);
    sub.scale.y = frac;
    g.add(sub);
    // Niente bandiere né fumo sui cantieri
    sub.traverse((o) => {
      if (o.userData.flag || o.userData.smoke || o.userData.wander) o.visible = false;
    });
    // Tracciato delle fondamenta
    g.add(box(w * 0.98, 0.04, d * 0.98, stone ? k.stoneDark : k.earth, 0, 0, 0));
  }
  if (fullH < 0.35) {
    // Edifici bassi (campi, recinti, strade): solo picchetti e corde
    for (const [x, z] of [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2]]) g.add(box(0.04, 0.3, 0.04, k.planks, x * 0.95, 0, z * 0.95));
    return;
  }
  const h = fullH * frac + 0.25;
  const hw = w / 2 + 0.06;
  const hd = d / 2 + 0.06;
  const poles: Array<[number, number]> = [];
  const nx = Math.max(1, Math.round(w * 1.5));
  const nz = Math.max(1, Math.round(d * 1.5));
  for (let i = 0; i <= nx; i++) for (const z of [-hd, hd]) poles.push([-hw + (i * 2 * hw) / nx, z]);
  for (let i = 1; i < nz; i++) for (const x of [-hw, hw]) poles.push([x, -hd + (i * 2 * hd) / nz]);
  for (const [x, z] of poles) g.add(cyl(0.025, 0.03, h, k.log, x, 0, z, 5));
  for (let y = 0.45; y < h; y += 0.5) {
    g.add(box(hw * 2, 0.03, 0.12, k.planks, 0, y, -hd));
    g.add(box(hw * 2, 0.03, 0.12, k.planks, 0, y, hd));
    g.add(box(0.12, 0.03, hd * 2, k.planks, -hw, y, 0));
    g.add(box(0.12, 0.03, hd * 2, k.planks, hw, y, 0));
  }
  // Materiali ammucchiati accanto al cantiere
  if (site !== undefined && w * d >= 2) {
    for (let i = 0; i < 4; i++) {
      const s = 0.08 + rand() * 0.06;
      const m = stone ? (rand() < 0.5 ? k.stoneLight : k.stone) : k.log;
      g.add(box(s * 1.5, s, s, m, (rand() - 0.5) * w * 0.6, 0, d / 2 - 0.2 + rand() * 0.1));
    }
  }
}

// ───────────── Porte ─────────────

/** Calderone della pece sopra la porta, con fuoco e fumo. */
function pitchCauldron(g: G, x: number, y: number, z: number) {
  const k = mats();
  for (const a of [0, 2.1, 4.2]) {
    const leg = box(0.02, 0.22, 0.02, k.iron, x + Math.cos(a) * 0.08, y, z + Math.sin(a) * 0.08);
    leg.rotation.z = Math.cos(a) * 0.2;
    g.add(leg);
  }
  g.add(cyl(0.09, 0.06, 0.1, k.iron, x, y + 0.12, z, 10));
  g.add(cyl(0.08, 0.08, 0.01, k.dark, x, y + 0.215, z, 10));
  const fire = box(0.1, 0.06, 0.1, k.fire, x, y, z);
  fire.castShadow = false;
  g.add(fire);
  g.add(smoke(x, y + 0.25, z, 4, 0.7));
}

/** Ponte levatoio abbassato verso il fossato, con catene. */
function drawbridge(g: G, dir: [number, number], wid: number, from: number) {
  const k = mats();
  const sub = new THREE.Group();
  sub.rotation.y = Math.atan2(-dir[1], dir[0]);
  sub.add(box(1.0, 0.05, wid, k.planks, from + 0.5, 0.02, 0));
  for (const s of [-1, 1]) {
    const ch = cyl(0.008, 0.008, 1.25, k.iron, 0, 0, 0, 3);
    ch.geometry.translate(0, -0.625, 0);
    ch.rotation.z = -0.9;
    ch.position.set(from, 1.05, s * (wid / 2 - 0.03));
    sub.add(ch);
  }
  g.add(sub);
}

/**
 * Orientamento della porta: lungo le mura collegate. Con mura solo in diagonale
 * la porta si gira di 45°.
 */
function gateAngle(c: ModelCtx): number {
  const l = c.links ?? [];
  const x = l.some((v) => v.dz === 0 && v.dx !== 0);
  const z = l.some((v) => v.dx === 0 && v.dz !== 0);
  if (x || !l.length) return 0;
  if (z) return PI / 2;
  const d = l[0];
  // Direzione della diagonale (stessa per i due versi)
  return d.dx * d.dz > 0 ? -PI / 4 : PI / 4;
}

/** Tratti di raccordo dalla porta verso le mura che non sono in asse con essa. */
function gateStubs(g: G, c: ModelCtx, angle: number, stone: boolean) {
  const k = mats();
  for (const l of c.links ?? []) {
    const a = Math.atan2(-l.dz, l.dx);
    if (Math.abs(Math.cos(a - angle)) > 0.98) continue; // in asse: la porta stessa fa da muro
    along(g, l, (sub, len) => {
      const from = 0.28;
      const L = len - from;
      if (stone) {
        sub.add(box(L, 1.5, 0.5, k.stone, from + L / 2, 0, 0));
        sub.add(box(L, 0.25, 0.62, k.stoneDark, from + L / 2, 0, 0));
        for (let i = 0; i < Math.max(1, Math.round(L * 3)); i++) {
          for (const s of [-0.2, 0.2]) sub.add(box(0.12, 0.19, 0.1, k.stoneLight, from + (i + 0.5) * (L / Math.max(1, Math.round(L * 3))), 1.5, s));
        }
      } else {
        const n = Math.max(1, Math.round(L * 6));
        for (let i = 0; i < n; i++) {
          const t = from + (i + 0.5) * (L / n);
          sub.add(cyl(0.08, 0.09, 1.1, k.log, t, 0, 0, 7));
          sub.add(cone(0.08, 0.18, k.log, t, 1.1, 0, 7));
        }
      }
    });
  }
}

export function gateWood(g: G, c: ModelCtx) {
  const k = mats();
  const inner = new THREE.Group();
  const ruin = c.state === 'ruin';
  for (const s of [-1, 1]) {
    inner.add(cyl(0.1, 0.11, ruin ? 0.7 : 1.9, k.log, s * 0.43, 0, 0, 7));
    if (!ruin) inner.add(cone(0.1, 0.15, k.log, s * 0.43, 1.9, 0, 7));
  }
  if (!ruin) {
    inner.add(box(1.05, 0.12, 0.22, k.log, 0, 1.45, 0));
    inner.add(box(1.0, 0.05, 0.3, k.planks, 0, 1.57, 0));
    for (const s of [-1, 1]) {
      const leaf = new THREE.Group();
      leaf.add(box(0.36, 1.2, 0.06, k.darkPlanks, -s * 0.18, 0, 0));
      for (const y of [0.25, 0.95]) leaf.add(box(0.34, 0.04, 0.07, k.iron, -s * 0.18, y, 0));
      leaf.position.x = s * 0.36;
      leaf.rotation.y = s * -0.25;
      inner.add(leaf);
    }
    if (has(c, 'pitch')) pitchCauldron(inner, 0.2, 1.62, 0);
  } else rubble(inner, c.seed ?? 2, 6, k.log, 0.4);
  const angle = gateAngle(c);
  inner.rotation.y = angle;
  g.add(inner);
  if (!ruin) gateStubs(g, c, angle, false);
  if (has(c, 'drawbridge') && c.moatDir && !ruin) drawbridge(g, c.moatDir, 0.7, 0.1);
}

/** Porta ferrata: piloni in pietrame, battenti di quercia con bande di ferro e tettoia. */
export function gateStrong(g: G, c: ModelCtx) {
  const k = mats();
  const inner = new THREE.Group();
  const ruin = c.state === 'ruin';
  for (const s of [-1, 1]) {
    inner.add(box(0.26, ruin ? 0.6 : 1.75, 0.34, k.stoneDark, s * 0.44, 0, 0));
    if (!ruin) inner.add(box(0.3, 0.08, 0.38, k.stone, s * 0.44, 1.75, 0));
  }
  if (!ruin) {
    inner.add(box(1.15, 0.14, 0.3, k.log, 0, 1.5, 0));
    inner.add(box(1.1, 0.05, 0.4, k.planks, 0, 1.64, 0));
    inner.add(gableRoof(1.2, 0.5, 0.32, k.shingle, k.darkPlanks, 0, 1.69, 0, 0.05));
    for (const s of [-1, 1]) {
      const leaf = new THREE.Group();
      leaf.add(box(0.33, 1.3, 0.08, k.darkPlanks, -s * 0.165, 0, 0));
      for (const y of [0.15, 0.6, 1.05]) leaf.add(box(0.31, 0.05, 0.09, k.iron, -s * 0.165, y, 0));
      leaf.position.x = s * 0.33;
      leaf.rotation.y = s * -0.2;
      inner.add(leaf);
    }
    if (has(c, 'portcullis')) inner.add(box(0.7, 0.9, 0.04, k.iron, 0, 0.55, 0.12));
    if (has(c, 'pitch')) pitchCauldron(inner, 0.2, 1.68, 0);
  } else rubble(inner, c.seed ?? 2, 7, k.stoneDark, 0.4);
  const angle = gateAngle(c);
  inner.rotation.y = angle;
  g.add(inner);
  if (!ruin) gateStubs(g, c, angle, false);
  if (has(c, 'drawbridge') && c.moatDir && !ruin) drawbridge(g, c.moatDir, 0.7, 0.1);
}

export function gateStone(g: G, c: ModelCtx) {
  const k = mats();
  const inner = new THREE.Group();
  const ruin = c.state === 'ruin';
  for (const s of [-1, 1]) {
    inner.add(box(0.32, ruin ? 0.8 : 1.9, 0.75, k.stone, s * 0.34, 0, 0));
    inner.add(box(0.36, 0.25, 0.8, k.stoneDark, s * 0.34, 0, 0));
  }
  if (ruin) {
    rubble(inner, c.seed ?? 4, 10, k.stone, 0.45);
  } else {
    inner.add(box(1, 0.6, 0.75, k.stone, 0, 1.3, 0));
    if (has(c, 'machicolation')) corbels(inner, 1, 0.75, 1.75, k.stoneDark);
    crenels(inner, 1, 0.75, 1.9, k.stoneLight, 0.12, 0.18);
    for (const s of [-1, 1]) {
      const arch = cyl(0.19, 0.19, 0.04, k.dark, 0, 0, 0, 12);
      arch.rotation.x = PI / 2;
      arch.position.set(0, 1.12, s * 0.38);
      inner.add(arch);
    }
    if (has(c, 'portcullis')) {
      for (let i = -2; i <= 2; i++) inner.add(box(0.02, 1.1, 0.02, k.iron, i * 0.075, 0.25, 0.3));
      for (const y of [0.45, 0.8, 1.1]) inner.add(box(0.36, 0.02, 0.02, k.iron, 0, y, 0.3));
    } else {
      inner.add(box(0.36, 1.1, 0.05, k.darkPlanks, 0, 0, 0));
    }
    if (has(c, 'pitch')) pitchCauldron(inner, 0.25, 1.9, 0);
  }
  const angle = gateAngle(c);
  inner.rotation.y = angle;
  g.add(inner);
  if (!ruin) gateStubs(g, c, angle, true);
  if (has(c, 'drawbridge') && c.moatDir && !ruin) drawbridge(g, c.moatDir, 0.42, 0.38);
}

export function gatehouse(g: G, c: ModelCtx) {
  const k = mats();
  const ruin = c.state === 'ruin';
  const thick = has(c, 'thicken');
  for (const s of [-1, 1]) {
    g.add(cyl(0.5, 0.58, thick ? 0.6 : 0.35, k.stoneDark, s * 0.6, 0, 0, 14));
    g.add(cyl(0.48, 0.52, ruin ? 1.0 : 3.0, k.stone, s * 0.6, 0.2, 0, 14));
    if (ruin) continue;
    g.add(cyl(0.56, 0.5, 0.14, k.stoneDark, s * 0.6, 3.2, 0, 14));
    roundCrenels(g, 0.52, 3.34, k.stoneLight, 12, s * 0.6, 0);
    g.add(cone(0.5, 0.75, k.roofTile, s * 0.6, 3.38, 0, 14));
    for (const y of [1.0, 2.2]) g.add(slit(s * 0.6, y, 0.51, 0.06, 0.26));
  }
  if (ruin) {
    rubble(g, c.seed ?? 9, 14, k.stone, 0.9);
    return;
  }
  g.add(box(0.9, 2.7, 1.4, k.stone, 0, 0, 0));
  if (has(c, 'machicolation')) corbels(g, 0.9, 1.4, 2.6, k.stoneDark);
  crenels(g, 0.96, 1.46, 2.7, k.stoneLight, 0.13, 0.2);
  for (const s of [-1, 1]) {
    g.add(box(0.46, 1.2, 0.04, k.dark, 0, 0, s * 0.71));
    const arch = cyl(0.23, 0.23, 0.04, k.dark, 0, 0, 0, 12);
    arch.rotation.x = PI / 2;
    arch.position.set(0, 1.2, s * 0.71);
    g.add(arch);
  }
  for (let i = -2; i <= 2; i++) g.add(box(0.025, 1.0, 0.025, k.iron, i * 0.09, 0.35, 0.74));
  for (const y of [0.6, 1.0]) g.add(box(0.44, 0.025, 0.025, k.iron, 0, y, 0.74));
  g.add(archWindow(0, 1.8, 0.71, 0.16, 0.35));
  if (has(c, 'pitch')) pitchCauldron(g, 0.2, 2.7, 0.3);
  if (c.state === 'damaged') rubble(g, c.seed ?? 9, 6, k.stone, 0.9);
  g.add(flag(k.flag, 0, 2.9, -0.3, 0.42));
  if (has(c, 'drawbridge') && c.moatDir) drawbridge(g, c.moatDir, 0.5, 0.95);
}

// ───────────── Masti ─────────────

function cisternWell(g: G, x: number, z: number) {
  const k = mats();
  g.add(cyl(0.14, 0.15, 0.18, k.stone, x, 0, z, 12));
  g.add(cyl(0.1, 0.1, 0.01, k.water, x, 0.16, z, 12));
  for (const s of [-1, 1]) g.add(box(0.025, 0.36, 0.025, k.beam, x + s * 0.13, 0.18, z));
  g.add(box(0.3, 0.025, 0.025, k.beam, x, 0.52, z));
}

function armoryRack(g: G, x: number, z: number) {
  const k = mats();
  g.add(box(0.4, 0.04, 0.04, k.beam, x, 0.3, z));
  for (let i = 0; i < 4; i++) {
    g.add(cyl(0.01, 0.01, 0.55, k.planks, x - 0.15 + i * 0.1, 0, z - 0.03, 4));
    g.add(cone(0.02, 0.06, k.iron, x - 0.15 + i * 0.1, 0.55, z - 0.03, 4));
  }
  g.add(flag(k.flagGold, x + 0.28, 0, z, 0.3));
}

export function keepWood(g: G, c: ModelCtx) {
  const k = mats();
  const ruin = c.state === 'ruin';
  g.add(cyl(0.95, 1.45, 0.85, k.grassMound, 0, 0, 0, 18));
  const ramp = box(0.3, 0.06, 1.0, k.planks, 0.9, 0.38, 0.65);
  ramp.rotation.x = 0.55;
  ramp.rotation.y = -0.6;
  g.add(ramp);
  const rand = mulberry32(c.seed ?? 1);
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * PI * 2;
    if (i === 3 || (ruin && rand() < 0.6)) continue;
    const h = 0.42 + rand() * 0.1;
    g.add(cyl(0.045, 0.05, h, k.log, Math.cos(a) * 0.9, 0.85, Math.sin(a) * 0.9, 6));
    g.add(cone(0.045, 0.08, k.log, Math.cos(a) * 0.9, 0.85 + h, Math.sin(a) * 0.9, 6));
  }
  if (ruin) {
    g.add(box(1.0, 0.5, 1.0, k.darkPlanks, 0, 0.85, 0));
    rubble(g, c.seed ?? 1, 10, k.log, 0.6);
    return;
  }
  g.add(box(1.0, 1.1, 1.0, k.planks, 0, 0.85, 0));
  for (const [cx, cz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) g.add(box(0.08, 1.9, 0.08, k.log, cx * 0.5, 0.85, cz * 0.5));
  g.add(box(1.25, 0.08, 1.25, k.beam, 0, 1.95, 0));
  g.add(box(1.2, 0.5, 1.2, k.darkPlanks, 0, 2.0, 0));
  for (let i = -1; i <= 1; i++) {
    g.add(slit(i * 0.35, 2.15, 0.61));
    g.add(slit(i * 0.35, 2.15, -0.61));
  }
  for (let i = 0; i < 10; i++) {
    const t = -0.55 + i * 0.122;
    for (const s of [-1, 1]) {
      const cb = box(0.04, 0.08, 0.12, k.beam, t, 1.88, s * 0.58);
      cb.rotation.x = s * 0.6;
      g.add(cb);
    }
  }
  g.add(hipRoof(1.55, 1.55, 0.9, k.thatch, 0, 2.5, 0));
  const dr = new THREE.Group();
  door(dr, 0, 0.51, 0, 0.2, 0.36);
  dr.position.y = 0.85;
  g.add(dr);
  if (has(c, 'cistern')) cisternWell(g, -1.15, 1.15);
  if (has(c, 'armory')) armoryRack(g, 1.0, -1.25);
  if (has(c, 'bailey')) {
    // Livello 2: sala e stalla nel cortile ai piedi della motta
    g.add(box(0.75, 0.38, 0.42, k.planks, 1.0, 0, 1.15));
    g.add(gableRoof(0.8, 0.42, 0.3, k.thatch, k.planks, 1.0, 0.38, 1.15, 0.06));
    g.add(box(0.5, 0.3, 0.36, k.darkPlanks, -1.15, 0, -1.05));
    g.add(gableRoof(0.55, 0.36, 0.22, k.thatch, k.darkPlanks, -1.15, 0.3, -1.05, 0.05));
    for (let i = 0; i < 6; i++) g.add(cyl(0.035, 0.04, 0.4, k.log, -1.45 + i * 0.12, 0, 1.45, 5));
    g.add(flag(k.flag, 1.3, 0.38, 1.3, 0.25));
  }
  g.add(flag(k.flag, 0, 3.35, 0, 0.4));
  if (c.state === 'damaged') rubble(g, c.seed ?? 1, 5, k.log, 1.2);
}

export function keepStone(g: G, c: ModelCtx) {
  const k = mats();
  const ruin = c.state === 'ruin';
  const thick = has(c, 'thicken');
  g.add(box(thick ? 2.7 : 2.5, thick ? 0.8 : 0.45, thick ? 2.7 : 2.5, k.stoneDark, 0, 0, 0));
  const H = ruin ? 1.6 : 3.9;
  g.add(box(2.2, H, 2.2, k.stone, 0, 0.3, 0));
  if (ruin) {
    rubble(g, c.seed ?? 11, 18, k.stone, 1.3);
    return;
  }
  for (const s of [-1, 1]) {
    g.add(box(0.2, 3.9, 0.08, k.stone, 0, 0.3, s * 1.12));
    g.add(box(0.08, 3.9, 0.2, k.stone, s * 1.12, 0.3, 0));
  }
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const turret = new THREE.Group();
    turret.position.set(x * 1.02, 0, z * 1.02);
    turret.add(box(0.5, 4.75, 0.5, k.stone, 0, 0, 0));
    crenels(turret, 0.5, 0.5, 4.75, k.stoneLight, 0.1, 0.14);
    g.add(turret);
  }
  for (const y of [1.6, 3.2]) g.add(box(2.26, 0.06, 2.26, k.stoneLight, 0, y, 0));
  g.add(box(2.3, 0.1, 2.3, k.stoneDark, 0, 4.2, 0));
  if (has(c, 'machicolation')) corbels(g, 2.2, 2.2, 4.1, k.stoneDark);
  crenels(g, 2.3, 2.3, 4.3, k.stoneLight, 0.15, 0.2);
  g.add(hipRoof(1.6, 1.6, 0.45, k.darkPlanks, 0, 4.3, 0));
  const faces: Array<[number, number, number]> = [[0, 1.11, 0], [0, -1.11, PI], [1.11, 0, PI / 2], [-1.11, 0, -PI / 2]];
  for (const [fx, fz, r] of faces) {
    for (const off of [-0.45, 0.45]) {
      const ox = fx === 0 ? off : fx;
      const oz = fz === 0 ? off : fz;
      g.add(archWindow(ox, 2.2, oz, 0.14, 0.32, r));
      g.add(archWindow(ox, 3.5, oz, 0.16, 0.36, r));
      g.add(slit(ox, 1.0, oz, 0.05, 0.25, r));
    }
  }
  g.add(box(0.6, 1.5, 0.5, k.stone, 0.55, 0, 1.3));
  const stair = box(0.32, 0.08, 1.0, k.stoneDark, -0.3, 0.6, 1.5);
  stair.rotation.x = -0.8;
  g.add(stair);
  g.add(archWindow(0.55, 0.0, 1.56, 0.22, 0.45, 0));
  const ch = new THREE.Group();
  ch.add(box(0.12, 0.4, 0.12, k.stone, -0.7, 4.3, -0.5));
  ch.add(smoke(-0.7, 4.75, -0.5, 4, 0.8));
  g.add(ch);
  if (has(c, 'cistern')) cisternWell(g, -1.2, 1.2);
  if (has(c, 'armory')) armoryRack(g, 1.0, -1.32);
  if (c.state === 'damaged') rubble(g, c.seed ?? 11, 8, k.stone, 1.4);
  if (has(c, 'great_hall')) {
    // Livello 4: sala grande sul mastio (tetto a falde) e campanile della cappella
    g.add(box(1.7, 0.5, 1.2, k.stoneLight, 0, 4.3, 0.2));
    g.add(gableRoof(1.8, 1.2, 0.75, k.roofTile, k.stoneLight, 0, 4.8, 0.2, 0.1));
    for (const x of [-0.5, 0, 0.5]) g.add(archWindow(x, 4.4, 0.81, 0.12, 0.3, 0));
    g.add(box(0.28, 0.5, 0.28, k.stoneLight, -0.65, 4.8, -0.65));
    g.add(box(0.18, 0.22, 0.02, k.dark, -0.65, 4.95, -0.5));
    g.add(hipRoof(0.38, 0.38, 0.35, k.slate, -0.65, 5.3, -0.65));
    g.add(cyl(0.01, 0.01, 0.25, k.iron, -0.65, 5.65, -0.65, 4));
  }
  if (has(c, 'palace')) {
    // Livello 5: torrette più alte con tetti conici, loggia ad archi, stendardi dorati
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      g.add(cyl(0.24, 0.26, 1.0, k.stoneLight, x * 1.02, 4.75, z * 1.02, 12));
      g.add(cone(0.3, 0.7, k.slate, x * 1.02, 5.75, z * 1.02, 12));
      g.add(flag(k.flagGold, x * 1.02, 6.4, z * 1.02, 0.3));
    }
    for (const [fx, fz, r] of [[0, 1.12, 0], [0, -1.12, PI], [1.12, 0, PI / 2], [-1.12, 0, -PI / 2]] as const) {
      for (const off of [-0.6, -0.2, 0.2, 0.6]) g.add(archWindow(fx === 0 ? off : fx, 2.75, fz === 0 ? off : fz, 0.14, 0.34, r));
    }
  }
  g.add(flag(k.flagGold, 0.4, has(c, 'great_hall') ? 5.5 : 4.75, 0.4, 0.5));
}

// ───────────── Fossato ─────────────

/** Il fossato è scavato nel terreno dal renderer: qui solo i pali sul fondo. */
export function moat(g: G, c: ModelCtx) {
  if (!has(c, 'stakes')) return;
  const k = mats();
  const rand = mulberry32(c.seed ?? 1);
  const bottom = -(0.35 + 0.25 * ((c.depth ?? 1) - 1));
  for (let i = 0; i < 9; i++) {
    const x = -0.3 + (i % 3) * 0.3 + (rand() - 0.5) * 0.08;
    const z = -0.3 + Math.floor(i / 3) * 0.3 + (rand() - 0.5) * 0.08;
    const s = cone(0.035, 0.32, k.log, x, bottom, z, 5);
    s.rotation.set((rand() - 0.5) * 0.5, 0, (rand() - 0.5) * 0.5);
    g.add(s);
  }
}

// ───────────── Strade e ponti ─────────────

export function road(g: G, c: ModelCtx, paved: boolean) {
  const k = mats();
  const m = paved ? k.paving : k.road;
  const y = 0.004;
  const pad = cyl(0.3, 0.3, 0.025, m, 0, y, 0, 10);
  pad.castShadow = false;
  g.add(pad);
  for (const l of c.links ?? []) {
    along(g, l, (sub, len) => {
      const seg = box(len, 0.025, 0.5, m, len / 2, y, 0);
      seg.castShadow = false;
      sub.add(seg);
      if (paved) {
        for (const s of [-1, 1]) {
          const curb = box(len, 0.035, 0.05, k.stoneDark, len / 2, y, s * 0.25);
          curb.castShadow = false;
          sub.add(curb);
        }
      }
    });
  }
}

export function bridge(g: G, c: ModelCtx) {
  const k = mats();
  // Orientamento: lungo l'asse dei collegamenti (di default x)
  const l = c.links ?? [];
  const alongZ = l.some((v) => v.dx === 0) && !l.some((v) => v.dz === 0);
  const inner = new THREE.Group();
  inner.add(box(1.04, 0.06, 0.6, k.planks, 0, 0.05, 0));
  for (const s of [-1, 1]) {
    inner.add(box(1.04, 0.04, 0.04, k.beam, 0, 0.3, s * 0.28));
    for (const x of [-0.45, 0, 0.45]) inner.add(box(0.04, 0.26, 0.04, k.beam, x, 0.07, s * 0.28));
    for (const x of [-0.35, 0.35]) inner.add(cyl(0.05, 0.05, 0.7, k.log, x, -0.65, s * 0.22, 7));
  }
  if (alongZ) inner.rotation.y = PI / 2;
  g.add(inner);
  void sphere;
}
