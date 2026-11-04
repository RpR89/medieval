import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Season } from '../game/data/calendar';
import type { BuildingDef, Species } from '../game/data/buildings';
import { mulberry32 } from '../game/world/terrain';
import {
  bake,
  box,
  cone,
  cyl,
  flag,
  gableRoof,
  hipRoof,
  mats,
  smoke,
  sphere,
} from './kit';
import { addWind } from './effects';
import { bridge, gatehouse, gateStone, gateWood, keepStone, keepWood, moat, palisade, road, stoneWall, towerRound, towerSquare, towerWood, type ModelCtx } from './fortModels';
export type { Link, ModelCtx } from './fortModels';
import { timberFrame, windowShutters, door, chimney, barrel, crate, sack, logPile, fence } from './parts';

/**
 * Modelli 3D procedurali low-poly dettagliati. Ogni modello è centrato
 * sull'ingombro dell'edificio con il terreno a y=0, poi fuso con `bake`.
 * Per passare a modelli GLB basta far restituire a `buildModel` un oggetto caricato.
 */

type G = THREE.Group;
const PI = Math.PI;

// ───────────── Animali ─────────────

function quadruped(body: THREE.Material, legs: THREE.Material, s: { l: number; h: number; w: number; leg: number }) {
  const g = new THREE.Group();
  g.add(box(s.l, s.h, s.w, body, 0, s.leg, 0));
  for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    g.add(box(0.035, s.leg, 0.035, legs, lx * (s.l / 2 - 0.04), 0, lz * (s.w / 2 - 0.03)));
  }
  return g;
}

export function animalMesh(species: Species): THREE.Group {
  const k = mats();
  let g: THREE.Group;
  if (species === 'cattle') {
    g = quadruped(k.cowBrown, k.cowBrown, { l: 0.34, h: 0.16, w: 0.15, leg: 0.12 });
    g.add(box(0.12, 0.07, 0.16, k.cowWhite, -0.05, 0.2, 0));
    g.add(box(0.1, 0.1, 0.1, k.cowBrown, 0.21, 0.2, 0));
    g.add(box(0.05, 0.05, 0.08, k.cowWhite, 0.27, 0.19, 0));
    g.add(box(0.02, 0.04, 0.02, k.horn, 0.21, 0.29, 0.04));
    g.add(box(0.02, 0.04, 0.02, k.horn, 0.21, 0.29, -0.04));
    g.add(box(0.02, 0.12, 0.02, k.cowBrown, -0.18, 0.14, 0));
  } else if (species === 'pigs') {
    g = quadruped(k.pig, k.pig, { l: 0.24, h: 0.12, w: 0.13, leg: 0.05 });
    g.add(box(0.08, 0.08, 0.09, k.pig, 0.14, 0.07, 0));
    g.add(box(0.03, 0.04, 0.05, k.cowWhite, 0.19, 0.08, 0));
    g.add(box(0.03, 0.03, 0.02, k.pig, 0.13, 0.15, 0.03));
    g.add(box(0.03, 0.03, 0.02, k.pig, 0.13, 0.15, -0.03));
  } else {
    g = quadruped(k.goat, k.goatDark, { l: 0.2, h: 0.1, w: 0.09, leg: 0.1 });
    g.add(box(0.06, 0.08, 0.06, k.goat, 0.12, 0.18, 0));
    g.add(box(0.015, 0.06, 0.015, k.horn, 0.11, 0.26, 0.02));
    g.add(box(0.015, 0.06, 0.015, k.horn, 0.11, 0.26, -0.02));
    g.add(box(0.02, 0.04, 0.02, k.goatDark, 0.15, 0.14, 0));
  }
  return bake(g);
}

function horse(): THREE.Group {
  const k = mats();
  const g = quadruped(k.horse, k.horseDark, { l: 0.36, h: 0.14, w: 0.12, leg: 0.17 });
  const neck = box(0.07, 0.16, 0.07, k.horse, 0.17, 0.25, 0);
  neck.rotation.z = -0.5;
  g.add(neck);
  g.add(box(0.13, 0.06, 0.06, k.horse, 0.27, 0.37, 0));
  g.add(box(0.02, 0.12, 0.03, k.horseDark, 0.15, 0.3, 0));
  g.add(box(0.03, 0.14, 0.03, k.horseDark, -0.19, 0.17, 0));
  return bake(g);
}

// ───────────── Colture stagionali ─────────────

