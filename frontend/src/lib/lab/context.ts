/**
 * World dressing shared by the landing world and the intersection lab: textures, the stylised low-rise massing,
 * street-light placement and geometry, the roadside-LiDAR unit, glow sprites and the line-of-sight test that
 * makes the simulated returns respect occlusion. Everything here is stylised context (declared as such in the
 * UI) or pure geometry; nothing reads the DOM beyond canvas texture generation.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CrossBand } from './road';
import type { Far, Street } from './street';

/* ---------- textures ---------- */

export function radialTexture(stops: [number, string][], w = 64, h = 64): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d')!, g = x.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.min(w, h) / 2);
  for (const [o, col] of stops) g.addColorStop(o, col);
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Headlight throw on the road: a soft cone from the lamp end (u = 0) forward. */
export function beamTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = 128; c.height = 64;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(0, 32, 0, 0, 32, 128);
  g.addColorStop(0, 'rgba(255,255,255,0.95)'); g.addColorStop(0.35, 'rgba(255,255,255,0.4)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.beginPath(); x.moveTo(0, 26); x.lineTo(128, 0); x.lineTo(128, 64); x.lineTo(0, 38); x.closePath();
  x.fillStyle = g; x.filter = 'blur(6px)'; x.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Fine aggregate noise (asphalt, concrete) tiled at `metres` per repeat. */
export function grainTexture(base: string, metres = 8, amount = 26, size = 256): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const x = c.getContext('2d')!;
  const col = new THREE.Color(base);
  x.fillStyle = `#${col.getHexString()}`; x.fillRect(0, 0, size, size);
  const img = x.getImageData(0, 0, size, size), d = img.data;
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * amount + (rnd() - 0.5) * amount * 0.4;
    d[i] = Math.max(0, Math.min(255, d[i] + n)); d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n)); d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  x.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1 / metres, 1 / metres);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

/** Planar UVs in metres on a flat geometry (x, z), so tiled textures stay uniform across merged shapes. */
export function planarUv(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = g.attributes.position, uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) { uv[i * 2] = pos.getX(i); uv[i * 2 + 1] = pos.getZ(i); }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

export function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/* ---------- stylised low-rise massing (context, not surveyed) ---------- */

export interface Box { x: number; y: number; w: number; d: number; h: number; seed: number }

/** Blocks on the four quadrants outside the street, denser and lower near the intersection. */
export function massing(ext: Street['ext'], far: Far, seed = 1016, setback = 7): Box[] {
  const rand = mulberry(seed);
  const { xWest, xEast, ySouth, yNorth } = ext;
  const boxes: Box[] = [];
  const quads: [number, number, number, number, number, number][] = [
    [xWest - setback, far.w + 60, ySouth - setback, far.s + 60, -1, -1],
    [xEast + setback, far.e - 60, ySouth - setback, far.s + 60, 1, -1],
    [xWest - setback, far.w + 60, yNorth + setback, far.n - 60, -1, 1],
    [xEast + setback, far.e - 60, yNorth + setback, far.n - 60, 1, 1],
  ];
  for (const [xa, xb, ya, yb, sx, sy] of quads) {
    const cell = 30;
    const nx = Math.floor(Math.abs(xb - xa) / cell), ny = Math.floor(Math.abs(yb - ya) / cell);
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      if (rand() < 0.22) continue;
      const w = 12 + rand() * 15, d = 12 + rand() * 15;
      const cx = xa + sx * (i * cell + 2 + w / 2 + rand() * (cell - w - 4));
      const cy = ya + sy * (j * cell + 2 + d / 2 + rand() * (cell - d - 4));
      const dist = Math.hypot(cx - (xWest + xEast) / 2, cy - (ySouth + yNorth) / 2);
      const hMax = dist < 70 ? 14 : dist < 140 ? 24 : 34;
      boxes.push({ x: cx, y: cy, w, d, h: 5 + rand() * (hMax - 5), seed: rand() * 100 });
    }
  }
  return boxes;
}

export interface MassingLook { building: string; roof: string; window: string; windowAmt: number }

