import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { makeWater, shared } from './effects';
import type { Season } from '../game/data/calendar';
import { getBuilding } from '../game/data/buildings';
import type { Game } from '../game/sim/game';
import type { PlacedBuilding } from '../game/sim/state';
import { animate, applySeason, buildModel, LINKED_TYPES, updateHerd, WALL_FAMILY, type WallLinks } from './models';
import { TerrainView, WATER_LEVEL } from './terrain';
import { textures } from './textures';

export type Quality = 'high' | 'medium' | 'low';

const SUN_ELEVATION: Record<Season, number> = { spring: 38, summer: 52, autumn: 30, winter: 20 };
const FOG: Record<Season, number> = { spring: 0xc6d6e2, summer: 0xbcd2e4, autumn: 0xcfc8b8, winter: 0xd8dee4 };

export interface PointerTile {
  x: number;
  z: number;
}

export class WorldRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: MapControls;
  readonly terrainView: TerrainView;
  private composer: EffectComposer;
  private aoPass: GTAOPass;
  private bloomPass: UnrealBloomPass;
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
  private hemi: THREE.HemisphereLight;
  private sky: Sky;
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private sunDir = new THREE.Vector3();
  private water: THREE.Mesh;
  private timer = new THREE.Timer();
  private quality: Quality = 'high';

  constructor(private canvas: HTMLCanvasElement, private game: Game, quality: Quality = 'high') {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.82;
    this.pmrem = new THREE.PMREMGenerator(this.renderer);

    const size = game.terrain.size;
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 600);
    this.camera.position.set(size / 2 - 4, 22, size / 2 + 24);

    this.controls = new MapControls(this.camera, canvas);
    this.controls.target.set(size / 2, 0, size / 2);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 80;
    this.controls.maxPolarAngle = 1.3;
    this.controls.screenSpacePanning = false;

    // Cielo fisico, usato anche come ambiente per i riflessi
    this.sky = new Sky();
    this.sky.scale.setScalar(450);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 4;
    u.rayleigh.value = 1.4;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.85;
    this.scene.add(this.sky);
    this.scene.fog = new THREE.Fog(FOG.summer, 70, 220);

    this.hemi = new THREE.HemisphereLight(0xcfe0ff, 0x4a3e2a, 0.35);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff0d8, 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun, this.sun.target);

    this.terrainView = new TerrainView(game.terrain, quality === 'high' ? 10 : quality === 'medium' ? 6 : 3);
    this.scene.add(this.terrainView.group);

    // Acqua animata con mappa delle normali procedurale
    const normals = textures().waterNormals;
    normals.repeat.set(size / 3, size / 3);
    this.water = new THREE.Mesh(
      new THREE.PlaneGeometry(size + 440, size + 440),
      new THREE.MeshStandardMaterial({
        color: 0x1f4f66,
        roughness: 0.08,
        metalness: 0.1,
        transparent: true,
        opacity: 0.88,
        normalMap: normals,
        normalScale: new THREE.Vector2(0.35, 0.35),
        envMapIntensity: 0.9,
      }),
    );
    makeWater(this.water.material as THREE.MeshStandardMaterial, {
      height: this.terrainView.heightTexture,
      min: TerrainView.H_MIN,
      range: TerrainView.H_RANGE,
      res: this.terrainView.grid.res,
      n: this.terrainView.grid.n,
      level: WATER_LEVEL,
    });
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.set(size / 2, WATER_LEVEL, size / 2);
    this.water.receiveShadow = true;
    this.scene.add(this.water);

    this.selection = new THREE.Mesh(
      new THREE.RingGeometry(0.45, 0.55, 40),
      new THREE.MeshBasicMaterial({ color: 0xffd54a, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    this.selection.rotation.x = -Math.PI / 2;
    this.selection.visible = false;
    this.scene.add(this.selection);

    // Post-processing: occlusione ambientale (GTAO) + uscita con tone mapping
    // Render target multicampionato: l'antialiasing resta anche con il post-processing
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.aoPass = new GTAOPass(this.scene, this.camera, 512, 512);
    this.aoPass.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.5, scale: 1.2, samples: 12 });
    this.aoPass.blendIntensity = 0.85;
    this.composer.addPass(this.aoPass);
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.18, 0.5, 0.9);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());

    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).closest('input, textarea, select')) return;
      this.keys.add(e.key.toLowerCase());
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('resize', () => this.resize());
    this.setQuality(quality);
  }

  // ───────────── Qualità ─────────────

  setQuality(q: Quality) {
    this.quality = q;
    const dpr = window.devicePixelRatio || 1;
    this.renderer.setPixelRatio(q === 'high' ? Math.min(dpr, 2) : q === 'medium' ? Math.min(dpr, 1.5) : 1);
    const map = q === 'high' ? 4096 : q === 'medium' ? 2048 : 1024;
    if (this.sun.shadow.mapSize.x !== map) {
      this.sun.shadow.mapSize.set(map, map);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.sun.shadow.radius = q === 'low' ? 1 : 2.5;
    this.aoPass.enabled = q === 'high';
    this.bloomPass.enabled = q === 'high';
    this.terrainView.setDetail(q !== 'low');
    this.resize();
  }

  get currentQuality(): Quality {
    return this.quality;
  }

  private resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ───────────── Stagioni e luce ─────────────

  private applySeasonLook(season: Season) {
    const elev = THREE.MathUtils.degToRad(SUN_ELEVATION[season]);
    const azim = THREE.MathUtils.degToRad(215);
    this.sunDir.setFromSphericalCoords(1, Math.PI / 2 - elev, azim);
    this.sky.material.uniforms.sunPosition.value.copy(this.sunDir);
    this.sun.color.setHex(season === 'winter' ? 0xf4f0ff : season === 'autumn' ? 0xffe2b8 : 0xfff0d8);
    this.sun.intensity = season === 'winter' ? 1.9 : 2.4;
    this.hemi.groundColor.setHex(season === 'winter' ? 0xb8c0c8 : 0x5a4a30);
    (this.scene.fog as THREE.Fog).color.setHex(FOG[season]);
    this.terrainView.setSeason(season);
    shared.uSnow.value = season === 'winter' ? 1 : 0;

    // Ambiente per i riflessi, ricavato dal cielo
    const skyScene = new THREE.Scene();
    const skyCopy = new Sky();
    skyCopy.scale.setScalar(450);
    for (const k of Object.keys(this.sky.material.uniforms)) {
      const src = this.sky.material.uniforms[k].value;
      const dst = skyCopy.material.uniforms[k];
      dst.value = src instanceof THREE.Vector3 ? src.clone() : src;
    }
    skyScene.add(skyCopy);
    this.envRT?.dispose();
    this.envRT = this.pmrem.fromScene(skyScene, 0.02);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = 0.3;
    skyCopy.geometry.dispose();
    skyCopy.material.dispose();
  }

  /** L'ombra copre solo la zona inquadrata, così resta nitida. */
  private updateSunShadow() {
    const tg = this.controls.target;
    const dist = this.camera.position.distanceTo(tg);
    const half = THREE.MathUtils.clamp(dist * 0.95, 10, 60);
    const cam = this.sun.shadow.camera;
    if (cam.right !== half) {
      cam.left = -half;
      cam.right = half;
      cam.top = half;
      cam.bottom = -half;
      cam.near = 1;
      cam.far = 200;
      cam.updateProjectionMatrix();
    }
    // Aggancia il centro ai texel per evitare lo sfarfallio delle ombre
    const texel = (half * 2) / this.sun.shadow.mapSize.x;
    const cx = Math.round(tg.x / texel) * texel;
    const cz = Math.round(tg.z / texel) * texel;
    this.sun.target.position.set(cx, 0, cz);
    this.sun.position.set(cx + this.sunDir.x * 80, this.sunDir.y * 80, cz + this.sunDir.z * 80);
    this.sun.target.updateMatrixWorld();
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
    const links = LINKED_TYPES.has(def.id) ? this.linksFor(b) : undefined;
    const obj = buildModel(def, links, b.uid * 7919 + b.x * 31 + b.z);
    obj.position.set(b.x + def.size[0] / 2, 0, b.z + def.size[1] / 2);
    obj.userData.uid = b.uid;
    obj.userData.links = JSON.stringify(links ?? null);
    if (this.season) applySeason(obj, def.id, this.season);
    if (def.herd) updateHerd(obj, def, Math.round(b.herd ?? 0));
    return obj;
  }

  private disposeObject(obj: THREE.Object3D) {
    this.scene.remove(obj);
    obj.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
  }

  private syncBuildings() {
    const alive = new Set<number>();
    for (const b of this.game.state.buildings) {
      alive.add(b.uid);
      const existing = this.buildingObjs.get(b.uid);
      if (existing) {
        // Mura e porte cambiano aspetto quando cambiano i vicini
        if (LINKED_TYPES.has(b.defId) && existing.userData.links !== JSON.stringify(this.linksFor(b))) {
          this.disposeObject(existing);
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
        this.disposeObject(obj);
        this.buildingObjs.delete(uid);
      }
    }
    this.terrainView.setFootprints(
      this.game.state.buildings.map((b) => {
        const [w, d] = getBuilding(b.defId).size;
        return { x: b.x, z: b.z, w, d, defId: b.defId };
      }),
    );
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
      if (this.ghost) this.disposeObject(this.ghost);
      this.ghost = null;
      this.ghostDef = defId;
      if (defId) {
        const def = getBuilding(defId);
        const g = buildModel(def);
        const base = new THREE.Mesh(
          new THREE.BoxGeometry(def.size[0], 0.04, def.size[1]),
          new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.45, depthWrite: false }),
        );
        base.position.y = 0.05;
        base.userData.base = true;
        g.add(base);
        g.traverse((o) => {
          if (o instanceof THREE.Mesh && !o.userData.base) {
            const m = (o.material as THREE.Material).clone() as THREE.MeshStandardMaterial;
            m.transparent = true;
            m.opacity = 0.6;
            m.depthWrite = false;
            o.material = m;
            o.castShadow = false;
          }
        });
        if (def.id === 'moat') {
          const water = new THREE.Mesh(new THREE.BoxGeometry(1, 0.3, 1), new THREE.MeshBasicMaterial({ color: 0x3a7ea0, transparent: true, opacity: 0.5 }));
          water.position.y = -0.1;
          g.add(water);
        }
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
    this.timer.update();
    const dt = Math.min(0.1, this.timer.getDelta());
    const t = this.timer.getElapsed();
    shared.uTime.value = t;
    const season = this.game.date.season;
    if (season !== this.season) {
      this.season = season;
      this.applySeasonLook(season);
      for (const [uid, obj] of this.buildingObjs) {
        const b = this.game.state.buildings.find((x) => x.uid === uid);
        if (b) applySeason(obj, b.defId, season);
      }
    }
    if (this.game.structureVersion !== this.structureVersion) {
      this.structureVersion = this.game.structureVersion;
      this.syncBuildings();
    }
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse),
    );
    const sphere = new THREE.Sphere();
    for (const b of this.game.state.buildings) {
      const obj = this.buildingObjs.get(b.uid);
      if (!obj) continue;
      const def = getBuilding(b.defId);
      if (def.herd) updateHerd(obj, def, Math.round(b.herd ?? 0));
      sphere.set(obj.position, Math.max(def.size[0], def.size[1]) + 2);
      if (frustum.intersectsSphere(sphere)) animate(obj, t, dt);
    }
    const n = this.water.material as THREE.MeshStandardMaterial;
    n.normalMap!.offset.set(t * 0.012, t * 0.008);

    this.panWithKeys(dt);
    const tg = this.controls.target;
    const lim = this.game.terrain.size;
    tg.x = THREE.MathUtils.clamp(tg.x, 0, lim);
    tg.z = THREE.MathUtils.clamp(tg.z, 0, lim);
    this.controls.update();
    this.updateSunShadow();
    if (this.aoPass.enabled) this.composer.render(dt);
    else {
      // Senza AO si salta il composer (più veloce); il tone mapping lo fa il renderer
      this.renderer.render(this.scene, this.camera);
    }
  }
}
