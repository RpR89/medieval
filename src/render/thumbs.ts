import * as THREE from 'three';
import { BUILDINGS, type BuildingDef } from '../game/data/buildings';
import { buildModel, LINKED_TYPES, type ModelCtx } from './models';

/**
 * Miniature degli edifici per il menu di costruzione, disegnate dai modelli 3D veri
 * con un renderer a parte. Si generano poco per volta per non bloccare il gioco.
 */

const SIZE = 96;

/** Contesto per far apparire bene mura e strade anche da sole (collegate in fila). */
function ctxFor(def: BuildingDef): ModelCtx {
  if (LINKED_TYPES.has(def.id)) {
    const upgrades = [...(def.builtIn ?? []), ...(def.id === 'wall_stone' ? ['walkway'] : [])];
    return { links: [{ dx: 1, dz: 0, ext: 0 }, { dx: -1, dz: 0, ext: 0 }], seed: 3, upgrades };
  }
  if (def.id === 'moat') return { upgrades: ['stakes'], depth: 1, seed: 3 };
  return { seed: 3 };
}

/** Le miniature si conservano nel browser: si rigenerano solo dopo un aggiornamento del gioco. */
const CACHE_KEY = `medieval.thumbs.${__BUILD__}`;

function loadCache(): Record<string, string> {
  try {
    // Via le versioni vecchie
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith('medieval.thumbs.') && k !== CACHE_KEY) localStorage.removeItem(k);
    }
    return JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function saveCache(c: Record<string, string>) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {
    /* spazio esaurito: pazienza, si rigenerano la prossima volta */
  }
}

/** Esegue quando il browser è libero (niente scatti durante il gioco). */
const idle = (fn: () => void) => {
  const w = window as unknown as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => void };
  if (w.requestIdleCallback) w.requestIdleCallback(fn, { timeout: 2000 });
  else setTimeout(fn, 60);
};

export function makeThumbnails(onReady: (id: string, url: string) => void): () => void {
  let cancelled = false;
  const cache = loadCache();
  for (const def of BUILDINGS) if (cache[def.id]) onReady(def.id, cache[def.id]);
  const missing = BUILDINGS.filter((d) => !cache[d.id]);
  if (!missing.length) return () => {};
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

  const queue = [...missing];
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
      // Codifica asincrona (WebP, leggera) invece di toDataURL, che blocca il gioco
      renderer.domElement.toBlob(
        (blob) => {
          if (!blob || cancelled) return;
          const fr = new FileReader();
          fr.onload = () => {
            const url = fr.result as string;
            cache[def.id] = url;
            onReady(def.id, url);
            if (!queue.length) saveCache(cache);
          };
          fr.readAsDataURL(blob);
        },
        'image/webp',
        0.85,
      );
      scene.remove(obj);
      obj.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
    } catch {
      /* se un modello non si disegna resta l'icona */
    }
    idle(next);
  };
  setTimeout(() => idle(next), 1500);
  return () => {
    cancelled = true;
  };
}