/** Instanced blocks with a procedural façade: window grid, a share of them lit at night (windowAmt). */
export function massingMesh(boxes: Box[], look: MassingLook): THREE.InstancedMesh {
  const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const seeds = new Float32Array(boxes.length);
  boxes.forEach((b, i) => { seeds[i] = b.seed; });
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
  const mat = new THREE.MeshLambertMaterial({ color: look.building });
  const winCol = new THREE.Color(look.window), roofCol = new THREE.Color(look.roof);
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uWin = { value: look.windowAmt };
    sh.uniforms.uWinCol = { value: winCol };
    sh.uniforms.uRoof = { value: roofCol };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aSeed; varying vec3 vLoc; varying vec3 vN0; varying float vSeed;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec3 sc = vec3(1.0);
        #ifdef USE_INSTANCING
        sc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        #endif
        vLoc = position * sc; vN0 = normal; vSeed = aSeed;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uWin; uniform vec3 uWinCol; uniform vec3 uRoof; varying vec3 vLoc; varying vec3 vN0; varying float vSeed;\nfloat hsh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float facade = 1.0 - step(0.5, abs(vN0.y));
        if (vN0.y > 0.5) diffuseColor.rgb = uRoof;
        vec2 fc = abs(vN0.x) > 0.5 ? vec2(vLoc.z, vLoc.y) : vec2(vLoc.x, vLoc.y);
        vec2 cell = vec2(fc.x / 3.4, (fc.y - 1.2) / 3.6);
        vec2 f = fract(cell);
        float win = facade * step(0.0, cell.y) * step(0.22, f.x) * step(f.x, 0.78) * step(0.3, f.y) * step(f.y, 0.78);
        float lit = win * step(0.74, hsh(floor(cell) + vSeed));
        diffuseColor.rgb *= 1.0 - 0.28 * win;`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += uWinCol * lit * uWin;');
  };
  const mesh = new THREE.InstancedMesh(geo, mat, boxes.length);
  const m = new THREE.Matrix4();
  boxes.forEach((b, i) => { m.makeScale(b.w, b.h, b.d).setPosition(b.x, 0, -b.y); mesh.setMatrixAt(i, m); });
  return mesh;
}

/* ---------- street lights ---------- */

export interface LampSpot { x: number; y: number; dir: 1 | -1; along: 'y' | 'x' }
export const LAMP = { h: 9, arm: 2.4 } as const;

/** Poles every 36 m along both kerbs of the corridor and the cross street, staggered, none inside the box. */
export function streetLightSpots(ext: Street['ext'], band: CrossBand | null, far: Far, spacing = 36): LampSpot[] {
  const { xWest, xEast, ySouth, yNorth } = ext;
  const spots: LampSpot[] = [];
  for (let y = far.s + 20; y < far.n - 20; y += spacing) {
    if (y > ySouth - 6 && y < yNorth + 6) continue;
    spots.push({ x: xWest - 1.4, y, dir: 1, along: 'y' }, { x: xEast + 1.4, y: y + spacing / 2, dir: -1, along: 'y' });
  }
  for (let x = far.w + 20; x < far.e - 20; x += spacing) {
    if (x > xWest - 6 && x < xEast + 6) continue;
    const yLo = band ? band.m * x + band.b + band.edges[0] - 1.4 : ySouth - 1.4, yHi = band ? band.m * (x + spacing / 2) + band.b + band.edges[1] + 1.4 : yNorth + 1.4;
    spots.push({ x, y: yLo, dir: 1, along: 'x' }, { x: x + spacing / 2, y: yHi, dir: -1, along: 'x' });
  }
  return spots;
}

export function streetLightGeometry(): THREE.BufferGeometry {
  const { h: H, arm: ARM } = LAMP;
  return mergeGeometries([
    new THREE.CylinderGeometry(0.09, 0.13, H, 6).translate(0, H / 2, 0),
    new THREE.BoxGeometry(ARM, 0.1, 0.1).translate(ARM / 2, H - 0.1, 0),
    new THREE.BoxGeometry(0.6, 0.14, 0.3).translate(ARM, H - 0.2, 0),
  ].map((g) => g.toNonIndexed()))!;
}

/** Yaw of a pole so its arm points over the carriageway, and the world position of its lamp head. */
export function streetLightPose(s: LampSpot): { yaw: number; head: THREE.Vector3; base: THREE.Vector3 } {
  const yaw = s.along === 'y' ? (s.dir > 0 ? 0 : Math.PI) : (s.dir > 0 ? Math.PI / 2 : -Math.PI / 2);
  const base = new THREE.Vector3(s.x, 0, -s.y);
  const head = base.clone().add(new THREE.Vector3(LAMP.arm, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw)).setY(LAMP.h - 0.35);
  return { yaw, head, base };
}

/* ---------- roadside LiDAR unit ---------- */

/** A pole-mounted spinning LiDAR: pole, equipment cabinet at chest height, mounting bracket and the puck at `z` m. */
export function lidarUnitGeometry(z: number): { structure: THREE.BufferGeometry; puck: THREE.BufferGeometry } {
  const structure = mergeGeometries([
    new THREE.CylinderGeometry(0.07, 0.1, z, 10).translate(0, z / 2, 0),
    new THREE.BoxGeometry(0.32, 0.48, 0.22).translate(0, 1.35, 0.16),
    new THREE.BoxGeometry(0.22, 0.05, 0.05).translate(0, z + 0.02, 0.08),
  ].map((g) => g.toNonIndexed()))!;
  const puck = mergeGeometries([
    new THREE.CylinderGeometry(0.052, 0.052, 0.072, 24).translate(0, z + 0.085, 0.14),
    new THREE.CylinderGeometry(0.055, 0.055, 0.016, 24).translate(0, z + 0.04, 0.14),
  ].map((g) => g.toNonIndexed()))!;
  return { structure, puck };
}

/* ---------- glows: one Points draw for every lamp in a scene ---------- */

const GLOW_VS = /* glsl */`
attribute vec3 color; attribute float size; attribute float alpha;
uniform float uScale; uniform float uMaxPx; uniform vec2 uFog;
varying vec3 vC; varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = -mv.z;
  gl_PointSize = size <= 0.0 ? 0.0 : clamp(size * uScale / d, 1.5, uMaxPx);
  vC = color;
  vA = alpha * (1.0 - smoothstep(uFog.x, uFog.y, d));
}`;
const GLOW_FS = /* glsl */`
uniform float uAdd;
varying vec3 vC; varying float vA;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  float a = (exp(-r2 * 6.0) * 0.75 + exp(-r2 * 42.0) * 0.9) * (1.0 - r2) * vA;
  gl_FragColor = uAdd > 0.5 ? vec4(vC * a, a) : vec4(vC, min(1.0, a * 1.4));
  #include <colorspace_fragment>
}`;

export interface Glows {
  points: THREE.Points;
  set(i: number, p: THREE.Vector3, c: THREE.Color, size: number, alpha: number): void;
  hide(i: number): void;
  commit(): void;
  /** Call on resize: pixel scale from the viewport height, camera fov (deg) and DPR. */
  fit(hPx: number, fovDeg: number, dpr: number): void;
}

export function createGlows(capacity: number, fog: [number, number], additive: boolean): Glows {
  const pos = new Float32Array(capacity * 3), col = new Float32Array(capacity * 3), size = new Float32Array(capacity), alpha = new Float32Array(capacity);
  const geo = new THREE.BufferGeometry();
  const attr = (a: Float32Array, n: number) => new THREE.BufferAttribute(a, n).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', attr(pos, 3)); geo.setAttribute('color', attr(col, 3)); geo.setAttribute('size', attr(size, 1)); geo.setAttribute('alpha', attr(alpha, 1));
  const mat = new THREE.ShaderMaterial({
    vertexShader: GLOW_VS, fragmentShader: GLOW_FS, transparent: true, depthWrite: false, toneMapped: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    uniforms: { uScale: { value: 400 }, uMaxPx: { value: 160 }, uFog: { value: new THREE.Vector2(fog[0], fog[1]) }, uAdd: { value: additive ? 1 : 0 } },
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false; points.renderOrder = 4;
  return {
    points,
    set(i, p, c, s, a) { pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z; col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; size[i] = s; alpha[i] = a; },
    hide(i) { size[i] = 0; },
    commit() { for (const k of ['position', 'color', 'size', 'alpha']) (geo.getAttribute(k) as THREE.BufferAttribute).needsUpdate = true; },
    fit(hPx, fovDeg, dpr) { mat.uniforms.uScale.value = (hPx * dpr) / (2 * Math.tan((fovDeg * Math.PI) / 360)); mat.uniforms.uMaxPx.value = 90 * dpr; },
  };
}

/* ---------- line of sight from the sensor (occlusion of simulated returns) ---------- */

export interface Footprint { x: number; y: number; h: number; len: number; w: number }

/** True when the 2-D segment a→b crosses the oriented rectangle (centre x, y; heading h; len × w). */
export function segmentHitsFootprint(ax: number, ay: number, bx: number, by: number, f: Footprint): boolean {
  const c = Math.cos(f.h), s = Math.sin(f.h);
  // to the rectangle's frame: u along the heading, v across
  const toL = (px: number, py: number): [number, number] => { const dx = px - f.x, dy = py - f.y; return [dx * c + dy * s, -dx * s + dy * c]; };
  const [u0, v0] = toL(ax, ay), [u1, v1] = toL(bx, by);
  const hu = f.len / 2, hv = f.w / 2;
  // Liang–Barsky against |u| ≤ hu, |v| ≤ hv
  let t0 = 0, t1 = 1;
  const du = u1 - u0, dv = v1 - v0;
  for (const [p, q] of [[-du, u0 + hu], [du, hu - u0], [-dv, v0 + hv], [dv, hv - v0]] as [number, number][]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return t0 <= t1;
}

/**
 * Share of a target footprint hidden from the sensor by nearer footprints: rays to the target's centre and to the
 * points a third of its length ahead and behind; 0 = clear, 1 = fully hidden. Sorted by distance by the caller.
 */
export function occludedShare(sensorX: number, sensorY: number, target: Footprint, nearer: Footprint[]): number {
  if (!nearer.length) return 0;
  const c = Math.cos(target.h), s = Math.sin(target.h);
  let hit = 0;
  for (const k of [-1 / 3, 0, 1 / 3]) {
    const px = target.x + c * target.len * k, py = target.y + s * target.len * k;
    if (nearer.some((f) => segmentHitsFootprint(sensorX, sensorY, px, py, f))) hit++;
  }
  return hit / 3;
}
