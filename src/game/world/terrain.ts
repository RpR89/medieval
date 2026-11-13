import { mapSize, PRESETS, siteCenters, type PresetId } from './presets';

/** Generazione procedurale del territorio attorno al castello. */
export const MAP_SIZE = 64;

export enum Tile {
  Grass = 0,
  Forest = 1,
  Rock = 2,
  Gold = 3,
  River = 4,
  Sea = 5,
  Sand = 6,
}


export interface Terrain {
  size: number;
  seed: number;
  tiles: Uint8Array;
  preset: PresetId;
  /** Centri dei siti dei castelli (uno per giocatore). */
  sites: Array<[number, number]>;
  sea: 'east' | 'south' | 'none';
  /** Ampiezza delle colline, per la grafica. */
  hills: number;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeNoise(seed: number, cell: number) {
  const rand = mulberry32(seed);
  const grid = MAP_SIZE / cell + 2;
  const values = Array.from({ length: grid * grid }, () => rand());
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (x: number, z: number) => {
    const gx = x / cell;
    const gz = z / cell;
    const x0 = Math.floor(gx);
    const z0 = Math.floor(gz);
    const tx = smooth(gx - x0);
    const tz = smooth(gz - z0);
    const v = (i: number, j: number) => values[(j % grid) * grid + (i % grid)];
    const a = v(x0, z0) * (1 - tx) + v(x0 + 1, z0) * tx;
    const b = v(x0, z0 + 1) * (1 - tx) + v(x0 + 1, z0 + 1) * tx;
    return a * (1 - tz) + b * tz;
  };
}

export interface TerrainOptions {
  preset?: PresetId;
  /** Numero di siti di castelli (giocatori e signori). */
  players?: number;
}

export function generateTerrain(seed: number, opts: TerrainOptions | number = {}): Terrain {
  // Compatibilità: generateTerrain(seed, size)
  const o: TerrainOptions = typeof opts === 'number' ? {} : opts;
  const players = o.players ?? 1;
  const preset = PRESETS[o.preset ?? 'classica'];
  const size = typeof opts === 'number' ? opts : mapSize(players);
  const sites = siteCenters(size, players);
  const tiles = new Uint8Array(size * size).fill(Tile.Grass);
  const rand = mulberry32(seed ^ 0x9e3779b9);
  const n1 = makeNoise(seed + 1, 8);
  const n2 = makeNoise(seed + 2, 4);
  const set = (x: number, z: number, t: Tile) => {
    if (x >= 0 && z >= 0 && x < size && z < size) tiles[z * size + x] = t;
  };
  const get = (x: number, z: number) => tiles[z * size + x] as Tile;
  const siteDist = (x: number, z: number) => Math.min(...sites.map(([sx, sz]) => Math.hypot(x - sx, z - sz)));

  // Boschi, con una radura attorno a ogni sito di castello
  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      const dist = siteDist(x, z);
      const clear = dist < 13 ? 0.32 : dist < 16 ? 0.32 * (1 - (dist - 13) / 3) : 0;
      const f = n1(x, z) * 0.7 + n2(x, z) * 0.3 - clear;
      // Entro 10 caselle dal sito non c'è mai bosco, qualunque sia la mappa
      if (dist >= 10 && f > preset.forest) set(x, z, Tile.Forest);
    }
  }

  // Affioramenti rocciosi (lontani dai siti), alcuni con vena d'oro
  const blobs = preset.rocks[0] + Math.floor(rand() * (preset.rocks[1] - preset.rocks[0] + 1));
  const centers: Array<[number, number]> = [];
  for (let b = 0, tries = 0; b < blobs && tries < 200; tries++) {
    const [cx, cz] = sites[b % sites.length];
    const angle = rand() * Math.PI * 2;
    const r = 16 + rand() * 10;
    const bx = Math.round(cx + Math.cos(angle) * r);
    const bz = Math.round(cz + Math.sin(angle) * r);
    if (bx < 3 || bz < 3 || bx > size - 4 || bz > size - 4 || siteDist(bx, bz) < 15) continue;
    b++;
    centers.push([bx, bz]);
    const radius = preset.rockRadius * (0.75 + rand() * 0.6);
    const R = Math.ceil(radius + 2);
    for (let z = -R; z <= R; z++) {
      for (let x = -R; x <= R; x++) {
        if (Math.hypot(x, z) <= radius + (n2(bx + x, bz + z) - 0.5) * 1.5) set(bx + x, bz + z, Tile.Rock);
      }
    }
    if (b === 1 || rand() < preset.gold) {
      set(bx, bz, Tile.Gold);
      set(bx + 1, bz, Tile.Gold);
      if (rand() < 0.5) set(bx, bz + 1, Tile.Gold);
    }
  }

  // Mare con spiaggia
  if (preset.sea === 'east') {
    for (let z = 0; z < size; z++) {
      const coast = size - 6 + Math.round((n1(z * 1.7, 3) - 0.5) * 6);
      for (let x = coast - 1; x < size; x++) set(x, z, x === coast - 1 ? Tile.Sand : Tile.Sea);
    }
  } else if (preset.sea === 'south') {
    for (let x = 0; x < size; x++) {
      const coast = size - 6 + Math.round((n1(3, x * 1.7) - 0.5) * 6);
      for (let z = coast - 1; z < size; z++) set(x, z, z === coast - 1 ? Tile.Sand : Tile.Sea);
    }
  }

  // Fiume da nord a sud, che gira attorno ai siti dei castelli
  if (preset.river !== 'none') {
    const width = preset.river === 'wide' ? 4 : 2;
    let rx: number;
    let lo: number;
    let hi: number;
    if (players === 2) {
      // Tra i due castelli, a distanza dai siti
      const mid = size / 2 - width / 2;
      rx = Math.round(mid + (rand() - 0.5) * 4);
      lo = Math.round(mid - 6);
      hi = Math.round(mid + 6);
    } else {
      rx = Math.round(size / 2 - 18 + rand() * 6);
      lo = 3;
      hi = size - 4;
    }
    for (let z = 0; z < size; z++) {
      rx += Math.round((n2(z, 7) - 0.5) * 2.2);
      if (preset.sea === 'east' && z > size * 0.7) rx += 1; // piega verso il mare
      rx = Math.max(lo, Math.min(hi, rx));
      for (const [sx, sz] of sites) {
        if (Math.abs(z - sz) >= 14 || Math.abs(rx + width / 2 - sx) >= 14) continue;
        rx = rx + width / 2 < sx ? Math.round(sx - 14 - width) : Math.round(sx + 14);
        rx = Math.max(3, Math.min(size - 4 - width, rx));
      }
      for (let w = 0; w < width; w++) {
        if (get(rx + w, z) !== Tile.Sea) set(rx + w, z, Tile.River);
      }
      if (get(rx + width, z) === Tile.Sea || (preset.sea === 'south' && get(rx, Math.min(size - 1, z + 1)) === Tile.Sea)) break;
    }
  }

  // Ogni castello ha almeno una piccola cava nel suo territorio (pietra o ferro, a volte una vena d'oro):
  // le mappe possono essere più boscose o più rocciose, ma nessuno resta senza
  const rocky = (x: number, z: number) => {
    const t = get(x, z);
    return t === Tile.Rock || t === Tile.Gold;
  };
  for (const [sx, sz] of sites) {
    let ok = false;
    for (let z = Math.max(0, sz - 20); z < Math.min(size - 1, sz + 20) && !ok; z++) {
      for (let x = Math.max(0, sx - 20); x < Math.min(size - 1, sx + 20) && !ok; x++) {
        if (Math.hypot(x - sx, z - sz) < 11 || Math.hypot(x - sx, z - sz) > 20) continue;
        ok = rocky(x, z) && rocky(x + 1, z) && rocky(x, z + 1) && rocky(x + 1, z + 1);
      }
    }
    if (ok) continue;
    for (let tries = 0; tries < 40; tries++) {
      const angle = rand() * Math.PI * 2;
      const r = 14 + rand() * 4;
      const bx = Math.round(sx + Math.cos(angle) * r);
      const bz = Math.round(sz + Math.sin(angle) * r);
      if (bx < 4 || bz < 4 || bx > size - 5 || bz > size - 5) continue;
      // Niente acqua né altri siti vicini
      let wet = false;
      for (let z = -3; z <= 3 && !wet; z++) for (let x = -3; x <= 3 && !wet; x++) if (isWater(get(bx + x, bz + z))) wet = true;
      if (wet || sites.some(([ox, oz]) => (ox !== sx || oz !== sz) && Math.hypot(bx - ox, bz - oz) < 14)) continue;
      for (let z = -2; z <= 2; z++) {
        for (let x = -2; x <= 2; x++) if (Math.hypot(x, z) <= 2.3 + (n2(bx + x, bz + z) - 0.5)) set(bx + x, bz + z, Tile.Rock);
      }
      if (rand() < 0.35) set(bx, bz, Tile.Gold);
      centers.push([bx, bz]);
      break;
    }
  }

  // Garantisce almeno una vena d'oro sulla terraferma
  if (!tiles.includes(Tile.Gold)) {
    for (const [bx, bz] of centers) {
      if (get(bx, bz) === Tile.Rock) {
        set(bx, bz, Tile.Gold);
        if (get(bx + 1, bz) === Tile.Rock) set(bx + 1, bz, Tile.Gold);
        break;
      }
    }
  }

  return { size, seed, tiles, preset: preset.id, sites, sea: preset.sea, hills: preset.hills };
}

export function tileAt(t: Terrain, x: number, z: number): Tile | undefined {
  if (x < 0 || z < 0 || x >= t.size || z >= t.size) return undefined;
  return t.tiles[z * t.size + x] as Tile;
}

export function isWater(tile: Tile | undefined): boolean {
  return tile === Tile.River || tile === Tile.Sea;
}

export function isBuildableLand(tile: Tile | undefined): boolean {
  return tile === Tile.Grass || tile === Tile.Sand;
}