const CROP_COLORS: Record<string, Record<Season, number>> = {
  field_grain: { spring: 0x86b04a, summer: 0xe2bd52, autumn: 0xa8915a, winter: 0x7a6a50 },
  field_vegetables: { spring: 0x5f9a3c, summer: 0x4f8f35, autumn: 0x6f8a3a, winter: 0x5a5040 },
  hay_meadow: { spring: 0x86b850, summer: 0xb8b45a, autumn: 0x98a85a, winter: 0x8a8a6a },
};
const CROP_SCALE: Record<string, Record<Season, number>> = {
  field_grain: { spring: 0.45, summer: 1, autumn: 0.25, winter: 0 },
  field_vegetables: { spring: 0.6, summer: 1, autumn: 0.85, winter: 0 },
  hay_meadow: { spring: 0.7, summer: 1, autumn: 0.5, winter: 0.3 },
};

/** Tante piccole geometrie identiche fuse in una sola mesh (colture, erba). */
function scatter(proto: THREE.BufferGeometry, spots: Array<[number, number, number, number]>): THREE.BufferGeometry {
  const geos = spots.map(([x, z, s, r]) => {
    const geo = (proto.index ? proto.toNonIndexed() : proto.clone());
    geo.deleteAttribute('uv');
    geo.scale(s, s, s);
    geo.rotateY(r);
    geo.translate(x, 0, z);
    return geo;
  });
  return mergeGeometries(geos, false)!;
}

function field(g: G, def: BuildingDef, seed: number) {
  const k = mats();
  const [w, d] = def.size;
  const rand = mulberry32(seed);
  const base = box(w - 0.08, 0.04, d - 0.08, def.id === 'hay_meadow' ? k.grassMound : k.soil, 0, 0, 0);
  base.castShadow = false;
  g.add(base);
  // Bordo di terra rialzata e qualche palo di confine
  for (const [x, z] of [[-w / 2 + 0.06, -d / 2 + 0.06], [w / 2 - 0.06, d / 2 - 0.06]]) {
    g.add(box(0.04, 0.2, 0.04, k.beam, x, 0, z));
  }
  const spots: Array<[number, number, number, number]> = [];
  let proto: THREE.BufferGeometry;
  if (def.id === 'field_grain') {
    proto = new THREE.ConeGeometry(0.035, 0.28, 4);
    proto.translate(0, 0.14, 0);
    const rows = Math.round(d * 4);
    for (let r = 0; r < rows; r++) {
      const z = -d / 2 + 0.15 + (r * (d - 0.3)) / (rows - 1);
      for (let x = -w / 2 + 0.12; x < w / 2 - 0.1; x += 0.07) spots.push([x + (rand() - 0.5) * 0.03, z + (rand() - 0.5) * 0.04, 0.8 + rand() * 0.5, rand() * PI]);
    }
  } else if (def.id === 'field_vegetables') {
    proto = new THREE.IcosahedronGeometry(0.055, 0);
    proto.translate(0, 0.05, 0);
    const rows = Math.round(d * 3);
    for (let r = 0; r < rows; r++) {
      const z = -d / 2 + 0.2 + (r * (d - 0.4)) / (rows - 1);
      for (let x = -w / 2 + 0.15; x < w / 2 - 0.12; x += 0.14) spots.push([x + (rand() - 0.5) * 0.03, z, 0.8 + rand() * 0.5, rand() * PI]);
    }
    // Spaventapasseri
    g.add(box(0.03, 0.4, 0.03, k.beam, w / 2 - 0.3, 0, -d / 2 + 0.3));
    g.add(box(0.25, 0.03, 0.03, k.beam, w / 2 - 0.3, 0.3, -d / 2 + 0.3));
    g.add(box(0.12, 0.14, 0.06, k.wattle, w / 2 - 0.3, 0.22, -d / 2 + 0.3));
    g.add(cone(0.08, 0.08, k.straw, w / 2 - 0.3, 0.4, -d / 2 + 0.3, 6));
  } else {
    proto = new THREE.ConeGeometry(0.03, 0.12, 3);
    proto.translate(0, 0.06, 0);
    for (let i = 0; i < w * d * 40; i++) spots.push([(rand() - 0.5) * (w - 0.2), (rand() - 0.5) * (d - 0.2), 0.7 + rand() * 0.8, rand() * PI]);
    for (const [x, z] of [[-0.8, -0.3], [0.2, 0.35], [0.9, -0.25]]) {
      const stack = new THREE.Group();
      stack.add(cyl(0.18, 0.24, 0.22, k.straw, 0, 0, 0, 9));
      stack.add(cone(0.18, 0.22, k.straw, 0, 0.22, 0, 9));
      stack.add(box(0.02, 0.5, 0.02, k.beam, 0, 0, 0));
      stack.position.set(x, 0, z);
      const baked = bake(stack);
      baked.position.set(x, 0, z);
      baked.userData.keep = true;
      baked.userData.haystack = true;
      g.add(baked);
    }
  }
  const cropMat = new THREE.MeshStandardMaterial({ color: CROP_COLORS[def.id].summer, roughness: 0.9 });
  if (def.id !== 'field_vegetables') addWind(cropMat, 0.025, 0.28);
  const crop = new THREE.Mesh(scatter(proto, spots), cropMat);
  crop.castShadow = true;
  crop.receiveShadow = true;
  crop.position.y = 0.04;
  crop.userData.keep = true;
  crop.userData.crop = def.id;
  g.add(crop);
}

