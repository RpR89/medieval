/**
 * Ricerca del percorso (A*) sulla griglia delle caselle, in 8 direzioni.
 * `cost(x, z)` restituisce il costo per entrare nella casella (Infinity = invalicabile).
 * Se la destinazione non è raggiungibile, porta il più vicino possibile.
 */
export function findPath(
  size: number,
  from: [number, number],
  to: [number, number],
  cost: (x: number, z: number) => number,
  maxNodes = 20000,
): Array<[number, number]> {
  const idx = (x: number, z: number) => z * size + x;
  const [sx, sz] = from;
  const [tx, tz] = to;
  if (sx === tx && sz === tz) return [];
  const g = new Float32Array(size * size).fill(Infinity);
  const came = new Int32Array(size * size).fill(-1);
  const closed = new Uint8Array(size * size);
  const h = (x: number, z: number) => {
    const dx = Math.abs(x - tx);
    const dz = Math.abs(z - tz);
    return Math.max(dx, dz) + 0.414 * Math.min(dx, dz);
  };
  // Coda di priorità (heap binario) su [f, nodo]
  const heapF: number[] = [];
  const heapN: number[] = [];
  const push = (f: number, n: number) => {
    heapF.push(f);
    heapN.push(n);
    let i = heapF.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapF[p] <= heapF[i]) break;
      [heapF[p], heapF[i]] = [heapF[i], heapF[p]];
      [heapN[p], heapN[i]] = [heapN[i], heapN[p]];
      i = p;
    }
  };
  const pop = (): number => {
    const top = heapN[0];
    const lf = heapF.pop()!;
    const ln = heapN.pop()!;
    if (heapF.length) {
      heapF[0] = lf;
      heapN[0] = ln;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heapF.length && heapF[l] < heapF[m]) m = l;
        if (r < heapF.length && heapF[r] < heapF[m]) m = r;
        if (m === i) break;
        [heapF[m], heapF[i]] = [heapF[i], heapF[m]];
        [heapN[m], heapN[i]] = [heapN[i], heapN[m]];
        i = m;
      }
    }
    return top;
  };
  const start = idx(sx, sz);
  g[start] = 0;
  push(h(sx, sz), start);
  let best = start;
  let bestH = h(sx, sz);
  let visited = 0;
  const goal = idx(tx, tz);
  while (heapN.length && visited < maxNodes) {
    const n = pop();
    if (closed[n]) continue;
    closed[n] = 1;
    visited++;
    if (n === goal) {
      best = n;
      break;
    }
    const x = n % size;
    const z = (n - x) / size;
    const hn = h(x, z);
    if (hn < bestH) {
      bestH = hn;
      best = n;
    }
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const nx = x + dx;
        const nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= size || nz >= size) continue;
        const c = cost(nx, nz);
        if (!isFinite(c)) continue;
        // In diagonale non si "tagliano" gli angoli di mura e acqua
        if (dx && dz && (!isFinite(cost(x + dx, z)) || !isFinite(cost(x, z + dz)))) continue;
        const k = idx(nx, nz);
        const ng = g[n] + c * (dx && dz ? 1.414 : 1);
        if (ng < g[k]) {
          g[k] = ng;
          came[k] = n;
          push(ng + h(nx, nz), k);
        }
      }
    }
  }
  const path: Array<[number, number]> = [];
  for (let n = best; n !== start && n >= 0; n = came[n]) path.push([n % size, Math.floor(n / size)]);
  return path.reverse();
}
