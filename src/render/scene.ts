import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import type { Season } from '../game/data/calendar';
import { getBuilding } from '../game/data/buildings';
import type { Game } from '../game/sim/game';
import type { PlacedBuilding } from '../game/sim/state';
import { mulberry32, Tile, tileAt } from '../game/world/terrain';
import { applySeason, buildModel, LINKED_TYPES, updateHerd, WALL_FAMILY, type WallLinks } from './models';

const GRASS: Record<Season, number> = {
  spring: 0x6fa245,
  summer: 0x7d9e3e,
  autumn: 0x9a8f45,
  winter: 0xdfe6ea,
};
const FOLIAGE: Record<Season, number> = {
  spring: 0x4f8a35,
  summer: 0x3d7530,
  autumn: 0xb5652a,
  winter: 0x5d6f5a,
};
const SKY: Record<Season, number> = {
  spring: 0xbcd8ef,
  summer: 0xa9d0f0,
  autumn: 0xc9c3b0,
  winter: 0xd6dde3,
};

const TILE_HEIGHT: Partial<Record<Tile, number>> = {
  [Tile.Rock]: 0.25,
  [Tile.Gold]: 0.25,
  [Tile.River]: -0.4,
  [Tile.Sea]: -0.5,
  [Tile.Sand]: -0.03,
};

export interface PointerTile {
  x: number;
  z: number;
}

