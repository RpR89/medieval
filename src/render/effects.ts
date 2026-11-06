import * as THREE from 'three';
import { textures } from './textures';

/**
 * Effetti nei materiali standard, iniettati con onBeforeCompile:
 * vento sulla vegetazione, acqua con profondità e schiuma, ombre delle nuvole.
 */

/** Uniform condivise, aggiornate a ogni frame dal renderer. */
export const shared = {
  uTime: { value: 0 },
  /** 0 = niente neve, 1 = inverno pieno. */
  uSnow: { value: 0 },
  /** Quanto fogliame hanno le latifoglie (1 = pieno, 0 = spoglie). */
  uLeaf: { value: 1 },
  /** Nebbia di guerra: 0 = mai visto, 0,5 = esplorato, 1 = in vista. */
  uFog: { value: null as THREE.Texture | null },
  uFogSize: { value: 64 },
  uFogOn: { value: 0 },
};

/** Nebbia di guerra: scurisce e smorza i colori delle zone non sorvegliate. */
export function addFog(mat: THREE.Material) {
  if (mat.userData.fog) return;
  mat.userData.fog = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer);
    shader.uniforms.uFog = shared.uFog;
    shader.uniforms.uFogSize = shared.uFogSize;
    shader.uniforms.uFogOn = shared.uFogOn;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vFogPos;`)
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        {
          vec4 fp = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            fp = instanceMatrix * fp;
          #endif
          vFogPos = (modelMatrix * fp).xyz;
        }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform sampler2D uFog;\nuniform float uFogSize, uFogOn;\nvarying vec3 vFogPos;`)
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
        if (uFogOn > 0.5) {
          vec2 fuv = vFogPos.xz / uFogSize;
          float fv = (fuv.x < 0.0 || fuv.y < 0.0 || fuv.x > 1.0 || fuv.y > 1.0) ? 0.5 : texture2D(uFog, fuv).r;
          float lum = fv < 0.5 ? mix(0.22, 0.58, fv * 2.0) : mix(0.58, 1.0, (fv - 0.5) * 2.0);
          vec3 grey = vec3(dot(gl_FragColor.rgb, vec3(0.3, 0.59, 0.11)));
          gl_FragColor.rgb = mix(grey, gl_FragColor.rgb, 0.35 + 0.65 * fv) * lum;
        }`,
      );
  };
  chainKey(mat, 'fog');
  mat.needsUpdate = true;
}

/** Le chiome si restringono verso il centro man mano che le foglie cadono. */
export function addLeafScale(mat: THREE.Material, center = 1.0) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer);
    shader.uniforms.uLeaf = shared.uLeaf;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nuniform float uLeaf;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\ntransformed = mix(vec3(0.0, ${center.toFixed(2)}, 0.0), transformed, max(uLeaf, 0.001));`);
  };
  chainKey(mat, 'leaf');
  mat.needsUpdate = true;
}

/** Concatena le chiavi di cache dei programmi quando si combinano più effetti. */
function chainKey(mat: THREE.Material, key: string) {
  const prev = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => `${prev()}|${key}`;
}