/** Ricolora e fa crescere le colture secondo la stagione. */
export function applySeason(obj: THREE.Object3D, defId: string, season: Season) {
  const colors = CROP_COLORS[defId];
  if (!colors) return;
  obj.traverse((o) => {
    if (o.userData.crop && o instanceof THREE.Mesh) {
      (o.material as THREE.MeshStandardMaterial).color.setHex(colors[season]);
      const s = CROP_SCALE[defId][season];
      o.visible = s > 0;
      o.scale.set(1, Math.max(0.01, s), 1);
    }
    if (o.userData.haystack) o.visible = season === 'summer' || season === 'autumn';
  });
}

// ───────────── Recinti ─────────────

function pasture(g: G, def: BuildingDef) {
  const k = mats();
  const [w, d] = def.size;
  const ground = box(w - 0.06, 0.02, d - 0.06, k.grassMound, 0, 0, 0);
  ground.castShadow = false;
  g.add(ground);
  fence(g, w, d);
  // Tettoia
  const sx = w / 2 - 0.5;
  const sz = -d / 2 + 0.38;
  g.add(box(0.7, 0.36, 0.04, k.darkPlanks, sx, 0, sz - 0.2));
  g.add(box(0.04, 0.36, 0.42, k.darkPlanks, sx - 0.35, 0, sz));
  g.add(box(0.04, 0.36, 0.42, k.darkPlanks, sx + 0.35, 0, sz));
  g.add(gableRoof(0.8, 0.5, 0.22, k.thatch, k.darkPlanks, sx, 0.36, sz));
  // Abbeveratoio e mangiatoia
  g.add(box(0.36, 0.08, 0.1, k.planks, -w / 2 + 0.4, 0, -d / 2 + 0.25));
  g.add(box(0.32, 0.01, 0.07, k.water, -w / 2 + 0.4, 0.075, -d / 2 + 0.25));
  if (def.herd?.species !== 'pigs') {
    g.add(box(0.18, 0.12, 0.18, k.straw, -w / 2 + 0.3, 0, d / 2 - 0.35));
  } else {
    const mud = box(0.7, 0.012, 0.5, k.earth, -0.1, 0.02, 0.2);
    mud.castShadow = false;
    g.add(mud);
  }
  const animals = new THREE.Group();
  animals.userData.keep = true;
  animals.userData.animals = true;
  g.add(animals);
}

/** Posiziona `count` animali nel recinto, in modo stabile. */
export function updateHerd(obj: THREE.Object3D, def: BuildingDef, count: number) {
  if (!def.herd) return;
  const holder = obj.children.find((c) => c.userData.animals) as THREE.Group | undefined;
  if (!holder || holder.userData.count === count) return;
  holder.userData.count = count;
  holder.clear();
  const [w, d] = def.size;
  const visible = Math.min(count, 14);
  const rand = mulberry32(w * 31 + d);
  for (let i = 0; i < visible; i++) {
    const a = animalMesh(def.herd.species);
    const x = (rand() - 0.5) * (w - 0.7);
    const z = (rand() - 0.2) * (d - 0.9) * 0.8;
    a.position.set(x, 0.02, z);
    a.rotation.y = rand() * PI * 2;
    a.userData.wander = { x, z, phase: rand() * 10, speed: 0.15 + rand() * 0.2, r: 0.1 + rand() * 0.15 };
    holder.add(a);
  }
}

// ───────────── Mura ─────────────





// ───────────── Edifici ─────────────

