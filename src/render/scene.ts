import * as THREE from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { addFog, makeWater, shared } from './effects';
import { SiegeView } from './siegeView';
import { mixNumber, seasonMix, type Season, type SeasonMix } from '../game/data/calendar';
import { getBuilding } from '../game/data/buildings';
import type { Game } from '../game/sim/game';
import type { PlacedBuilding } from '../game/sim/state';
import { animate, applySeason, buildModel, LINKED_TYPES, MASONRY_WALLS, ROAD_FAMILY, updateHerd, WALL_FAMILY, type Link, type ModelCtx } from './models';
import { StaticBatches } from './batches';
import { ArmyView, SIDE_COLORS } from './armies';
import { mats } from './kit';
import type { Footprint } from './terrain';
import { TerrainView, WATER_LEVEL } from './terrain';
import { textures } from './textures';

export type Quality = 'high' | 'medium' | 'low';

const SUN_ELEVATION: Record<Season, number> = { spring: 38, summer: 52, autumn: 30, winter: 20 };
const SUN_COLOR: Record<Season, number> = { spring: 0xfff0d8, summer: 0xfff0d8, autumn: 0xffe2b8, winter: 0xf4f0ff };
const SUN_INTENSITY: Record<Season, number> = { spring: 2.4, summer: 2.4, autumn: 2.3, winter: 1.9 };
const HEMI_GROUND: Record<Season, number> = { spring: 0x5a4a30, summer: 0x5a4a30, autumn: 0x5a4a30, winter: 0xb8c0c8 };
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
  /** Chiave visiva di ogni edificio: se cambia, il modello si ricostruisce. */
  private visualKeys = new Map<number, string>();
  /** Edifici con parti animate (bandiere, fumo, animali, colture). */
  private animated: Array<{ b: PlacedBuilding; obj: THREE.Object3D; herd: boolean }> = [];
  private batches = new StaticBatches();
  private frustum = new THREE.Frustum();
  private tmpMat = new THREE.Matrix4();
  private tmpSphere = new THREE.Sphere();
  private armyView!: ArmyView;
  private shadowDirty = true;
  private shadowCenter = new THREE.Vector3(1e9, 0, 0);
  private shadowHalf = 0;
  private linePreview: THREE.InstancedMesh;
  private structureVersion = -1;
  /** Chiave della sfumatura stagionale applicata (si aggiorna a piccoli passi). */
  private mixKey = '';
  private envKey = '';
  private mix: SeasonMix = { from: 'spring', to: 'summer', t: 0 };
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
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // Le ombre si ricalcolano solo quando serve (vedi render)
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.82;
    this.pmrem = new THREE.PMREMGenerator(this.renderer);

    const size = game.terrain.size;
    const [hx, hz] = game.homeSite();
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 600);
    this.camera.position.set(hx - 4, 22, hz + 24);

    this.controls = new MapControls(this.camera, canvas);
    this.controls.target.set(hx, 0, hz);
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

    // Densità dell'erba proporzionata alla dimensione della mappa
    const area = (64 / size) ** 2;
    this.terrainView = new TerrainView(game.terrain, Math.max(3, Math.round((quality === 'high' ? 15 : quality === 'medium' ? 9 : 4) * area)));
    this.scene.add(this.terrainView.group);
    if (game.terrain.sites.length > 1) this.addTerritoryBorder();
    // Nebbia di guerra: una texture con una casella per pixel, sui materiali del terreno
    const n = game.terrain.size;
    this.fogTex = new THREE.DataTexture(new Uint8Array(n * n * 4), n, n);
    this.fogTex.magFilter = THREE.LinearFilter;
    this.fogTex.minFilter = THREE.LinearFilter;
    shared.uFog.value = this.fogTex;
    shared.uFogSize.value = n;
    shared.uFogOn.value = 1;
    this.terrainView.group.traverse((o) => {
      if (o instanceof THREE.Mesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) addFog(m);
    });
    this.updateFog();
    this.armyView = new ArmyView(game, this.terrainView);
    this.scene.add(this.armyView.group);
    this.siegeView = new SiegeView(game, this.terrainView);
    this.scene.add(this.siegeView.group);

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
    addFog(this.water.material as THREE.Material);
    this.scene.add(this.water);

    this.selection = new THREE.Mesh(
      new THREE.RingGeometry(0.45, 0.55, 40),
      new THREE.MeshBasicMaterial({ color: 0xffd54a, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    this.scene.add(this.batches.group);
    // Anteprima delle file di mura/strade durante il trascinamento
    this.linePreview = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.92, 0.1, 0.92),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55, depthWrite: false }),
      256,
    );
    this.linePreview.count = 0;
    this.linePreview.frustumCulled = false;
    this.scene.add(this.linePreview);
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
    // L'occlusione ambientale è morbida: calcolarla a metà risoluzione non si nota e costa 4 volte meno
    const aoSetSize = this.aoPass.setSize.bind(this.aoPass);
    this.aoPass.setSize = (w: number, h: number) => aoSetSize(Math.max(1, Math.floor(w / 2)), Math.max(1, Math.floor(h / 2)));
    this.composer.addPass(this.aoPass);
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.18, 0.5, 0.9);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());

    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).closest('input, textarea, select') || e.ctrlKey || e.metaKey) return;
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
    this.basePixelRatio = q === 'high' ? Math.min(dpr, 2) : q === 'medium' ? Math.min(dpr, 1.5) : 1;
    this.renderer.setPixelRatio(this.basePixelRatio * this.renderScale);
    const map = q === 'high' ? 4096 : q === 'medium' ? 2048 : 1024;
    if (this.sun.shadow.mapSize.x !== map) {
      this.sun.shadow.mapSize.set(map, map);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
      this.shadowDirty = true;
    }
    this.sun.shadow.radius = q === 'low' ? 1 : 2.5;
    this.aoPass.enabled = q !== 'low';
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

  private applySeasonLook(m: SeasonMix, refreshEnv: boolean) {
    const elev = THREE.MathUtils.degToRad(mixNumber(m, SUN_ELEVATION));
    const azim = THREE.MathUtils.degToRad(215);
    this.sunDir.setFromSphericalCoords(1, Math.PI / 2 - elev, azim);
    this.sky.material.uniforms.sunPosition.value.copy(this.sunDir);
    const col = (t: Record<Season, number>) => new THREE.Color(t[m.from]).lerp(new THREE.Color(t[m.to]), m.t);
    this.sun.color.copy(col(SUN_COLOR));
    this.sun.intensity = mixNumber(m, SUN_INTENSITY);
    this.hemi.groundColor.copy(col(HEMI_GROUND));
    (this.scene.fog as THREE.Fog).color.copy(col(FOG));
    this.terrainView.setSeasonMix(m);
    shared.uSnow.value = mixNumber(m, { spring: 0, summer: 0, autumn: 0, winter: 1 });
    if (!refreshEnv) return;

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

  /**
   * L'ombra copre la zona inquadrata (così resta nitida). Si ricentra solo quando la
   * telecamera si è spostata abbastanza: in mezzo, la mappa delle ombre non va ricalcolata.
   */
  private updateSunShadow() {
    const tg = this.controls.target;
    const dist = this.camera.position.distanceTo(tg);
    const half = THREE.MathUtils.clamp(Math.ceil((dist * 1.15) / 6) * 6, 12, 66);
    const moved = Math.hypot(tg.x - this.shadowCenter.x, tg.z - this.shadowCenter.z);
    if (half === this.shadowHalf && moved < half * 0.25) return;
    const cam = this.sun.shadow.camera;
    this.shadowHalf = half;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = 1;
    cam.far = 220;
    cam.updateProjectionMatrix();
    const texel = (half * 2) / this.sun.shadow.mapSize.x;
    const cx = Math.round(tg.x / texel) * texel;
    const cz = Math.round(tg.z / texel) * texel;
    this.shadowCenter.set(cx, 0, cz);
    this.sun.target.position.set(cx, 0, cz);
    this.sun.position.set(cx + this.sunDir.x * 90, this.sunDir.y * 90, cz + this.sunDir.z * 90);
    this.sun.target.updateMatrixWorld();
    this.shadowDirty = true;
  }

  // ───────────── Edifici ─────────────

  /** Collegamenti in 8 direzioni verso i vicini della stessa famiglia (diagonali solo se non c'è già un angolo). */
  private linksFor(b: PlacedBuilding, family: Set<string>, extend: boolean): Link[] {
    const fam = (x: number, z: number) => {
      const o = this.game.structureAt(x, z);
      return o && o.uid !== b.uid && family.has(o.defId) ? o : null;
    };
    const extFor = (o: PlacedBuilding, diag: boolean) => {
      if (!extend) return 0;
      const def = getBuilding(o.defId);
      if (def.fort === 'keep') return diag ? 0.4 : 0.45;
      if (def.fort === 'gate' && def.size[0] === 1) return diag ? 0.05 : 0;
      if (def.size[0] > 1 || def.size[1] > 1) return diag ? 0.25 : 0.3;
      return 0;
    };
    const out: Link[] = [];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const o = fam(b.x + dx, b.z + dz);
      if (o) out.push({ dx, dz, ext: extFor(o, false) });
    }
    for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      if (fam(b.x + dx, b.z) || fam(b.x, b.z + dz)) continue;
      const o = fam(b.x + dx, b.z + dz);
      if (o) out.push({ dx, dz, ext: extFor(o, true) });
    }
    return out;
  }

  private ctxFor(b: PlacedBuilding): ModelCtx {
    const def = getBuilding(b.defId);
    const ctx: ModelCtx = {
      seed: b.uid * 7919 + b.x * 31 + b.z,
      upgrades: [...(def.builtIn ?? []), ...(b.upgrades ?? [])],
      state: this.game.hpState(b),
    };
    if ((b.level ?? 1) > 1) ctx.level = b.level;
    if (this.game.isForeign(b)) {
      if (b.site !== undefined && b.site < 4) ctx.site = b.site;
      else if (b.site === 4) ctx.works = true;
    } else if (this.game.siteByUid(b.uid)) ctx.site = this.game.siteStageOf(b.uid);
    else if (this.game.jobFor(b.uid)) ctx.works = true;
    if (def.id === 'road' || def.id === 'road_paved' || def.id === 'bridge') ctx.links = this.linksFor(b, ROAD_FAMILY, false);
    else if (LINKED_TYPES.has(def.id)) ctx.links = this.linksFor(b, WALL_FAMILY, true);
    if (def.fort === 'gate') {
      const [w, d] = def.size;
      ctx.moatDir = null;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const x = dx > 0 ? b.x + w : dx < 0 ? b.x - 1 : b.x;
        const z = dz > 0 ? b.z + d : dz < 0 ? b.z - 1 : b.z;
        if (this.game.isMoat(x, z)) ctx.moatDir = [dx, dz];
      }
    }
    if (MASONRY_WALLS.has(def.id)) {
      // Verso l'esterno della cinta: dove le caselle vicine sono raggiungibili da fuori
      let ox = 0;
      let oz = 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const x = b.x + dx;
        const z = b.z + dz;
        if (x < 0 || z < 0 || x >= this.game.terrain.size || z >= this.game.terrain.size) continue;
        if (!this.game.buildingAt(x, z) && !this.game.isInside(x, z)) {
          ox += dx;
          oz += dz;
        }
      }
      if (ox || oz) ctx.outDir = [ox, oz];
    }
    if (def.id === 'moat') {
      ctx.depth = this.game.moatDepth(b);
      ctx.flooded = this.game.moatFlooded(b);
    }
    return ctx;
  }

  private makeObject(b: PlacedBuilding, ctx: ModelCtx): THREE.Object3D {
    const def = getBuilding(b.defId);
    const obj = buildModel(def, ctx);
    const y = def.id === 'bridge' ? 0 : this.terrainView.baseLevel(b.x, b.z, def.size[0], def.size[1]);
    obj.position.set(b.x + def.size[0] / 2, y, b.z + def.size[1] / 2);
    obj.userData.uid = b.uid;
    applySeason(obj, def.id, this.mix);
    if (def.herd) updateHerd(obj, def, Math.round(b.herd ?? 0));
    return obj;
  }

  private disposeObject(obj: THREE.Object3D) {
    this.scene.remove(obj);
    obj.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
  }

  /** Confini tra i territori: cippi di pietra dove cambia il castello più vicino. */
  private addTerritoryBorder() {
    const size = this.game.terrain.size;
    const pts: Array<[number, number]> = [];
    for (let z = 0; z < size; z++) {
      for (let x = 0; x < size; x++) {
        const o = this.game.ownerAt(x, z);
        if (x + 1 < size && this.game.ownerAt(x + 1, z) !== o && (z % 2 === 0)) pts.push([x + 1, z + 0.5]);
        if (z + 1 < size && this.game.ownerAt(x, z + 1) !== o && (x % 2 === 0)) pts.push([x + 0.5, z + 1]);
      }
    }
    const stones = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.06, 0.09, 0.45, 6).translate(0, 0.2, 0),
      new THREE.MeshStandardMaterial({ color: 0xcfc6b0, roughness: 0.9 }),
      Math.max(1, pts.length),
    );
    const m = new THREE.Matrix4();
    pts.forEach(([x, z], i) => {
      m.makeTranslation(x, this.terrainView.heightAt(x, z), z);
      stones.setMatrixAt(i, m);
    });
    stones.count = pts.length;
    stones.castShadow = true;
    this.scene.add(stones);
  }

  private flagMats = new Map<number, THREE.Material>();
  private ownerFlag(owner: number): THREE.Material {
    if (!this.flagMats.has(owner)) {
      this.flagMats.set(owner, new THREE.MeshStandardMaterial({ color: SIDE_COLORS[(owner + 1) % SIDE_COLORS.length], roughness: 0.9, side: THREE.DoubleSide }));
    }
    return this.flagMats.get(owner)!;
  }

  private allBuildings(): PlacedBuilding[] {
    // Gli edifici degli altri si vedono solo se scoperti (o se sono di un alleato)
    return [...this.game.state.buildings, ...this.game.sites(), ...this.game.others.filter((b) => this.game.isRevealed(b))];
  }

  private syncBuildings() {
    const alive = new Set<number>();
    for (const b of this.allBuildings()) {
      alive.add(b.uid);
      const ctx = this.ctxFor(b);
      const key = JSON.stringify(ctx);
      if (this.visualKeys.get(b.uid) === key) continue;
      const old = this.buildingObjs.get(b.uid);
      if (old) this.disposeObject(old);
      const obj = this.makeObject(b, ctx);
      // Gli edifici dell'avversario hanno bandiere blu
      if (this.game.isForeign(b)) {
        const m = b.owner !== undefined ? this.ownerFlag(b.owner) : mats().flagBlue;
        obj.traverse((o) => {
          if (o instanceof THREE.Mesh && (o.material === mats().flag || o.material === mats().flagGold)) o.material = m;
        });
      }
      this.scene.add(obj);
      // Le parti statiche vanno nei blocchi fusi; l'oggetto tiene solo quelle animate
      this.batches.set(b.uid, obj, b.x, b.z);
      this.buildingObjs.set(b.uid, obj);
      this.visualKeys.set(b.uid, key);
    }
    for (const [uid, obj] of this.buildingObjs) {
      if (!alive.has(uid)) {
        this.disposeObject(obj);
        this.batches.remove(uid);
        this.buildingObjs.delete(uid);
        this.visualKeys.delete(uid);
      }
    }
    this.batches.flush();
    this.animated = [];
    for (const b of this.allBuildings()) {
      const obj = this.buildingObjs.get(b.uid);
      const herd = !!getBuilding(b.defId).herd;
      if (obj && (obj.children.length || herd)) this.animated.push({ b, obj, herd });
    }
    const fps: Footprint[] = [];
    for (const b of this.allBuildings()) {
      if (b.defId === 'bridge') continue;
      const [w, d] = getBuilding(b.defId).size;
      fps.push({
        x: b.x,
        z: b.z,
        w,
        d,
        defId: b.defId,
        depth: b.defId === 'moat' ? this.game.moatDepth(b) : undefined,
        dry: b.defId === 'moat' ? !this.game.moatFlooded(b) : undefined,
      });
    }
    this.terrainView.setFootprints(fps);
    this.shadowDirty = true;
  }

  /** Anteprima di una fila di caselle (verde = si può, rosso = no). */
  setLinePreview(tiles: Array<{ x: number; z: number; ok: boolean }> | null) {
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    const list = tiles ?? [];
    this.linePreview.count = Math.min(list.length, 256);
    for (let i = 0; i < this.linePreview.count; i++) {
      m.makeTranslation(list[i].x + 0.5, 0.1 + this.terrainView.baseLevel(list[i].x, list[i].z, 1, 1), list[i].z + 0.5);
      this.linePreview.setMatrixAt(i, m);
      this.linePreview.setColorAt(i, c.setHex(list[i].ok ? 0x4caf50 : 0xe53935));
    }
    this.linePreview.instanceMatrix.needsUpdate = true;
    if (this.linePreview.instanceColor) this.linePreview.instanceColor.needsUpdate = true;
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
    this.ghost.position.set(tile.x + def.size[0] / 2, 0.02 + this.terrainView.baseLevel(tile.x, tile.z, def.size[0], def.size[1]), tile.z + def.size[1] / 2);
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
    this.selection.position.set(b.x + def.size[0] / 2, 0.08 + this.terrainView.baseLevel(b.x, b.z, def.size[0], def.size[1]), b.z + def.size[1] / 2);
    this.selection.visible = true;
  }

  /** Punto del terreno sotto il puntatore (coordinate continue). */
  pickPoint(clientX: number, clientY: number): { x: number; z: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const p = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.ground, p)) return null;
    return { x: p.x, z: p.z };
  }

  /** Posizione sullo schermo (pixel nel canvas) di un punto del terreno. */
  toScreen(x: number, z: number): { x: number; y: number; visible: boolean } {
    const v = new THREE.Vector3(x, this.terrainView.heightAt(x, z), z).project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height, visible: v.z < 1 };
  }

  /** Sposta la telecamera su un punto mantenendo l'inquadratura. */
  focus(x: number, z: number) {
    const off = this.camera.position.clone().sub(this.controls.target);
    this.controls.target.set(x, 0, z);
    this.camera.position.copy(this.controls.target).add(off);
  }

  setSelectedCompanies(ids: string[]) {
    this.armyView.setSelected(ids);
  }

  /** Abilita/disabilita il trascinamento della mappa col tasto sinistro. */
  setLeftPan(enabled: boolean) {
    this.controls.mouseButtons.LEFT = enabled ? THREE.MOUSE.PAN : (null as unknown as THREE.MOUSE);
  }

  /**
   * Telecamera da tastiera: W/S avanti e indietro, A/D gira attorno al punto inquadrato,
   * Q/E inclina la vista, frecce ←/→ spostano di lato. Lo zoom resta sulla rotellina.
   */
  private panWithKeys(dt: number) {
    const k = this.keys;
    const tg = this.controls.target;
    const off = this.camera.position.clone().sub(tg);
    // Rotazione e inclinazione attorno al punto inquadrato
    const turn = (k.has('d') ? 1 : 0) - (k.has('a') ? 1 : 0);
    const tilt = (k.has('e') ? 1 : 0) - (k.has('q') ? 1 : 0);
    if (turn || tilt) {
      const sph = new THREE.Spherical().setFromVector3(off);
      sph.theta += turn * 1.6 * dt;
      sph.phi = THREE.MathUtils.clamp(sph.phi - tilt * 0.9 * dt, 0.2, this.controls.maxPolarAngle);
      off.setFromSpherical(sph);
      this.camera.position.copy(tg).add(off);
    }
    const speed = 18 * dt * (off.length() / 30);
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));
    const move = new THREE.Vector3();
    if (k.has('w') || k.has('arrowup')) move.add(forward);
    if (k.has('s') || k.has('arrowdown')) move.sub(forward);
    if (k.has('arrowright')) move.add(right);
    if (k.has('arrowleft')) move.sub(right);
    if (move.lengthSq() === 0) return;
    move.normalize().multiplyScalar(speed);
    this.camera.position.add(move);
    tg.add(move);
  }


  private fogTex: THREE.DataTexture;
  private siegeView: SiegeView;
  /** Risoluzione adattiva: se il computer fatica si abbassa un po' la risoluzione interna. */
  private basePixelRatio = 1;
  private renderScale = 1;
  private perfTime = 0;
  private perfFrames = 0;

  private adaptResolution(dt: number) {
    this.perfTime += dt;
    this.perfFrames++;
    if (this.perfTime < 2) return;
    const avg = this.perfTime / this.perfFrames;
    this.perfTime = 0;
    this.perfFrames = 0;
    let next = this.renderScale;
    if (avg > 1 / 30 && this.renderScale > 0.6) next = Math.max(0.6, this.renderScale - 0.1);
    else if (avg < 1 / 55 && this.renderScale < 1) next = Math.min(1, this.renderScale + 0.05);
    if (next === this.renderScale) return;
    this.renderScale = next;
    this.renderer.setPixelRatio(Math.max(0.5, this.basePixelRatio * next));
    this.resize();
  }
  private syncTimer = 1;
  private fogTimer = 0;
  private revealVersion = -1;

  /** Aggiorna cosa si vede e la texture della nebbia. */
  private updateFog() {
    this.game.updateVision();
    const { vis, exp } = this.game.fogGrids();
    // Si ricarica la texture sulla scheda video solo se qualcosa è cambiato
    const d = this.fogTex.image.data as Uint8Array;
    let changed = false;
    for (let i = 0; i < vis.length; i++) {
      const v = vis[i] ? 255 : exp[i] ? 128 : 0;
      if (d[i * 4] === v && d[i * 4 + 3] === 255) continue;
      d[i * 4] = v;
      d[i * 4 + 1] = v;
      d[i * 4 + 2] = v;
      d[i * 4 + 3] = 255;
      changed = true;
    }
    if (changed) this.fogTex.needsUpdate = true;
    if (this.game.revealVersion !== this.revealVersion) {
      this.revealVersion = this.game.revealVersion;
      this.syncBuildings();
    }
  }

  render() {
    this.timer.update();
    const dt = Math.min(0.1, this.timer.getDelta());
    const t = this.timer.getElapsed();
    shared.uTime.value = t;
    this.adaptResolution(dt);
    // Stagioni sfumate: si aggiorna a passi di 1/20 della transizione (ridipingere il terreno costa)
    const m = seasonMix(this.game.state.day);
    const key = `${m.from}:${Math.round(m.t * 20)}`;
    if (key !== this.mixKey) {
      this.mixKey = key;
      this.mix = { ...m, t: Math.round(m.t * 20) / 20 };
      const envKey = `${m.from}:${Math.round(m.t * 2)}`;
      this.applySeasonLook(this.mix, envKey !== this.envKey);
      this.envKey = envKey;
      this.shadowDirty = true;
      for (const [uid, obj] of this.buildingObjs) {
        const b = this.game.byUid(uid) ?? this.game.siteByUid(uid);
        if (b) applySeason(obj, b.defId, this.mix);
      }
    }
    // Ricostruire gli edifici costa: al massimo ~7 volte al secondo (ad alta velocità i cantieri cambiano di continuo)
    this.syncTimer += dt;
    if (this.game.structureVersion !== this.structureVersion && this.syncTimer > 0.15) {
      this.syncTimer = 0;
      this.structureVersion = this.game.structureVersion;
      this.syncBuildings();
    }
    const frustum = this.frustum.setFromProjectionMatrix(this.tmpMat.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
    const sphere = this.tmpSphere;
    for (const { b, obj, herd } of this.animated) {
      const def = getBuilding(b.defId);
      if (herd) updateHerd(obj, def, Math.round(b.herd ?? 0));
      sphere.set(obj.position, Math.max(def.size[0], def.size[1]) + 2);
      if (frustum.intersectsSphere(sphere)) animate(obj, t, dt);
    }
    this.fogTimer += dt;
    if (this.fogTimer > 0.25) {
      this.fogTimer = 0;
      this.updateFog();
    }
    this.armyView.update(t);
    for (const o of this.armyView.objects()) animate(o, t, dt);
    this.siegeView.update(dt);
    for (const o of this.siegeView.group.children) animate(o, t, dt);
    const n = this.water.material as THREE.MeshStandardMaterial;
    n.normalMap!.offset.set(t * 0.012, t * 0.008);

    this.panWithKeys(dt);
    const tg = this.controls.target;
    const lim = this.game.terrain.size;
    tg.x = THREE.MathUtils.clamp(tg.x, 0, lim);
    tg.z = THREE.MathUtils.clamp(tg.z, 0, lim);
    this.controls.update();
    this.updateSunShadow();
    // Mappa delle ombre: solo quando cambia qualcosa (costruzioni, stagione, inquadratura).
    // Ciò che si muove di continuo non proietta ombre: così il ritmo dei fotogrammi resta regolare.
    if (this.shadowDirty) {
      this.renderer.shadowMap.needsUpdate = true;
      this.shadowDirty = false;
    }
    if (this.aoPass.enabled) this.composer.render(dt);
    else {
      // Senza AO si salta il composer (più veloce); il tone mapping lo fa il renderer
      this.renderer.render(this.scene, this.camera);
    }
  }
}
