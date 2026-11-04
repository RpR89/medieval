import * as THREE from 'three';
import { BUILDINGS, type BuildingDef } from '../game/data/buildings';
import { buildModel, type ModelCtx } from './models';

/**
 * Miniature degli edifici per il menu di costruzione, disegnate dai modelli 3D veri
 * con un renderer a parte. Si generano poco per volta per non bloccare il gioco.
 */

const SIZE = 96;

/** Contesto per far apparire bene mura e strade anche da sole (collegate in fila). */
function ctxFor(def: BuildingDef): ModelCtx {
  if (['palisade', 'wall_stone', 'road', 'road_paved', 'bridge', 'gate_wood', 'gate_stone'].includes(def.id)) {
    return { links: [{ dx: 1, dz: 0, ext: 0 }, { dx: -1, dz: 0, ext: 0 }], seed: 3, upgrades: def.id === 'wall_stone' ? ['walkway'] : [] };
  }
  if (def.id === 'moat') return { upgrades: ['stakes'], depth: 1, seed: 3 };
  return { seed: 3 };
}

export function makeThumbnails(onReady: (id: string, url: string) => void): () => void {
  let cancelled = false;
  let renderer: THREE.WebGLRenderer;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  } catch {
    return () => {};
  }
  renderer.setPixelRatio(1);
  renderer.setSize(SIZE, SIZE, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xf4f0e6, 0x5a4a30, 1.4));
  const sun = new THREE.DirectionalLight(0xfff0d8, 2.2);
  sun.position.set(-3, 6, 4);
  scene.add(sun);
  // Zolla d'erba sotto l'edificio
  const ground = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 0.08, 24),
    new THREE.MeshStandardMaterial({ color: 0x6a9a3c, roughness: 1 }),
  );
  ground.position.y = -0.04;
  scene.add(ground);
  const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 100);

  const queue = [...BUILDINGS];
  const next = () => {
    if (cancelled) return;
    const def = queue.shift();
    if (!def) {
      renderer.dispose();
      return;
    }
    try {
      const obj = buildModel(def, ctxFor(def));
      scene.add(obj);
      const box = new THREE.Box3().setFromObject(obj);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const r = Math.max(size.x, size.z, size.y * 0.9, 0.6);
      ground.scale.set(Math.max(size.x, size.z) * 0.75 + 0.2, 1, Math.max(size.x, size.z) * 0.75 + 0.2);
      const dist = r * 2.3;
      camera.position.set(center.x + dist * 0.75, center.y + dist * 0.7, center.z + dist * 0.85);
      camera.lookAt(center.x, center.y * 0.8, center.z);
      renderer.render(scene, camera);
      onReady(def.id, renderer.domElement.toDataURL('image/png'));
      scene.remove(obj);
      obj.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
    } catch {
      /* se un modello non si disegna resta l'icona */
    }
    setTimeout(next, 16);
  };
  setTimeout(next, 300);
  return () => {
    cancelled = true;
  };
}