function hut(g: G, x: number, z: number, s = 1, chimneySmoke = true) {
  const k = mats();
  g.add(box(0.72 * s, 0.06, 0.62 * s, k.stoneDark, x, 0, z));
  g.add(box(0.66 * s, 0.42 * s, 0.56 * s, k.wattle, x, 0.04, z));
  for (const [cx, cz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    g.add(box(0.05, 0.44 * s, 0.05, k.beam, x + cx * 0.33 * s, 0.04, z + cz * 0.28 * s));
  }
  g.add(gableRoof(0.75 * s, 0.62 * s, 0.42 * s, k.thatch, k.wattle, x, 0.46 * s, z, 0.1 * s));
  door(g, x + 0.1 * s, z + 0.285 * s, 0, 0.14 * s, 0.28 * s);
  windowShutters(g, x - 0.18 * s, 0.22 * s, z + 0.285 * s, 0, 0.08 * s, 0.08 * s);
  if (chimneySmoke) g.add(smoke(x - 0.15 * s, 0.85 * s, z, 3, 0.6));
}

function house(g: G) {
  const k = mats();
  // Piano terra in pietra, primo piano a graticcio in aggetto
  g.add(box(1.7, 0.45, 0.72, k.stone, 0, 0, 0));
  timberFrame(g, 1.8, 0.45, 0.82, 0, 0.45, 0);
  g.add(box(1.86, 0.04, 0.88, k.beam, 0, 0.44, 0));
  g.add(gableRoof(1.8, 0.82, 0.55, k.roofTile, k.plaster, 0, 0.9, 0, 0.12));
  door(g, -0.45, 0.365, 0, 0.18, 0.34);
  for (const wx of [0.1, 0.55]) windowShutters(g, wx, 0.22, 0.37, 0, 0.12, 0.12);
  for (const wx of [-0.55, 0, 0.55]) windowShutters(g, wx, 0.65, 0.42, 0, 0.12, 0.13);
  for (const wx of [-0.4, 0.4]) windowShutters(g, wx, 0.65, -0.42, PI, 0.12, 0.13);
  chimney(g, 0.6, 1.1, -0.15, 0.45);
  barrel(g, 0.8, 0.5);
}









function workshopHut(g: G, x: number, z: number, s = 0.85, smokeOn = true) {
  hut(g, x, z, s, smokeOn);
}

function quarry(g: G, seed: number) {
  const k = mats();
  const rand = mulberry32(seed);
  // Gradoni scavati nella roccia
  g.add(box(1.85, 0.08, 1.85, k.stoneDark, 0, -0.02, 0));
  g.add(box(1.8, 0.45, 0.5, k.stone, 0, 0, -0.65));
  g.add(box(0.5, 0.3, 1.3, k.stone, -0.65, 0, 0.0));
  g.add(box(1.2, 0.2, 0.35, k.stoneLight, 0.1, 0, -0.25));
  for (let i = 0; i < 6; i++) {
    const s = 0.12 + rand() * 0.08;
    g.add(box(s * 1.6, s, s, k.stoneLight, 0.3 + rand() * 0.5, 0, 0.2 + rand() * 0.6));
  }
  // Gru a ruota (argano)
  const crane = new THREE.Group();
  crane.add(box(0.06, 1.4, 0.06, k.log, 0, 0, 0));
  const jib = box(1.0, 0.05, 0.05, k.log, 0.4, 1.3, 0);
  jib.rotation.z = 0.2;
  crane.add(jib);
  crane.add(cyl(0.006, 0.006, 0.7, k.rope, 0.85, 0.75, 0, 3));
  crane.add(box(0.14, 0.1, 0.1, k.stoneLight, 0.85, 0.65, 0));
  const wheel = cyl(0.28, 0.28, 0.08, k.planks, -0.12, 0.3, 0, 12);
  wheel.rotation.x = PI / 2;
  wheel.position.set(-0.12, 0.32, 0);
  crane.add(wheel);
  crane.position.set(-0.3, 0, 0.55);
  g.add(crane);
  // Carro
  g.add(box(0.36, 0.1, 0.2, k.planks, 0.55, 0.12, 0.75));
  for (const s of [-1, 1]) {
    const w = cyl(0.07, 0.07, 0.03, k.darkPlanks, 0, 0, 0, 8);
    w.rotation.x = PI / 2;
    w.position.set(0.55, 0.07, 0.75 + s * 0.12);
    g.add(w);
  }
}

function goldMine(g: G) {
  const k = mats();
  const rocks: Array<[number, number, number, number]> = [[0, -0.2, 0.75, 0.7], [-0.5, -0.3, 0.45, 0.5], [0.5, -0.35, 0.5, 0.45], [0.2, -0.7, 0.4, 0.5]];
  for (const [x, z, r, sy] of rocks) {
    const s = sphere(r, k.stoneDark, x, 0, z, 0);
    s.scale.y = sy;
    g.add(s);
  }
  // Imbocco della galleria armato in legno
  g.add(box(0.46, 0.5, 0.05, k.dark, 0, 0, 0.38));
  for (const s of [-1, 1]) g.add(box(0.08, 0.6, 0.08, k.log, s * 0.27, 0, 0.4));
  g.add(box(0.7, 0.09, 0.1, k.log, 0, 0.58, 0.4));
  g.add(box(0.06, 0.06, 0.06, k.gold, 0.2, 0.5, 0.46));
  // Binari e carrello
  for (const s of [-1, 1]) g.add(box(0.02, 0.02, 0.8, k.iron, s * 0.1, 0.01, 0.8));
  for (let i = 0; i < 5; i++) g.add(box(0.3, 0.015, 0.04, k.planks, 0, 0, 0.45 + i * 0.17));
  g.add(box(0.22, 0.14, 0.26, k.darkPlanks, 0, 0.05, 0.85));
  for (let i = 0; i < 4; i++) g.add(sphere(0.045, k.gold, (i % 2) * 0.08 - 0.04, 0.2, 0.8 + Math.floor(i / 2) * 0.08, 0));
  workshopHut(g, 0.65, 0.55, 0.6, true);
}

function charcoalKiln(g: G) {
  const k = mats();
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 7, 0, PI * 2, 0, PI / 2), k.earth);
  dome.castShadow = true;
  dome.receiveShadow = true;
  g.add(dome);
  g.add(cyl(0.05, 0.06, 0.06, k.dark, 0, 0.4, 0, 6));
  g.add(smoke(0, 0.45, 0, 6, 1.4));
  logPile(g, 0.25, 0.3, 0.4, 3);
  // Capanno del carbonaio (a capanna di frasche)
  const t = cone(0.2, 0.4, k.thatch, -0.3, 0, 0.3, 6);
  g.add(t);
}

