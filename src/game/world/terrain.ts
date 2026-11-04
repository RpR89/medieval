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

export const TILE_NAMES: Record<Tile, string> = {
  [Tile.Grass]: 'Prato',
  [Tile.Forest]: 'Bosco',
  [Tile.Rock]: 'Roccia',
  [Tile.Gold]: 'Vena d\'oro',
  [Tile.River]: 'Fiume',
  [Tile.Sea]: 'Mare',
  [Tile.Sand]: 'Spiaggia',
};

export interface Terrain {
  size: number;
  seed: number;
  tiles: Uint8Array;
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

export function generateTerrain(seed: number, size = MAP_SIZE): Terrain {
  const tiles = new Uint8Array(size * size).fill(Tile.Grass);
  const rand = mulberry32(seed ^ 0x9e3779b9);
  const n1 = makeNoise(seed + 1, 8);
  const n2 = makeNoise(seed + 2, 4);
  const center = size / 2;
  const set = (x: number, z: number, t: Tile) => {
    if (x >= 0 && z >= 0 && x < size && z < size) tiles[z * size + x] = t;
  };
  const get = (x: number, z: number) => tiles[z * size + x] as Tile;

  // Boschi
  for (let z = 0; z < size; z++) {
    for (let x = 0; x < size; x++) {
      const dist = Math.hypot(x - center, z - center);
      // Radura attorno al sito del castello, con margine sfumato
      const clear = dist < 13 ? 0.32 : dist < 16 ? 0.32 * (1 - (dist - 13) / 3) : 0;
      const f = n1(x, z) * 0.7 + n2(x, z) * 0.3 - clear;
      if (f > 0.56) set(x, z, Tile.Forest);
    }
  }

  // Affioramenti rocciosi, uno con vena d'oro
  const blobs = 3 + Math.floor(rand() * 2);
  const centers: Array<[number, number]> = [];
  for (let b = 0; b < blobs; b++) {
    const angle = rand() * Math.PI * 2;
    const r = 16 + rand() * 10;
    const bx = Math.round(center + Math.cos(angle) * r);
    const bz = Math.round(center + Math.sin(angle) * r);
    centers.push([bx, bz]);
    const radius = 2 + rand() * 1.8;
    for (let z = -4; z <= 4; z++) {
      for (let x = -4; x <= 4; x++) {
        if (Math.hypot(x, z) <= radius + (n2(bx + x, bz + z) - 0.5) * 1.5) set(bx + x, bz + z, Tile.Rock);
      }
    }
    if (b === 0 || rand() < 0.35) {
      set(bx, bz, Tile.Gold);
      set(bx + 1, bz, Tile.Gold);
      if (rand() < 0.5) set(bx, bz + 1, Tile.Gold);
    }
  }

  // Mare sul lato est con spiaggia
  for (let z = 0; z < size; z++) {
    const coast = size - 6 + Math.round((n1(z * 1.7, 3) - 0.5) * 6);
    for (let x = coast - 1; x < size; x++) set(x, z, x === coast - 1 ? Tile.Sand : Tile.Sea);
  }

  // Fiume da nord a sud che si getta nel mare
  let rx = Math.round(center - 18 + rand() * 6);
  for (let z = 0; z < size; z++) {
    rx += Math.round((n2(z, 7) - 0.5) * 2.2);
    if (z > size * 0.7) rx += 1; // piega verso il mare
    rx = Math.max(3, Math.min(size - 4, rx));
    // Lascia libera l'area centrale del castello
    if (Math.abs(z - center) < 14) rx = Math.min(rx, Math.round(center - 14));
    const width = 2;
    for (let w = 0; w < width; w++) {
      if (get(rx + w, z) !== Tile.Sea) set(rx + w, z, Tile.River);
    }
    if (get(rx + width, z) === Tile.Sea) break;
  }

  // Garantisce almeno una vena d'oro sulla terraferma (il mare o il fiume possono averla coperta)
  if (!tiles.includes(Tile.Gold)) {
    for (const [bx, bz] of centers) {
      if (get(bx, bz) === Tile.Rock) {
        set(bx, bz, Tile.Gold);
        if (get(bx + 1, bz) === Tile.Rock) set(bx + 1, bz, Tile.Gold);
        break;
      }
    }
  }

  return { size, seed, tiles };
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