/** Neve che si deposita sulle superfici rivolte verso l'alto (tetti, merli, chiome). */
export function addSnow(mat: THREE.Material, amount = 1) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer);
    shader.uniforms.uSnow = shared.uSnow;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vSnowN;`)
      .replace('#include <defaultnormal_vertex>', `#include <defaultnormal_vertex>\nvSnowN = inverseTransformDirection(transformedNormal, viewMatrix);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uSnow;\nvarying vec3 vSnowN;`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          float up = smoothstep(0.35, 0.75, normalize(vSnowN).y);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 0.98), uSnow * up * ${amount.toFixed(2)});
        }`,
      );
  };
  chainKey(mat, `snow${amount}`);
  mat.needsUpdate = true;
}

/**
 * Fa ondeggiare i vertici in proporzione all'altezza (y locale): chiome, erba, colture.
 * `strength` è lo spostamento in unità alla quota `height`.
 */
export function addWind(mat: THREE.Material, strength = 0.05, height = 1) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer);
    shader.uniforms.uTime = shared.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nuniform float uTime;`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          vec4 wroot = vec4(0.0, 0.0, 0.0, 1.0);
          #ifdef USE_INSTANCING
            wroot = instanceMatrix * wroot;
          #endif
          wroot = modelMatrix * wroot;
          float ph = wroot.x * 0.37 + wroot.z * 0.23;
          float k = clamp(transformed.y / ${height.toFixed(3)}, 0.0, 1.5);
          k *= k;
          float gust = 0.6 + 0.4 * sin(uTime * 0.35 + wroot.x * 0.05);
          transformed.x += sin(uTime * 1.6 + ph) * ${strength.toFixed(4)} * k * gust;
          transformed.z += cos(uTime * 1.25 + ph * 1.3) * ${(strength * 0.6).toFixed(4)} * k * gust;
        }`,
      );
  };
  chainKey(mat, `wind-${strength}-${height}`);
  mat.needsUpdate = true;
}

/** Ombre di nuvole che scorrono sul terreno. */
export function addCloudShadows(mat: THREE.Material) {
  const clouds = cloudTexture();
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer);
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uClouds = { value: clouds };
    shader.uniforms.uSnow = shared.uSnow;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vCloudPos;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvCloudPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uTime, uSnow;\nuniform sampler2D uClouds;\nvarying vec3 vCloudPos;`)
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        {
          vec2 cuv = vCloudPos.xz * 0.018 + vec2(uTime * 0.006, uTime * 0.0035);
          float c = texture2D(uClouds, cuv).r;
          float shade = mix(1.0, 0.62 + 0.13 * uSnow, smoothstep(0.45, 0.75, c));
          reflectedLight.directDiffuse *= shade;
          reflectedLight.directSpecular *= shade;
        }`,
      );
  };
  chainKey(mat, 'clouds');
  mat.needsUpdate = true;
}

export interface WaterParams {
  /** Altezze del terreno codificate in un byte: h = v * range + min. */
  height: THREE.Texture;
  min: number;
  range: number;
  /** Vertici per casella e vertici per lato della griglia delle altezze. */
  res: number;
  n: number;
  level: number;
}

/** Acqua: colore secondo la profondità, trasparenza sulle rive e schiuma. */
export function makeWater(mat: THREE.MeshStandardMaterial, p: WaterParams) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uHeight = { value: p.height };
    shader.uniforms.uHMin = { value: p.min };
    shader.uniforms.uHRange = { value: p.range };
    shader.uniforms.uRes = { value: p.res };
    shader.uniforms.uN = { value: p.n };
    shader.uniforms.uLevel = { value: p.level };
    shader.uniforms.uFoam = { value: textures().waterNormals };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWPos;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime, uHMin, uHRange, uRes, uN, uLevel;
        uniform sampler2D uHeight, uFoam;
        varying vec3 vWPos;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          vec2 huv = (vWPos.xz * uRes + 0.5) / uN;
          vec4 hs = texture2D(uHeight, clamp(huv, 0.0, 1.0));
          if (hs.g > 0.5 && huv.x <= 1.0) discard;
          float h = hs.r * uHRange + uHMin;
          // Oltre il bordo est della mappa c'è mare aperto
          if (huv.x > 1.0) h = uHMin;
          float depth = max(uLevel - h, 0.0);
          vec3 shallow = vec3(0.16, 0.42, 0.42);
          vec3 deep = vec3(0.03, 0.13, 0.2);
          float dk = smoothstep(0.0, 0.7, depth);
          diffuseColor.rgb = mix(shallow, deep, dk);
          diffuseColor.a = mix(0.45, 0.94, smoothstep(0.0, 0.35, depth));
          // Schiuma animata lungo la riva
          float n1 = texture2D(uFoam, vWPos.xz * 0.35 + vec2(uTime * 0.02, 0.0)).r;
          float n2 = texture2D(uFoam, vWPos.xz * 0.5 - vec2(0.0, uTime * 0.025)).g;
          float edge = 1.0 - smoothstep(0.0, 0.09 + 0.05 * n1, depth);
          float foam = edge * smoothstep(0.35, 0.65, n1 * 0.6 + n2 * 0.6 - 0.1 + 0.25 * sin(uTime * 1.5 + vWPos.x * 3.0));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.95, 0.95), clamp(foam + edge * 0.25, 0.0, 0.85));
          diffuseColor.a = max(diffuseColor.a, foam * 0.9);
        }`,
      );
  };
  mat.customProgramCacheKey = () => 'water';
  mat.needsUpdate = true;
}

let cloudsTex: THREE.Texture | null = null;

/** Rumore morbido e piastrellabile per le nuvole. */
function cloudTexture(): THREE.Texture {
  if (cloudsTex) return cloudsTex;
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 70; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 15 + rand() * 45;
    for (const [ox, oy] of [[0, 0], [size, 0], [-size, 0], [0, size], [0, -size]]) {
      const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      g.addColorStop(0, 'rgba(255,255,255,0.35)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  cloudsTex = t;
  return t;
}