function granary(g: G) {
  const k = mats();
  for (const [x, z] of [[-0.6, -0.5], [0.6, -0.5], [-0.6, 0.5], [0.6, 0.5], [0, -0.5], [0, 0.5]]) {
    g.add(cyl(0.05, 0.07, 0.18, k.stone, x, 0, z, 8));
    g.add(cyl(0.11, 0.11, 0.04, k.stoneLight, x, 0.18, z, 8));
  }
  g.add(box(1.5, 0.06, 1.2, k.beam, 0, 0.22, 0));
  g.add(box(1.4, 0.85, 1.1, k.planks, 0, 0.28, 0));
  for (const s of [-1, 1]) for (const x of [-0.7, 0, 0.7]) g.add(box(0.06, 0.85, 0.04, k.beam, x, 0.28, s * 0.56));
  g.add(gableRoof(1.5, 1.1, 0.75, k.thatch, k.planks, 0, 1.13, 0, 0.15));
  door(g, 0, 0.565, 0, 0.3, 0.55);
  g.children.at(-2)!.position.y = 0.28;
  g.children.at(-1)!.position.y = 0.83;
  sack(g, 0.4, 0.75);
  sack(g, 0.5, 0.7);
}

function market(g: G) {
  const k = mats();
  const pave = box(1.9, 0.02, 1.9, k.stoneDark, 0, 0, 0);
  pave.castShadow = false;
  g.add(pave);
  const stalls: Array<[number, number, number]> = [[-0.5, -0.5, 0], [0.5, -0.5, 1], [-0.5, 0.5, 2], [0.5, 0.5, 3]];
  for (const [x, z, i] of stalls) {
    for (const [px, pz] of [[-0.28, -0.18], [0.28, -0.18], [-0.28, 0.18], [0.28, 0.18]]) g.add(box(0.035, 0.55, 0.035, k.beam, x + px, 0, z + pz));
    g.add(box(0.56, 0.05, 0.3, k.planks, x, 0.25, z));
    g.add(box(0.56, 0.2, 0.02, k.darkPlanks, x, 0.05, z + 0.15));
    g.add(gableRoof(0.64, 0.44, 0.16, k.cloth[i], null, x, 0.55, z, 0.04));
    // Merci sul banco
    for (let j = 0; j < 3; j++) {
      const m = [k.straw, k.leafGreen, k.cowBrown, k.gold][(i + j) % 4];
      g.add(sphere(0.045, m, x - 0.15 + j * 0.15, 0.32, z, 0));
    }
  }
  barrel(g, 0.85, 0.05);
  barrel(g, 0.85, -0.12, 0.9);
  crate(g, -0.85, 0.05);
  crate(g, -0.85, 0.05, 0.12, 0.14);
  sack(g, 0.05, 0.85);
  // Pozzo
  g.add(cyl(0.16, 0.17, 0.2, k.stone, 0, 0, 0, 12));
  g.add(cyl(0.12, 0.12, 0.01, k.water, 0, 0.17, 0, 12));
  for (const s of [-1, 1]) g.add(box(0.03, 0.45, 0.03, k.beam, s * 0.15, 0.2, 0));
  g.add(gableRoof(0.4, 0.34, 0.14, k.roofTile, null, 0, 0.62, 0, 0.03));
}

