import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Raggruppa le parti statiche degli edifici in blocchi di mappa (chunk):
 * tutte le mura, case e torri di un blocco diventano una mesh per materiale.
 * Centinaia di edifici → poche decine di draw call. Solo i blocchi modificati si ricostruiscono.
 */
export class StaticBatches {
  readonly group = new THREE.Group();
  private parts = new Map<number, { chunk: string; items: Array<{ mat: THREE.Material; geo: THREE.BufferGeometry }> }>();
  private chunks = new Map<string, THREE.Mesh[]>();
  private dirty = new Set<string>();

  constructor(private chunkSize = 12) {}

  private key(x: number, z: number) {
    return `${Math.floor(x / this.chunkSize)},${Math.floor(z / this.chunkSize)}`;
  }

  /**
   * Prende le mesh statiche (figli diretti senza userData.keep) dall'oggetto già posizionato
   * nel mondo e le sposta nel blocco. L'oggetto conserva solo le parti animate.
   */
  set(uid: number, obj: THREE.Object3D, x: number, z: number) {
    this.remove(uid);
    obj.updateMatrixWorld(true);
    const items: Array<{ mat: THREE.Material; geo: THREE.BufferGeometry }> = [];
    for (const c of [...obj.children]) {
      if (!(c instanceof THREE.Mesh) || c.userData.keep) continue;
      const geo = (c.geometry as THREE.BufferGeometry).clone().applyMatrix4(c.matrixWorld);
      items.push({ mat: c.material as THREE.Material, geo });
      c.geometry.dispose();
      c.removeFromParent();
    }
    if (!items.length) return;
    const chunk = this.key(x, z);
    this.parts.set(uid, { chunk, items });
    this.dirty.add(chunk);
  }

  remove(uid: number) {
    const p = this.parts.get(uid);
    if (!p) return;
    for (const it of p.items) it.geo.dispose();
    this.parts.delete(uid);
    this.dirty.add(p.chunk);
  }

  /** Ricostruisce i blocchi modificati. */
  flush() {
    if (!this.dirty.size) return;
    for (const chunk of this.dirty) {
      for (const m of this.chunks.get(chunk) ?? []) {
        m.geometry.dispose();
        m.removeFromParent();
      }
      const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
      for (const p of this.parts.values()) {
        if (p.chunk !== chunk) continue;
        for (const it of p.items) {
          if (!byMat.has(it.mat)) byMat.set(it.mat, []);
          byMat.get(it.mat)!.push(it.geo);
        }
      }
      const meshes: THREE.Mesh[] = [];
      for (const [mat, geos] of byMat) {
        const merged = geos.length === 1 ? geos[0].clone() : mergeGeometries(geos, false);
        if (!merged) continue;
        merged.computeBoundingSphere();
        const mesh = new THREE.Mesh(merged, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        meshes.push(mesh);
        this.group.add(mesh);
      }
      this.chunks.set(chunk, meshes);
    }
    this.dirty.clear();
  }

  get drawCalls(): number {
    let n = 0;
    for (const m of this.chunks.values()) n += m.length;
    return n;
  }
}