export class WorldRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: MapControls;
  private tiles!: THREE.InstancedMesh;
  private foliage!: THREE.InstancedMesh;
  private foliageMat!: THREE.MeshStandardMaterial;
  private buildingObjs = new Map<number, THREE.Object3D>();
  private structureVersion = -1;
  private season: Season | null = null;
  private ghost: THREE.Group | null = null;
  private ghostDef: string | null = null;
  private selection: THREE.Mesh;
  private raycaster = new THREE.Raycaster();
  private ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private keys = new Set<string>();
  private sun: THREE.DirectionalLight;
  private clock = new THREE.Clock();
  /** Caselle abbassate perché scavate a fossato. */
  private dug = new Set<number>();

  constructor(private canvas: HTMLCanvasElement, private game: Game) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    const size = game.terrain.size;
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 400);
    this.camera.position.set(size / 2 - 4, 26, size / 2 + 26);

    this.controls = new MapControls(this.camera, canvas);
    this.controls.target.set(size / 2, 0, size / 2);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 80;
    this.controls.maxPolarAngle = 1.25;
    this.controls.screenSpacePanning = false;

    this.scene.fog = new THREE.Fog(0xbcd8ef, 60, 140);
    this.scene.add(new THREE.HemisphereLight(0xdfeaff, 0x5a4a30, 1.1));
    this.sun = new THREE.DirectionalLight(0xfff1d6, 2.2);
    this.sun.position.set(size / 2 - 25, 40, size / 2 - 15);
    this.sun.target.position.set(size / 2, 0, size / 2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const s = this.sun.shadow.camera;
    s.left = -size * 0.75;
    s.right = size * 0.75;
    s.top = size * 0.75;
    s.bottom = -size * 0.75;
    s.far = 150;
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun, this.sun.target);

    this.buildTerrain();

    this.selection = new THREE.Mesh(
      new THREE.RingGeometry(0.45, 0.55, 32),
      new THREE.MeshBasicMaterial({ color: 0xffd54a, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }),
    );
    this.selection.rotation.x = -Math.PI / 2;
    this.selection.visible = false;
    this.scene.add(this.selection);

    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).closest('input, textarea')) return;
      this.keys.add(e.key.toLowerCase());
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private setTileHeight(x: number, z: number, top: number) {
    const m = new THREE.Matrix4().makeScale(1, 1 + top, 1);
    m.setPosition(x + 0.5, top, z + 0.5);
    this.tiles.setMatrixAt(z * this.game.terrain.size + x, m);
  }

  /** Abbassa il terreno sotto i fossati (e lo ripristina se demoliti). */
  private syncMoats() {
    const t = this.game.terrain;
    const now = new Set<number>();
    for (const b of this.game.state.buildings) if (b.defId === 'moat') now.add(b.z * t.size + b.x);
    let changed = false;
    for (const i of now) {
      if (!this.dug.has(i)) {
        this.setTileHeight(i % t.size, Math.floor(i / t.size), -0.4);
        changed = true;
      }
    }
    for (const i of this.dug) {
      if (!now.has(i)) {
        const x = i % t.size;
        const z = Math.floor(i / t.size);
        this.setTileHeight(x, z, TILE_HEIGHT[tileAt(t, x, z)!] ?? 0);
        changed = true;
      }
    }
    this.dug = now;
    if (changed) this.tiles.instanceMatrix.needsUpdate = true;
  }

  private buildTerrain() {
    const t = this.game.terrain;
    const n = t.size * t.size;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, -0.5, 0);
    const material = new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true });
    this.tiles = new THREE.InstancedMesh(geo, material, n);
    this.tiles.receiveShadow = true;
    const m = new THREE.Matrix4();
    for (let z = 0; z < t.size; z++) {
      for (let x = 0; x < t.size; x++) {
        const tile = tileAt(t, x, z)!;
        const top = TILE_HEIGHT[tile] ?? 0;
        const depth = 1 + top;
        m.makeScale(1, depth, 1);
        m.setPosition(x + 0.5, top, z + 0.5);
        this.tiles.setMatrixAt(z * t.size + x, m);
      }
    }
    this.scene.add(this.tiles);

    // Acqua: un piano semitrasparente sopra il letto di fiume e mare
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(t.size + 60, t.size + 60),
      new THREE.MeshStandardMaterial({ color: 0x3a7ea0, transparent: true, opacity: 0.85, roughness: 0.15, metalness: 0.1 }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.set(t.size / 2, -0.18, t.size / 2);
    water.receiveShadow = true;
    water.userData.water = true;
    this.scene.add(water);

    // Fondale esterno (mare oltre i bordi)
    const seabed = new THREE.Mesh(new THREE.PlaneGeometry(t.size + 60, t.size + 60), new THREE.MeshStandardMaterial({ color: 0x5b7f5a }));
    seabed.rotation.x = -Math.PI / 2;
    seabed.position.set(t.size / 2, -1, t.size / 2);
    this.scene.add(seabed);

    // Alberi
    const rand = mulberry32(t.seed + 99);
    const forest: Array<[number, number]> = [];
    for (let z = 0; z < t.size; z++) for (let x = 0; x < t.size; x++) if (tileAt(t, x, z) === Tile.Forest) forest.push([x, z]);
    const perTile = 2;
    const count = forest.length * perTile;
    this.foliageMat = new THREE.MeshStandardMaterial({ color: FOLIAGE.summer, flatShading: true, roughness: 0.9 });
    const foliageGeo = new THREE.ConeGeometry(0.38, 1.1, 6);
    foliageGeo.translate(0, 0.85, 0);
    this.foliage = new THREE.InstancedMesh(foliageGeo, this.foliageMat, count);
    this.foliage.castShadow = true;
    const trunkGeo = new THREE.CylinderGeometry(0.06, 0.08, 0.35, 5);
    trunkGeo.translate(0, 0.17, 0);
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x5c3b1e }), count);
    let i = 0;
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    for (const [x, z] of forest) {
      for (let k = 0; k < perTile; k++) {
        const sc = 0.75 + rand() * 0.6;
        pos.set(x + 0.2 + rand() * 0.6, 0, z + 0.2 + rand() * 0.6);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * Math.PI);
        scale.set(sc, sc * (0.9 + rand() * 0.4), sc);
        m.compose(pos, q, scale);
        this.foliage.setMatrixAt(i, m);
        trunks.setMatrixAt(i, m);
        i++;
      }
    }
    this.scene.add(this.foliage, trunks);
  }

  private paintTerrain(season: Season) {
    const t = this.game.terrain;
    const c = new THREE.Color();
    const rand = mulberry32(t.seed + 7);
    for (let z = 0; z < t.size; z++) {
      for (let x = 0; x < t.size; x++) {
        const tile = tileAt(t, x, z)!;
        switch (tile) {
          case Tile.Grass:
          case Tile.Forest:
            c.setHex(tile === Tile.Forest && season !== 'winter' ? 0x4d6b2e : GRASS[season]);
            break;
          case Tile.Rock:
            c.setHex(season === 'winter' ? 0xc9ccce : 0x8a8580);
            break;
          case Tile.Gold:
            c.setHex(0xb59a4a);
            break;
          case Tile.Sand:
            c.setHex(0xd8c58f);
            break;
          default:
            c.setHex(0x4a5a48);
        }
        c.offsetHSL(0, 0, (rand() - 0.5) * 0.04);
        this.tiles.setColorAt(z * t.size + x, c);
      }
    }
    this.tiles.instanceColor!.needsUpdate = true;
    this.foliageMat.color.setHex(FOLIAGE[season]);
    const sky = SKY[season];
    this.scene.background = new THREE.Color(sky);
    (this.scene.fog as THREE.Fog).color.setHex(sky);
    this.sun.intensity = season === 'winter' ? 1.6 : 2.2;
  }

  // ───────────── Edifici ─────────────

  private linksFor(b: PlacedBuilding): WallLinks {
    const def = getBuilding(b.defId);
    const [w, d] = def.size;
    const fam = (x: number, z: number) => {
      const o = this.game.buildingAt(x, z);
      return !!o && o.uid !== b.uid && WALL_FAMILY.has(o.defId);
    };
    return {
      px: fam(b.x + w, b.z),
      nx: fam(b.x - 1, b.z),
      pz: fam(b.x, b.z + d),
      nz: fam(b.x, b.z - 1),
    };
  }

  private makeObject(b: PlacedBuilding): THREE.Object3D {
    const def = getBuilding(b.defId);
    const obj = buildModel(def, LINKED_TYPES.has(def.id) ? this.linksFor(b) : undefined);
    obj.position.set(b.x + def.size[0] / 2, 0, b.z + def.size[1] / 2);
    obj.userData.uid = b.uid;
    obj.userData.links = JSON.stringify(LINKED_TYPES.has(def.id) ? this.linksFor(b) : null);
    if (this.season) applySeason(obj, def.id, this.season);
    if (def.herd) updateHerd(obj, def, Math.round(b.herd ?? 0));
    return obj;
  }

  private syncBuildings() {
    const alive = new Set<number>();
    for (const b of this.game.state.buildings) {
      alive.add(b.uid);
      const existing = this.buildingObjs.get(b.uid);
      if (existing) {
        // Mura e porte cambiano aspetto quando cambiano i vicini
        if (LINKED_TYPES.has(b.defId) && existing.userData.links !== JSON.stringify(this.linksFor(b))) {
          this.scene.remove(existing);
          const obj = this.makeObject(b);
          this.buildingObjs.set(b.uid, obj);
          this.scene.add(obj);
        }
        continue;
      }
      const obj = this.makeObject(b);
      this.buildingObjs.set(b.uid, obj);
      this.scene.add(obj);
    }
    for (const [uid, obj] of this.buildingObjs) {
      if (!alive.has(uid)) {
        this.scene.remove(obj);
        this.buildingObjs.delete(uid);
      }
    }
  }

  // ───────────── Interazione ─────────────

  /** Casella sotto il puntatore (coordinate client). */
  pick(clientX: number, clientY: number): PointerTile | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const p = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.ground, p)) return null;
    const x = Math.floor(p.x);
    const z = Math.floor(p.z);
    if (x < 0 || z < 0 || x >= this.game.terrain.size || z >= this.game.terrain.size) return null;
    return { x, z };
  }

  /** Mostra l'anteprima dell'edificio da costruire (null per nasconderla). */
  setGhost(defId: string | null, tile: PointerTile | null, valid: boolean) {
    if (defId !== this.ghostDef) {
      if (this.ghost) this.scene.remove(this.ghost);
      this.ghost = null;
      this.ghostDef = defId;
      if (defId) {
        const def = getBuilding(defId);
        const g = buildModel(def);
        const base = new THREE.Mesh(new THREE.BoxGeometry(def.size[0], 0.04, def.size[1]), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.45 }));
        base.position.y = 0.04;
        base.userData.base = true;
        g.add(base);
        g.traverse((o) => {
          if (o instanceof THREE.Mesh && !o.userData.base) {
            o.material = (o.material as THREE.Material).clone();
            (o.material as THREE.MeshStandardMaterial).transparent = true;
            (o.material as THREE.MeshStandardMaterial).opacity = 0.6;
            o.castShadow = false;
          }
        });
        this.ghost = g;
        this.scene.add(g);
      }
    }
    if (!this.ghost || !defId) return;
    this.ghost.visible = !!tile;
    if (!tile) return;
    const def = getBuilding(defId);
    this.ghost.position.set(tile.x + def.size[0] / 2, 0.02, tile.z + def.size[1] / 2);
    this.ghost.traverse((o) => {
      if (o instanceof THREE.Mesh && o.userData.base) {
        (o.material as THREE.MeshBasicMaterial).color.setHex(valid ? 0x4caf50 : 0xe53935);
      }
    });
  }

  select(b: PlacedBuilding | null) {
    if (!b) {
      this.selection.visible = false;
      return;
    }
    const def = getBuilding(b.defId);
    const r = Math.max(def.size[0], def.size[1]) * 0.75;
    this.selection.scale.set(r * 1.6, r * 1.6, 1);
    this.selection.position.set(b.x + def.size[0] / 2, 0.08, b.z + def.size[1] / 2);
    this.selection.visible = true;
  }

  /** Abilita/disabilita il trascinamento della mappa col tasto sinistro. */
  setLeftPan(enabled: boolean) {
    this.controls.mouseButtons.LEFT = enabled ? THREE.MOUSE.PAN : (null as unknown as THREE.MOUSE);
  }

  private panWithKeys(dt: number) {
    const speed = 18 * dt * (this.camera.position.distanceTo(this.controls.target) / 30);
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));
    const move = new THREE.Vector3();
    if (this.keys.has('w') || this.keys.has('arrowup')) move.add(forward);
    if (this.keys.has('s') || this.keys.has('arrowdown')) move.sub(forward);
    if (this.keys.has('d') || this.keys.has('arrowright')) move.add(right);
    if (this.keys.has('a') || this.keys.has('arrowleft')) move.sub(right);
    if (move.lengthSq() === 0) return;
    move.normalize().multiplyScalar(speed);
    this.camera.position.add(move);
    this.controls.target.add(move);
  }

  render() {
    const dt = Math.min(0.1, this.clock.getDelta());
    const season = this.game.date.season;
    if (season !== this.season) {
      this.season = season;
      this.paintTerrain(season);
      for (const [uid, obj] of this.buildingObjs) {
        const b = this.game.state.buildings.find((x) => x.uid === uid);
        if (b) applySeason(obj, b.defId, season);
      }
    }
    if (this.game.structureVersion !== this.structureVersion) {
      this.structureVersion = this.game.structureVersion;
      this.syncBuildings();
      this.syncMoats();
    }
    const t = this.clock.elapsedTime;
    for (const b of this.game.state.buildings) {
      const obj = this.buildingObjs.get(b.uid);
      if (!obj) continue;
      const def = getBuilding(b.defId);
      if (def.herd) updateHerd(obj, def, Math.round(b.herd ?? 0));
      if (def.id === 'charcoal_kiln') {
        const smoke = obj.children.find((c) => c.userData.smoke);
        smoke?.children.forEach((p, i) => {
          const k = (t * 0.4 + i / 3) % 1;
          p.position.y = 0.5 + k * 1.2;
          p.scale.setScalar(0.6 + k);
        });
      }
    }
    this.panWithKeys(dt);
    const tg = this.controls.target;
    const lim = this.game.terrain.size;
    tg.x = THREE.MathUtils.clamp(tg.x, 0, lim);
    tg.z = THREE.MathUtils.clamp(tg.z, 0, lim);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