function barracks(g: G) {
  const k = mats();
  g.add(box(1.75, 0.2, 1.1, k.stoneDark, 0, 0, 0));
  timberFrame(g, 1.7, 0.6, 1.0, 0, 0.2, 0);
  g.add(gableRoof(1.75, 1.0, 0.5, k.roofTile, k.plaster, 0, 0.8, 0, 0.12));
  door(g, 0, 0.51, 0, 0.22, 0.4);
  g.children.at(-2)!.position.y = 0.2;
  g.children.at(-1)!.position.y = 0.6;
  for (const wx of [-0.55, 0.55]) windowShutters(g, wx, 0.55, 0.51);
  // Rastrelliera di lance e scudi
  g.add(box(0.5, 0.04, 0.04, k.beam, -0.5, 0.35, 0.75));
  for (let i = 0; i < 5; i++) {
    g.add(cyl(0.01, 0.01, 0.6, k.planks, -0.7 + i * 0.1, 0, 0.72, 4));
    g.add(cone(0.02, 0.06, k.iron, -0.7 + i * 0.1, 0.6, 0.72, 4));
  }
  for (const x of [0.4, 0.65]) {
    const sh = cyl(0.09, 0.09, 0.02, k.cloth[1], x, 0.18, 0.62, 10);
    sh.rotation.x = PI / 2;
    sh.position.set(x, 0.18, 0.62);
    g.add(sh);
  }
  chimney(g, 0.6, 1.0, -0.2, 0.35);
  g.add(flag(k.flag, -0.85, 0.2, 0.75, 0.3));
}

function archery(g: G) {
  const k = mats();
  workshopHut(g, -0.55, -0.55, 0.75, false);
  for (const x of [-0.5, 0.15, 0.75]) {
    g.add(box(0.03, 0.4, 0.03, k.beam, x - 0.1, 0, 0.62));
    g.add(box(0.03, 0.4, 0.03, k.beam, x + 0.1, 0, 0.62));
    const butt = cyl(0.17, 0.17, 0.08, k.straw, 0, 0, 0, 12);
    butt.rotation.x = PI / 2;
    butt.position.set(x, 0.38, 0.62);
    g.add(butt);
    for (const [r, m] of [[0.13, k.target], [0.08, k.targetRed], [0.03, k.target]] as const) {
      const ring = cyl(r, r, 0.01, m, 0, 0, 0, 12);
      ring.rotation.x = PI / 2;
      ring.position.set(x, 0.38, 0.665 + (0.13 - r) * 0.05);
      g.add(ring);
    }
  }
  // Linea di tiro e rastrelliera di archi
  g.add(box(1.6, 0.02, 0.04, k.planks, 0.1, 0, -0.2));
  g.add(box(0.4, 0.3, 0.05, k.planks, 0.5, 0, -0.75));
  for (let i = 0; i < 4; i++) g.add(box(0.015, 0.28, 0.015, k.beam, 0.35 + i * 0.1, 0.02, -0.72));
}

function stable(g: G) {
  const k = mats();
  g.add(box(2.7, 0.15, 1.05, k.stoneDark, 0, 0, -0.35));
  g.add(box(2.6, 0.55, 0.05, k.planks, 0, 0.15, -0.85));
  for (const s of [-1, 1]) g.add(box(0.05, 0.55, 1.0, k.planks, s * 1.3, 0.15, -0.35));
  for (let i = 0; i <= 4; i++) g.add(box(0.06, 0.6, 0.06, k.log, -1.3 + i * 0.65, 0.15, 0.13));
  for (let i = 1; i < 4; i++) g.add(box(0.04, 0.3, 0.9, k.darkPlanks, -1.3 + i * 0.65, 0.15, -0.38));
  g.add(gableRoof(2.7, 1.05, 0.5, k.thatch, k.planks, 0, 0.75, -0.35, 0.14));
  for (const x of [-0.95, 0, 0.95]) {
    const h = horse();
    h.position.set(x, 0, 0.55);
    h.rotation.y = x * 0.6;
    g.add(h);
  }
  g.add(box(0.5, 0.1, 0.12, k.planks, 0.9, 0, 0.85));
  g.add(box(0.45, 0.01, 0.08, k.water, 0.9, 0.095, 0.85));
  for (const x of [-1.15, -0.95]) g.add(box(0.18, 0.12, 0.12, k.straw, x, 0, 0.85));
}

function dairy(g: G) {
  const k = mats();
  g.add(box(0.85, 0.12, 0.7, k.stone, 0, 0, 0));
  timberFrame(g, 0.8, 0.45, 0.65, 0, 0.12, 0);
  g.add(gableRoof(0.85, 0.65, 0.35, k.roofTile, k.plaster, 0, 0.57, 0, 0.08));
  door(g, -0.15, 0.33, 0, 0.14, 0.28);
  g.children.at(-2)!.position.y = 0.12;
  g.children.at(-1)!.position.y = 0.4;
  for (const x of [0.25, 0.38]) {
    g.add(cyl(0.05, 0.06, 0.18, k.planks, x, 0, 0.42, 8));
    g.add(cyl(0.035, 0.035, 0.04, k.planks, x, 0.18, 0.42, 8));
  }
  g.add(smoke(0.2, 0.95, -0.1, 3, 0.6));
}

function woodcutter(g: G) {
  const k = mats();
  workshopHut(g, -0.12, -0.15, 0.75);
  logPile(g, 0.25, 0.3, PI / 2, 3);
  g.add(cyl(0.1, 0.12, 0.14, k.log, -0.3, 0, 0.33, 8));
  const axe = box(0.015, 0.2, 0.015, k.planks, -0.3, 0.14, 0.33);
  axe.rotation.z = 0.4;
  g.add(axe);
  g.add(box(0.06, 0.05, 0.015, k.iron, -0.26, 0.29, 0.33));
}

function hunter(g: G) {
  const k = mats();
  workshopHut(g, 0, -0.15, 0.8);
  // Rastrelliera con pelli ad asciugare
  for (const x of [0.1, 0.42]) g.add(box(0.03, 0.4, 0.03, k.beam, x, 0, 0.35));
  g.add(box(0.36, 0.03, 0.03, k.beam, 0.26, 0.38, 0.35));
  const hide = box(0.24, 0.2, 0.01, k.cowBrown, 0.26, 0.16, 0.35);
  g.add(hide);
  // Palchi di cervo sopra la porta
  for (const s of [-1, 1]) {
    const a = box(0.012, 0.09, 0.012, k.horn, 0.08 + s * 0.03, 0.42, 0.08);
    a.rotation.z = s * 0.5;
    g.add(a);
  }
}

function fisher(g: G) {
  const k = mats();
  for (const [x, z] of [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]]) g.add(box(0.06, 0.22, 0.06, k.log, x, -0.1, z));
  g.add(box(0.7, 0.05, 0.62, k.planks, 0, 0.12, 0));
  g.add(box(0.6, 0.38, 0.5, k.planks, 0, 0.17, -0.02));
  g.add(gableRoof(0.66, 0.5, 0.3, k.thatch, k.planks, 0, 0.55, -0.02, 0.08));
  door(g, 0.1, 0.235, 0, 0.12, 0.25);
  g.children.at(-2)!.position.y = 0.17;
  g.children.at(-1)!.position.y = 0.42;
  // Rete stesa ad asciugare
  for (const x of [-0.42, -0.15]) g.add(box(0.025, 0.35, 0.025, k.beam, x, 0.12, 0.4));
  g.add(box(0.27, 0.2, 0.005, k.rope, -0.285, 0.25, 0.4));
  // Barca
  const hull = sphere(0.1, k.darkPlanks, 0.28, 0, 0.42, 1);
  hull.scale.set(2.2, 0.5, 0.9);
  g.add(hull);
  g.add(smoke(-0.15, 0.85, -0.05, 3, 0.5));
}

/** Tipi che formano una cinta continua e si collegano tra loro. */
export const WALL_FAMILY = new Set([
  'palisade',
  'wall_stone',
  'gate_wood',
  'gate_stone',
  'tower_wood',
  'tower_square',
  'tower_round',
  'gatehouse',
  'keep_wood',
  'keep_stone',
]);

/** Tipi della rete stradale (le porte ne fanno parte). */
export const ROAD_FAMILY = new Set(['road', 'road_paved', 'bridge', 'gate_wood', 'gate_stone', 'gatehouse']);

/** Tipi il cui aspetto dipende dai vicini. */
export const LINKED_TYPES = new Set(['palisade', 'wall_stone', 'gate_wood', 'gate_stone', 'road', 'road_paved', 'bridge']);

/**
 * Costruisce il modello di un edificio, centrato sull'ingombro, con il terreno a y=0.
 * `ctx` porta collegamenti con i vicini, miglioramenti, stato dei danni e variazioni casuali stabili.
 */
export function buildModel(def: BuildingDef, ctx: ModelCtx = {}): THREE.Group {
  const g = new THREE.Group();
  const [w, d] = def.size;
  const seed = ctx.seed ?? 1;
  switch (def.id) {
    case 'palisade': palisade(g, ctx); break;
    case 'wall_stone': stoneWall(g, ctx); break;
    case 'moat': moat(g, ctx); break;
    case 'gate_wood': gateWood(g, ctx); break;
    case 'gate_stone': gateStone(g, ctx); break;
    case 'tower_wood': towerWood(g, ctx); break;
    case 'tower_square': towerSquare(g, ctx); break;
    case 'tower_round': towerRound(g, ctx); break;
    case 'gatehouse': gatehouse(g, ctx); break;
    case 'keep_wood': keepWood(g, ctx); break;
    case 'keep_stone': keepStone(g, ctx); break;
    case 'road': road(g, ctx, false); break;
    case 'road_paved': road(g, ctx, true); break;
    case 'bridge': bridge(g, ctx); break;
    case 'hut': hut(g, 0, -0.05, 1); break;
    case 'house': house(g); break;
    case 'field_grain':
    case 'field_vegetables':
    case 'hay_meadow': field(g, def, seed); break;
    case 'pasture_cattle':
    case 'pasture_pigs':
    case 'pasture_goats': pasture(g, def); break;
    case 'dairy': dairy(g); break;
    case 'woodcutter': woodcutter(g); break;
    case 'hunter': hunter(g); break;
    case 'fisher': fisher(g); break;
    case 'quarry': quarry(g, seed); break;
    case 'gold_mine': goldMine(g); break;
    case 'charcoal_kiln': charcoalKiln(g); break;
    case 'granary': granary(g); break;
    case 'market': market(g); break;
    case 'barracks': barracks(g); break;
    case 'archery': archery(g); break;
    case 'stable': stable(g); break;
    default:
      g.add(box(w * 0.8, 0.8, d * 0.8, mats().planks, 0, 0, 0));
      g.add(hipRoof(w * 0.9, d * 0.9, 0.6, mats().thatch, 0, 0.8, 0));
  }
  return bake(g);
}

// ───────────── Animazioni ─────────────

const tmp = new THREE.Vector3();

/** Anima bandiere, fumo e animali di un edificio. */
export function animate(obj: THREE.Object3D, t: number, dt: number) {
  obj.traverse((o) => {
    if (o.userData.flag && o instanceof THREE.Mesh) {
      const base = o.userData.flag as Float32Array;
      const pos = o.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const x = base[i * 3];
        pos.setZ(i, Math.sin(x * 14 - t * 5 + obj.id) * x * 0.25);
      }
      pos.needsUpdate = true;
      o.geometry.computeVertexNormals();
    } else if (o.userData.smoke) {
      const s = (o.userData.smoke as { scale: number }).scale;
      o.children.forEach((p) => {
        const k = (t * 0.25 + (p.userData.phase as number)) % 1;
        p.position.set(Math.sin(k * 4 + p.userData.phase * 9) * 0.06 * s + k * 0.15 * s, k * 0.9 * s, 0);
        p.scale.setScalar(0.5 + k * 1.8);
        p.visible = k > 0.03;
      });
    } else if (o.userData.wander) {
      const w = o.userData.wander as { x: number; z: number; phase: number; speed: number; r: number };
      const a = t * w.speed + w.phase;
      tmp.set(w.x + Math.cos(a) * w.r, o.position.y, w.z + Math.sin(a * 0.7) * w.r);
      const dx = tmp.x - o.position.x;
      const dz = tmp.z - o.position.z;
      if (dx * dx + dz * dz > 1e-8) o.rotation.y = Math.atan2(-dz, dx);
      o.position.copy(tmp);
      void dt;
    }
  });
}
