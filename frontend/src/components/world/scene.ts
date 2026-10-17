/**
 * The landing world: 90 s of NGSIM trajectories at Peachtree St & 10th St replayed on a road model derived from
 * the same data (lib/lab/road.ts), with headlights, tail lights that brighten on braking, signal heads whose phase
 * is inferred from flow (./signals.ts) and SSAM conflicts flaring where and when they happened.
 *
 * Budget: every repeated part is one InstancedMesh with a shared material (bodies, glass, lamps, beams, shadows,
 * buildings, street-light poles, pools, signal lamps, conflict rings) and every light glow is one Points draw;
 * about 20 draw calls in total. No post-processing: glows are additive sprites. DPR ≤ 2. The loop stops while the
 * hero is off screen, the tab is hidden, or the replay is paused and the camera has settled.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ConflictT, IntersectionT, TrackT } from '../../lib/traj';
import { conflictPoint, renderPose } from '../../lib/lab/metrics';
import { dashes, MUTCD, offset, ribbon, roadGeometry, type XY } from '../../lib/lab/road';
import type { ThemeName } from '../../lib/lab/palette';
import { worldLook } from './look';
import { inferSignals, lampAt, type Group, type Lamp } from './signals';

export type FlareConflict = ConflictT & { overlap?: boolean };
export interface WorldState { t: number; drift: number; ut: number; up: number }
export interface HudEls { t?: HTMLElement | null; veh?: HTMLElement | null; conf?: HTMLElement | null; crit?: HTMLElement | null }
export interface WorldOpts {
  host: HTMLElement;
  labels: HTMLElement;
  data: IntersectionT;
  conflicts: FlareConflict[];
  theme: ThemeName;
  hud: HudEls;
  /** Start paused (reduced motion) on a composed frame. */
  still: boolean;
  state?: WorldState | null;
  onPlaying?: (p: boolean) => void;
}
export interface World {
  setPlaying(p: boolean): void;
  playing(): boolean;
  setActive(a: boolean): void;
  state(): WorldState;
  fps(): number;
  dispose(): void;
}

const HZ = 10;
const LABELS = 4;
const RINGS = 12;

/** World mapping: data (x across, y along corridor, north) → three (X = x, Z = −y), Y up. */
const W = (x: number, y: number, h = 0) => new THREE.Vector3(x, h, -y);

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hashId = (id: string | number) => { let h = 2166136261; for (const c of String(id)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

function radialTexture(stops: [number, string][], w = 64, h = 64): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d')!, g = x.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.min(w, h) / 2);
  for (const [o, col] of stops) g.addColorStop(o, col);
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
/** Headlight throw on the road: a soft cone from the lamp end (u = 0) forward. */
function beamTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = 128; c.height = 64;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(0, 32, 0, 0, 32, 128);
  g.addColorStop(0, 'rgba(255,255,255,0.95)'); g.addColorStop(0.35, 'rgba(255,255,255,0.4)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.beginPath(); x.moveTo(0, 26); x.lineTo(128, 0); x.lineTo(128, 64); x.lineTo(0, 38); x.closePath();
  x.fillStyle = g; x.filter = 'blur(6px)'; x.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

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
const RING_VS = /* glsl */`
attribute float aAlpha; attribute vec3 aCol;
varying vec2 vUv; varying float vA; varying vec3 vC;
void main() { vUv = uv; vA = aAlpha; vC = aCol; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`;
const RING_FS = /* glsl */`
uniform float uAdd;
varying vec2 vUv; varying float vA; varying vec3 vC;
void main() {
  float r = length(vUv * 2.0 - 1.0);
  if (r > 1.0 || vA <= 0.0) discard;
  float ring = smoothstep(0.80, 0.93, r) * (1.0 - smoothstep(0.93, 1.0, r));
  float a = (ring + 0.16 * (1.0 - r)) * vA;
  gl_FragColor = uAdd > 0.5 ? vec4(vC * a, a) : vec4(vC, a);
  #include <colorspace_fragment>
}`;
const SKY_VS = /* glsl */`varying vec3 vP; void main() { vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const SKY_FS = /* glsl */`
uniform vec3 uZen; uniform vec3 uHor; varying vec3 vP;
void main() { float h = clamp(vP.y, 0.0, 1.0); gl_FragColor = vec4(mix(uHor, uZen, pow(h, 0.55)), 1.0);
  #include <colorspace_fragment>
}`;

export function createWorld(o: WorldOpts): World {
  const { host, data, theme } = o;
  const L = worldLook(theme);
  const C = (h: string) => new THREE.Color(h);
  const dur = data.window_s;
  const tracks = data.tracks;
  const N = tracks.length;

  /* ---------- renderer, scene, sky, lights ---------- */
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = L.exposure;
  const cvs = renderer.domElement;
  cvs.className = 'wd-gl';
  host.prepend(cvs);

  const scene = new THREE.Scene();
  const hor = C(L.horizon);
  scene.background = hor;
  scene.fog = new THREE.Fog(hor, L.fogNear, L.fogFar);
  const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), new THREE.ShaderMaterial({
    vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false,
    uniforms: { uZen: { value: C(L.zenith) }, uHor: { value: hor } },
  }));
  sky.renderOrder = -10;
  scene.add(sky);
  scene.add(new THREE.HemisphereLight(L.hemiSky, L.hemiGround, L.hemi));
  const moon = new THREE.DirectionalLight(L.moon, L.moonI); moon.position.set(-60, 90, 40); scene.add(moon);

  const flat = (g: THREE.BufferGeometry) => { g.rotateX(-Math.PI / 2); return g; };
  const basic = (col: string, extra: THREE.MeshBasicMaterialParameters = {}) => new THREE.MeshBasicMaterial({ color: col, ...extra });

  /* ---------- ground and road (derived from the trajectories; stylised beyond the study area) ---------- */
  const ground = new THREE.Mesh(flat(new THREE.PlaneGeometry(1600, 1600)), basic(L.lot));
  ground.position.y = -0.02;
  scene.add(ground);

  const road = roadGeometry(data);
  const [[, by0], [, by1]] = data.bbox as [[number, number], [number, number]];
  const FAR_S = -320, FAR_N = 360, FAR_W = -300, FAR_E = 300;
  const asphaltGeos: THREE.BufferGeometry[] = [];
  const poly = (pts: XY[]) => asphaltGeos.push(flat(new THREE.ShapeGeometry(new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y))))));
  const quad = (x0: number, y0: number, x1: number, y1: number) => poly([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
  road.arms.forEach((a) => poly(a));
  let xL = Infinity, xR = -Infinity;
  for (const a of road.arms) {
    const n = a.length / 2;
    const ySouth = a[0][1], yNorth = a[n - 1][1];
    for (const p of a) { xL = Math.min(xL, p[0]); xR = Math.max(xR, p[0]); }
    // continue the arm straight beyond the study area with its end cross-section (stylised context)
    if (ySouth <= by0 + 3) quad(a[0][0], FAR_S, a[a.length - 1][0], ySouth + 0.5);
    if (yNorth >= by1 - 3) quad(a[n - 1][0], yNorth - 0.5, a[n][0], FAR_N);
  }
  const cross = road.cross;
  const yC0 = cross?.y0 ?? -10, yC1 = cross?.y1 ?? 10, yCm = (yC0 + yC1) / 2;
  if (cross) {
    quad(cross.x0, cross.y0, cross.x1, cross.y1);
    quad(FAR_W, cross.y0, cross.x0 + 0.5, cross.y1);
    quad(cross.x1 - 0.5, cross.y0, FAR_E, cross.y1);
  }
  const asphalt = mergeGeometries(asphaltGeos.map((g) => g.toNonIndexed()));
  asphaltGeos.forEach((g) => g.dispose());
  if (asphalt) scene.add(new THREE.Mesh(asphalt, basic(L.asphalt)));

  // markings: MUTCD dimensions, true-width ribbons, one draw call
  {
    const mp: number[] = [], mc: number[] = [];
    const add = (tri: number[], hex: string, h = 0.012) => { const c = C(hex); for (let i = 0; i < tri.length; i += 2) { mp.push(tri[i], h, -tri[i + 1]); mc.push(c.r, c.g, c.b); } };
    const w = MUTCD.line * 1.6;
    const draw = (kind: string, pts: XY[]) => {
      if (pts.length < 2) return;
      if (kind === 'lane') for (const d of dashes(pts)) add(ribbon(d, w), L.lane);
      else if (kind === 'edge') add(ribbon(pts, w), L.edge);
      else { const d = (MUTCD.line + MUTCD.yellowGap) / 2; add(ribbon(offset(pts, -d), w), L.centre); add(ribbon(offset(pts, d), w), L.centre); }
    };
    for (const l of road.lines) {
      draw(l.kind, l.pts);
      const first = l.pts[0], last = l.pts[l.pts.length - 1];
      if (first[1] <= by0 + 3) draw(l.kind, [[first[0], FAR_S], first]);
      if (last[1] >= by1 - 3) draw(l.kind, [last, [last[0], FAR_N]]);
    }
    for (const b of road.stops) add(ribbon([b.a, b.b], MUTCD.bar), L.stop, 0.014);
    if (cross) {
      const half = (yC1 - yC0) / 2;
      for (const [xa, xb] of [[FAR_W, cross.x0 - 1], [cross.x1 + 1, FAR_E]]) {
        draw('centre', [[xa, yCm], [xb, yCm]]);
        draw('edge', [[xa, yC0 + 0.5], [xb, yC0 + 0.5]]); draw('edge', [[xa, yC1 - 0.5], [xb, yC1 - 0.5]]);
        if (half > 6.5) { draw('lane', [[xa, yCm - half / 2], [xb, yCm - half / 2]]); draw('lane', [[xa, yCm + half / 2], [xb, yCm + half / 2]]); }
      }
    }
    const mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.Float32BufferAttribute(mp, 3)); mg.setAttribute('color', new THREE.Float32BufferAttribute(mc, 3));
    scene.add(new THREE.Mesh(mg, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })));
  }
  // kerb line around the derived carriageway
  {
    const kerb: number[] = [];
    for (const a of road.arms) for (let i = 0; i < a.length; i++) { const p = a[i], q = a[(i + 1) % a.length]; kerb.push(p[0], 0.01, -p[1], q[0], 0.01, -q[1]); }
    const kg = new THREE.BufferGeometry(); kg.setAttribute('position', new THREE.Float32BufferAttribute(kerb, 3));
    scene.add(new THREE.LineSegments(kg, new THREE.LineBasicMaterial({ color: L.kerb })));
  }
  const xWest = Math.min(xL, cross?.x0 ?? xL), xEast = Math.max(xR, cross?.x1 ?? xR);

  /* ---------- abstract low-rise massing (stylised context, not surveyed) ---------- */
  const glowP: number[] = [], glowC: number[] = [], glowS: number[] = [], glowA: number[] = [];
  const addGlow = (p: THREE.Vector3, col: string, size: number, a: number) => { const c = C(col); glowP.push(p.x, p.y, p.z); glowC.push(c.r, c.g, c.b); glowS.push(size); glowA.push(a); };
  {
    const rand = mulberry(1016);
    const boxes: { x: number; y: number; w: number; d: number; h: number }[] = [];
    const quads: [number, number, number, number, number, number][] = [
      // [x from, x to (outward), y from, y to (outward)]: sign of outward direction derived from bounds
      [xWest - 7, FAR_W + 60, yC0 - 7, FAR_S + 60, -1, -1],
      [xEast + 7, FAR_E - 60, yC0 - 7, FAR_S + 60, 1, -1],
      [xWest - 7, FAR_W + 60, yC1 + 7, FAR_N - 60, -1, 1],
      [xEast + 7, FAR_E - 60, yC1 + 7, FAR_N - 60, 1, 1],
    ];
    for (const [xa, xb, ya, yb, sx, sy] of quads) {
      const cell = 30;
      const nx = Math.floor(Math.abs(xb - xa) / cell), ny = Math.floor(Math.abs(yb - ya) / cell);
      for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
        if (rand() < 0.22) continue;
        const w = 12 + rand() * 15, d = 12 + rand() * 15;
        const cx = xa + sx * (i * cell + 2 + w / 2 + rand() * (cell - w - 4));
        const cy = ya + sy * (j * cell + 2 + d / 2 + rand() * (cell - d - 4));
        const dist = Math.hypot(cx, cy - 10);
        const hMax = dist < 70 ? 14 : dist < 140 ? 24 : 34;
        boxes.push({ x: cx, y: cy, w, d, h: 5 + rand() * (hMax - 5) });
      }
    }
    const geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const seeds = new Float32Array(boxes.length);
    boxes.forEach((_, i) => { seeds[i] = rand() * 100; });
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
    const mat = new THREE.MeshLambertMaterial({ color: L.building });
    const winCol = C(L.window), roofCol = C(L.roof);
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uWin = { value: L.windowAmt };
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
    scene.add(mesh);
  }

  /* ---------- street lights along both kerbs (stylised context) ---------- */
  {
    const spots: { x: number; y: number; dir: 1 | -1; along: 'y' | 'x' }[] = [];
    for (let y = FAR_S + 20; y < FAR_N - 20; y += 36) {
      if (y > yC0 - 6 && y < yC1 + 6) continue;
      spots.push({ x: xWest - 1.4, y, dir: 1, along: 'y' }, { x: xEast + 1.4, y: y + 18, dir: -1, along: 'y' });
    }
    for (let x = FAR_W + 20; x < FAR_E - 20; x += 36) {
      if (x > xWest - 6 && x < xEast + 6) continue;
      spots.push({ x, y: yC0 - 1.4, dir: 1, along: 'x' }, { x: x + 18, y: yC1 + 1.4, dir: -1, along: 'x' });
    }
    const H = 9, ARM = 2.4;
    const poleGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.09, 0.13, H, 6).translate(0, H / 2, 0),
      new THREE.BoxGeometry(ARM, 0.1, 0.1).translate(ARM / 2, H - 0.1, 0),
      new THREE.BoxGeometry(0.6, 0.14, 0.3).translate(ARM, H - 0.2, 0),
    ])!;
    const poles = new THREE.InstancedMesh(poleGeo, new THREE.MeshLambertMaterial({ color: L.pole }), spots.length);
    const pools = new THREE.InstancedMesh(flat(new THREE.PlaneGeometry(1, 1)), new THREE.MeshBasicMaterial({
      map: radialTexture([[0, 'rgba(255,255,255,1)'], [0.4, 'rgba(255,255,255,0.45)'], [1, 'rgba(255,255,255,0)']]),
      color: C(L.lamp).multiplyScalar(L.pool), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }), spots.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    spots.forEach((s, i) => {
      // arm points toward the carriageway: +x for the west kerb, −x for the east; ±y (world ∓z) on the cross street
      const ang = s.along === 'y' ? (s.dir > 0 ? 0 : Math.PI) : (s.dir > 0 ? Math.PI / 2 : -Math.PI / 2);
      q.setFromAxisAngle(up, ang);
      m.compose(W(s.x, s.y), q, new THREE.Vector3(1, 1, 1)); poles.setMatrixAt(i, m);
      const head = W(s.x, s.y).add(new THREE.Vector3(ARM, 0, 0).applyQuaternion(q));
      m.compose(new THREE.Vector3(head.x, 0.005, head.z), new THREE.Quaternion(), new THREE.Vector3(20, 1, 20)); pools.setMatrixAt(i, m);
      addGlow(new THREE.Vector3(head.x, H - 0.35, head.z), L.lamp, L.dark ? 2.6 : 1.6, L.lampGlow);
    });
    scene.add(poles);
    if (L.pool > 0) { pools.renderOrder = 2; scene.add(pools); }
  }

  /* ---------- signal heads at the derived stop bars; phase inferred from flow ---------- */
  const nbBar = road.stops.find((s) => s.dir === 'NB'), sbBar = road.stops.find((s) => s.dir === 'SB');
  const plan = inferSignals(tracks, { nbBar: nbBar?.a[1] ?? null, sbBar: sbBar?.a[1] ?? null, xMid: cross ? (cross.x0 + cross.x1) / 2 : 0 }, dur, HZ);
  interface Head { g: Group; lamps: THREE.Vector3[]; rotY: number }
  const heads: Head[] = [];
  const sigLamps = new THREE.InstancedMesh(new THREE.CircleGeometry(0.13, 16), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), 32);
  {
    const parts: THREE.BufferGeometry[] = [];
    const POLE_H = 6.4, HEAD_Y = 5.6;
    const mk = (g: Group, base: XY, armTo: XY, at: XY[], rotY: number) => {
      const b = W(base[0], base[1]), e = W(armTo[0], armTo[1]);
      parts.push(new THREE.CylinderGeometry(0.14, 0.17, POLE_H, 8).translate(b.x, POLE_H / 2, b.z));
      const len = b.distanceTo(e), mid = b.clone().add(e).multiplyScalar(0.5);
      const arm = new THREE.BoxGeometry(len, 0.14, 0.14);
      arm.rotateY(-Math.atan2(e.z - b.z, e.x - b.x)); arm.translate(mid.x, POLE_H - 0.2, mid.z);
      parts.push(arm);
      for (const p of at) {
        const c = W(p[0], p[1], HEAD_Y);
        const housing = new THREE.BoxGeometry(0.38, 1.08, 0.3); housing.rotateY(rotY); housing.translate(c.x, c.y, c.z);
        parts.push(housing, new THREE.BoxGeometry(0.05, POLE_H - 0.2 - HEAD_Y - 0.54, 0.05).translate(c.x, (POLE_H - 0.2 + HEAD_Y + 0.54) / 2, c.z));
        const face = new THREE.Vector3(Math.sin(rotY), 0, Math.cos(rotY));
        heads.push({ g, rotY, lamps: [0.34, 0, -0.34].map((dy) => c.clone().add(new THREE.Vector3(0, dy, 0)).addScaledVector(face, 0.16)) });
      }
    };
    if (nbBar) { const [a, b] = [nbBar.a, nbBar.b]; mk('ns', [b[0] + 1.3, a[1] - 0.8], [a[0] + 0.6, a[1] - 0.8], [[a[0] + (b[0] - a[0]) * 0.3, a[1] - 0.8], [a[0] + (b[0] - a[0]) * 0.72, a[1] - 0.8]], 0); }
    if (sbBar) { const [a, b] = [sbBar.a, sbBar.b]; mk('ns', [a[0] - 1.3, a[1] + 0.8], [b[0] - 0.6, a[1] + 0.8], [[b[0] - (b[0] - a[0]) * 0.3, a[1] + 0.8], [b[0] - (b[0] - a[0]) * 0.72, a[1] + 0.8]], Math.PI); }
    if (cross) {
      const xE = cross.x0 - 1.2, xW = cross.x1 + 1.2;
      mk('ew', [xE, yC0 - 1.3], [xE, yCm - 0.6], [[xE, yC0 + (yCm - yC0) * 0.35], [xE, yC0 + (yCm - yC0) * 0.78]], -Math.PI / 2);
      mk('ew', [xW, yC1 + 1.3], [xW, yCm + 0.6], [[xW, yC1 - (yC1 - yCm) * 0.35], [xW, yC1 - (yC1 - yCm) * 0.78]], Math.PI / 2);
    }
    const sg = mergeGeometries(parts.map((p) => p.toNonIndexed()));
    parts.forEach((p) => p.dispose());
    if (sg) scene.add(new THREE.Mesh(sg, new THREE.MeshLambertMaterial({ color: L.housing })));
    const m = new THREE.Matrix4(), q = new THREE.Quaternion();
    let k = 0;
    heads.forEach((h) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), h.rotY);
      for (const p of h.lamps) { m.compose(p, q, new THREE.Vector3(1, 1, 1)); sigLamps.setMatrixAt(k++, m); }
    });
    sigLamps.count = k;
    scene.add(sigLamps);
  }
  const SIG = [C(L.sigRed), C(L.sigAmber), C(L.sigGreen)], SIG_OFF = C(L.sigOff);
  const SIG_HEX = [L.sigRed, L.sigAmber, L.sigGreen];

  /* ---------- vehicles: instanced bodies, glass, lamps, beams and shadows ---------- */
  const body = mergeGeometries([
    new THREE.BoxGeometry(1, 0.56, 1).translate(0, 0.5, 0),
    new THREE.BoxGeometry(0.5, 0.05, 0.84).translate(-0.07, 1.27, 0),
  ])!;
  const glassGeo = new THREE.BoxGeometry(0.56, 0.48, 0.88).translate(-0.06, 1.02, 0);
  const lampGeo = (x: number) => mergeGeometries([new THREE.BoxGeometry(0.03, 0.09, 0.2).translate(x, 0.62, 0.32), new THREE.BoxGeometry(0.03, 0.09, 0.2).translate(x, 0.62, -0.32)])!;
  const mkInst = (g: THREE.BufferGeometry, m: THREE.Material, n = N) => {
    const im = new THREE.InstancedMesh(g, m, n);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.frustumCulled = false;
    scene.add(im);
    return im;
  };
  const bodies = mkInst(body, new THREE.MeshLambertMaterial({ color: 0xffffff }));
  const glass = mkInst(glassGeo, new THREE.MeshLambertMaterial({ color: L.glass }));
  const headM = mkInst(lampGeo(0.505), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
  const tailM = mkInst(lampGeo(-0.505), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
  const shadowM = mkInst(flat(new THREE.PlaneGeometry(1, 1)), new THREE.MeshBasicMaterial({
    map: radialTexture([[0, 'rgba(255,255,255,1)'], [0.55, 'rgba(255,255,255,0.5)'], [1, 'rgba(255,255,255,0)']]),
    color: L.shadow, transparent: true, opacity: L.shadowA, depthWrite: false,
  }));
  shadowM.renderOrder = 1;
  const beamGeo = flat(new THREE.PlaneGeometry(1, 1)).translate(0.5, 0, 0);
  const beamM = L.beam > 0 ? mkInst(beamGeo, new THREE.MeshBasicMaterial({ map: beamTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false })) : null;
  if (beamM) beamM.renderOrder = 2;
  for (const im of [bodies, headM, tailM, ...(beamM ? [beamM] : [])]) im.setColorAt(0, C('#000000'));
  const bodyCol = tracks.map((tr) => C(tr.cls === 'truck' ? L.bodies[3] : L.bodies[hashId(tr.id) % L.bodies.length]));
  const heightOf = (tr: TrackT) => (tr.cls === 'truck' ? 2.2 : tr.len_m > 5.4 ? 1.25 : 1);
  const bodyFade = C(L.lot), cHead = C(L.head), cTail = C(L.tail), cBrake = C(L.brake), cTailOff = C(L.tailOff), cBeam = C(L.head).multiplyScalar(L.beam);
  const t0s = tracks.map((tr) => tr.pts[0]?.[0] ?? 0), t1s = tracks.map((tr) => tr.pts[tr.pts.length - 1]?.[0] ?? 0);

  /* ---------- conflict flares at their real place and time; overlap flags excluded ---------- */
  const byId = new Map(tracks.map((tr) => [String(tr.id), tr]));
  const flares = o.conflicts
    .filter((c) => !c.overlap)
    .map((c) => { const p = conflictPoint(c, byId.get(String(c.a)), byId.get(String(c.b)), HZ); return p ? { c, x: p.x, y: p.y, crit: c.severity === 'critical', s: (c.t0 ?? c.t - 0.3) - 0.3, e: (c.t1 ?? c.t + 0.3) + 1.8 } : null; })
    .filter((f): f is NonNullable<typeof f> => !!f)
    .sort((a, b) => a.c.t - b.c.t);
  // a conflict counts from its first frame (t0), when its flare is already visible
  const confTimes = flares.map((f) => f.s + 0.3).sort((a, b) => a - b), critTimes = flares.filter((f) => f.crit).map((f) => f.s + 0.3).sort((a, b) => a - b);
  const ringGeo = flat(new THREE.PlaneGeometry(2, 2));
  const ringA = new THREE.InstancedBufferAttribute(new Float32Array(RINGS), 1).setUsage(THREE.DynamicDrawUsage);
  const ringC = new THREE.InstancedBufferAttribute(new Float32Array(RINGS * 3), 3).setUsage(THREE.DynamicDrawUsage);
  ringGeo.setAttribute('aAlpha', ringA); ringGeo.setAttribute('aCol', ringC);
  const rings = new THREE.InstancedMesh(ringGeo, new THREE.ShaderMaterial({
    vertexShader: RING_VS, fragmentShader: RING_FS, transparent: true, depthWrite: false, toneMapped: false,
    blending: L.glowAdd ? THREE.AdditiveBlending : THREE.NormalBlending, uniforms: { uAdd: { value: L.glowAdd ? 1 : 0 } },
  }), RINGS);
  rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage); rings.frustumCulled = false; rings.renderOrder = 3;
  scene.add(rings);
  const cConf = C(L.conflict), cCrit = C(L.critical);

  /* ---------- light glows: one Points for every lamp in the world ---------- */
  const STATIC_GLOWS = glowS.length;
  const GLOWS = STATIC_GLOWS + N * 4 + heads.length + RINGS;
  const gPos = new Float32Array(GLOWS * 3), gCol = new Float32Array(GLOWS * 3), gSize = new Float32Array(GLOWS), gAlpha = new Float32Array(GLOWS);
  gPos.set(glowP); gCol.set(glowC); gSize.set(glowS); gAlpha.set(glowA);
  const glowGeo = new THREE.BufferGeometry();
  const attr = (a: Float32Array, n: number) => new THREE.BufferAttribute(a, n).setUsage(THREE.DynamicDrawUsage);
  glowGeo.setAttribute('position', attr(gPos, 3)); glowGeo.setAttribute('color', attr(gCol, 3));
  glowGeo.setAttribute('size', attr(gSize, 1)); glowGeo.setAttribute('alpha', attr(gAlpha, 1));
  const glowMat = new THREE.ShaderMaterial({
    vertexShader: GLOW_VS, fragmentShader: GLOW_FS, transparent: true, depthWrite: false, toneMapped: false,
    blending: L.glowAdd ? THREE.AdditiveBlending : THREE.NormalBlending,
    uniforms: { uScale: { value: 400 }, uMaxPx: { value: 160 }, uFog: { value: new THREE.Vector2(L.fogNear, L.fogFar) }, uAdd: { value: L.glowAdd ? 1 : 0 } },
  });
  const glows = new THREE.Points(glowGeo, glowMat);
  glows.frustumCulled = false; glows.renderOrder = 4;
  scene.add(glows);
  const setGlow = (i: number, p: THREE.Vector3, c: THREE.Color, size: number, a: number) => {
    gPos[i * 3] = p.x; gPos[i * 3 + 1] = p.y; gPos[i * 3 + 2] = p.z;
    gCol[i * 3] = c.r; gCol[i * 3 + 1] = c.g; gCol[i * 3 + 2] = c.b; gSize[i] = size; gAlpha[i] = a;
  };

  /* ---------- labels (DOM, pooled) ---------- */
  const labelEls = Array.from({ length: LABELS }, () => {
    const el = document.createElement('span');
    el.className = 'wd-label'; el.hidden = true;
    o.labels.appendChild(el);
    return { el, id: -1 };
  });

  /* ---------- camera: slow drifting dolly, drag to orbit (wheel never captured) ---------- */
  const camera = new THREE.PerspectiveCamera(32, 1, 1, 1400);
  const target = W(2, 6);
  const st: WorldState = { t: 0, drift: 0, ut: 0, up: 0, ...(o.state ?? {}) };
  let ut = st.ut, up = st.up; // damped user offsets
  let w = 1, h = 1;
  const placeCamera = () => {
    const d = st.drift;
    const aspect = w / h;
    const theta = 0.72 + 0.5 * Math.sin(d * 0.045) + ut;
    const phi = Math.min(1.25, Math.max(0.2, 0.5 + 0.07 * Math.sin(d * 0.06 + 1) + up));
    const R = (aspect < 0.8 ? 112 : aspect < 1.25 ? 108 : 98) * (1 + 0.07 * Math.sin(d * 0.05));
    const tg = target.clone().add(new THREE.Vector3(0, 0, -9 * Math.sin(d * 0.03)));
    camera.position.set(tg.x + R * Math.cos(phi) * Math.sin(theta), R * Math.sin(phi), tg.z + R * Math.cos(phi) * Math.cos(theta));
    camera.lookAt(tg);
  };
  const resize = () => {
    const r = host.getBoundingClientRect();
    w = Math.max(1, Math.round(r.width)); h = Math.max(1, Math.round(r.height));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // put the intersection right of the copy on wide screens, below it on tall ones
    const aspect = w / h;
    if (aspect > 1.25) camera.setViewOffset(w, h, -w * 0.14, h * 0.02, w, h);
    else if (aspect < 0.8) camera.setViewOffset(w, h, 0, h * 0.06, w, h);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
    const dpr = renderer.getPixelRatio();
    glowMat.uniforms.uScale.value = (h * dpr) / (2 * Math.tan((camera.fov * Math.PI) / 360));
    glowMat.uniforms.uMaxPx.value = 90 * dpr;
    dirty = true; kick();
  };

  /* ---------- per-frame update ---------- */
  const m4 = new THREE.Matrix4(), qv = new THREE.Quaternion(), yAxis = new THREE.Vector3(0, 1, 0), sv = new THREE.Vector3(), pv = new THREE.Vector3();
  const fwd = new THREE.Vector3(), side = new THREE.Vector3(), tmpC = new THREE.Color();
  const HIDE = new THREE.Matrix4().makeScale(0, 0, 0);
  const lastLamp: Record<Group, Lamp | -1> = { ns: -1, ew: -1 };
  const proj = new THREE.Vector3();
  const count = (arr: number[], t: number) => { let lo = 0, hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= t) lo = mid + 1; else hi = mid; } return lo; };
  let lastHud = -1;

  const update = (t: number) => {
    let gi = STATIC_GLOWS, visible = 0;
    for (let i = 0; i < N; i++) {
      const tr = tracks[i];
      const base = gi + i * 4;
      const p = t >= t0s[i] && t <= t1s[i] ? renderPose(tr, t, HZ, [0, dur]) : null;
      if (!p || p.fade <= 0.01) {
        bodies.setMatrixAt(i, HIDE); glass.setMatrixAt(i, HIDE); headM.setMatrixAt(i, HIDE); tailM.setMatrixAt(i, HIDE); shadowM.setMatrixAt(i, HIDE); beamM?.setMatrixAt(i, HIDE);
        for (let k = 0; k < 4; k++) gSize[base + k] = 0;
        continue;
      }
      if (p.fade > 0.5) visible++;
      const f = p.fade;
      qv.setFromAxisAngle(yAxis, p.h);
      pv.set(p.x, 0, -p.y);
      sv.set(tr.len_m, heightOf(tr), tr.w_m);
      m4.compose(pv, qv, sv);
      bodies.setMatrixAt(i, m4); glass.setMatrixAt(i, m4); headM.setMatrixAt(i, m4); tailM.setMatrixAt(i, m4);
      bodies.setColorAt(i, tmpC.copy(bodyFade).lerp(bodyCol[i], f));
      headM.setColorAt(i, tmpC.copy(cHead).multiplyScalar(f));
      const br = p.brake;
      tailM.setColorAt(i, tmpC.copy(cTailOff).lerp(cBrake, L.dark ? 0.55 + 0.45 * br : br).multiplyScalar(f));
      sv.set(tr.len_m * 1.25, 1, tr.w_m * 1.7); m4.compose(pv, qv, sv); shadowM.setMatrixAt(i, m4);
      fwd.set(Math.cos(p.h), 0, -Math.sin(p.h)); side.set(Math.sin(p.h), 0, Math.cos(p.h));
      if (beamM) {
        const moving = Math.min(1, 0.35 + p.v / 6);
        sv.set(15, 1, 7.5); m4.compose(pv.clone().addScaledVector(fwd, tr.len_m / 2 - 0.2).setY(0.02), qv, sv); beamM.setMatrixAt(i, m4);
        beamM.setColorAt(i, tmpC.copy(cBeam).multiplyScalar(f * moving));
      }
      const hy = 0.62, hw = tr.w_m / 2 - 0.32;
      const front = pv.clone().addScaledVector(fwd, tr.len_m / 2 + 0.05).setY(hy), back = pv.clone().addScaledVector(fwd, -tr.len_m / 2 - 0.05).setY(hy);
      const hs = L.dark ? 2.3 : 1.1, ha = (L.dark ? 0.85 : 0.45) * f;
      setGlow(base, front.clone().addScaledVector(side, hw), cHead, hs, ha);
      setGlow(base + 1, front.clone().addScaledVector(side, -hw), cHead, hs, ha);
      const ts = (L.dark ? 1.0 : 0.8) + 1.5 * br, ta = ((L.dark ? 0.42 : 0.3) + 0.58 * br) * f;
      setGlow(base + 2, back.clone().addScaledVector(side, hw), cTail, ts, ta);
      setGlow(base + 3, back.clone().addScaledVector(side, -hw), cTail, ts, ta);
    }
    gi += N * 4;
    for (const im of [bodies, glass, headM, tailM, shadowM, ...(beamM ? [beamM] : [])]) {
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }

    // signals
    const lamps: Record<Group, Lamp> = { ns: lampAt(plan, 'ns', t), ew: lampAt(plan, 'ew', t) };
    if (lamps.ns !== lastLamp.ns || lamps.ew !== lastLamp.ew) {
      let k = 0;
      for (const hd of heads) {
        const on = lamps[hd.g];
        // lamp order in a head: red (top), yellow, green
        [0, 1, 2].forEach((slot) => { const lampIdx = (2 - slot) as Lamp; sigLamps.setColorAt(k++, lampIdx === on ? SIG[lampIdx] : SIG_OFF); });
      }
      if (sigLamps.instanceColor) sigLamps.instanceColor.needsUpdate = true;
      lastLamp.ns = lamps.ns; lastLamp.ew = lamps.ew;
    }
    heads.forEach((hd, j) => {
      const on = lamps[hd.g];
      setGlow(gi + j, hd.lamps[2 - on], C(SIG_HEX[on]), L.dark ? 3.6 : 2.2, L.dark ? 1 : 0.75);
    });
    gi += heads.length;

    // conflicts: rings, core glows and labels
    let r = 0;
    const act: { f: typeof flares[number]; u: number }[] = [];
    for (const fl of flares) { if (fl.s > t) break; if (t <= fl.e) act.push({ f: fl, u: (t - fl.s) / (fl.e - fl.s) }); }
    act.sort((a, b) => Number(b.f.crit) - Number(a.f.crit) || a.u - b.u);
    for (const { f: fl, u } of act) {
      if (r >= RINGS) break;
      const ease = 1 - Math.pow(1 - u, 3);
      const R0 = fl.crit ? 9 : 6;
      const pos = W(fl.x, fl.y, 0.05);
      m4.compose(pos, qv.identity(), sv.set(1.2 + R0 * ease, 1, 1.2 + R0 * ease));
      rings.setMatrixAt(r, m4);
      const col = fl.crit ? cCrit : cConf;
      ringA.setX(r, (1 - u) * (fl.crit ? 1 : 0.7)); ringC.setXYZ(r, col.r, col.g, col.b);
      setGlow(gi + r, pos.clone().setY(1.2), col, (fl.crit ? 7 : 4.5) * (1 - 0.5 * u), (1 - u) * (L.dark ? 0.9 : 0.55));
      r++;
    }
    for (let k = r; k < RINGS; k++) { rings.setMatrixAt(k, HIDE); ringA.setX(k, 0); gSize[gi + k] = 0; }
    rings.instanceMatrix.needsUpdate = true; ringA.needsUpdate = true; ringC.needsUpdate = true;

    // labels: the most severe live conflicts, projected
    const placed: [number, number][] = [];
    for (let k = 0; k < LABELS; k++) {
      const lab = labelEls[k];
      const a = act[k];
      if (!a || a.u > 0.8) { lab.el.hidden = true; lab.id = -1; continue; }
      const c = a.f.c;
      if (lab.id !== c.id) {
        lab.id = c.id;
        lab.el.textContent = c.ttc_min != null ? `TTC ${c.ttc_min.toFixed(2)} s` : c.pet != null ? `PET ${c.pet.toFixed(2)} s` : 'conflict';
        lab.el.dataset.crit = a.f.crit ? '1' : '';
      }
      proj.copy(W(a.f.x, a.f.y, 3.2)).project(camera);
      const x = (proj.x * 0.5 + 0.5) * w, y = (-proj.y * 0.5 + 0.5) * h;
      // never stack two labels on the same spot: the more severe (earlier in `act`) wins
      const clash = placed.some(([qx, qy]) => Math.abs(qx - x) < 84 && Math.abs(qy - y) < 26);
      const vis = !clash && proj.z < 1 && x > 8 && x < w - 8 && y > 8 && y < h - 8;
      if (vis) placed.push([x, y]);
      lab.el.hidden = !vis;
      lab.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
      lab.el.style.opacity = String(Math.min(1, (0.8 - a.u) * 5, a.u * 12));
    }

    for (const k of ['position', 'color', 'size', 'alpha']) (glowGeo.getAttribute(k) as THREE.BufferAttribute).needsUpdate = true;

    // HUD at 10 Hz
    const tk = Math.floor(t * 10);
    if (tk !== lastHud) {
      lastHud = tk;
      const mm = Math.floor(t / 60), ss = t - mm * 60;
      if (o.hud.t) o.hud.t.textContent = `${String(mm).padStart(2, '0')}:${ss.toFixed(1).padStart(4, '0')}`;
      if (o.hud.veh) o.hud.veh.textContent = String(visible);
      if (o.hud.conf) o.hud.conf.textContent = String(count(confTimes, t));
      if (o.hud.crit) o.hud.crit.textContent = String(count(critTimes, t));
    }
  };

  /* ---------- composed still: the moment with a critical conflict and the most traffic ---------- */
  if (o.still && !o.state) {
    let best = 30, bestN = -Infinity;
    for (const f of flares) {
      if (!f.crit) continue;
      const tt = f.c.t + 0.15;
      let n = 0; for (let i = 0; i < N; i++) if (tt >= t0s[i] && tt <= t1s[i]) n++;
      // prefer flares near the framed intersection centre, where the copy does not cover them
      const score = n - Math.hypot(f.x - 2, f.y - 6) * 0.8;
      if (score > bestN) { bestN = score; best = tt; }
    }
    st.t = best;
  }

  /* ---------- loop ---------- */
  let playing = !o.still, active = false, raf = 0, last = 0, dirty = true, dragging = false;
  let utT = ut, upT = up;
  let frames = 0, fpsT = 0, fpsV = 0;
  const settled = () => Math.abs(utT - ut) < 1e-4 && Math.abs(upT - up) < 1e-4;
  const frame = (now: number) => {
    raf = 0;
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    if (playing) {
      st.t += dt; if (st.t >= dur) st.t -= dur;
      st.drift += dt;
    }
    const k = 1 - Math.exp(-dt * 7);
    ut += (utT - ut) * k; up += (upT - up) * k;
    st.ut = utT; st.up = upT;
    placeCamera();
    update(st.t);
    renderer.render(scene, camera);
    dirty = false;
    frames++;
    if (now - fpsT >= 1000) { fpsV = (frames * 1000) / (now - fpsT || 1); frames = 0; fpsT = now; host.dataset.fps = fpsV.toFixed(0); }
    if (active && (playing || dragging || !settled() || dirty)) raf = requestAnimationFrame(frame);
    else last = 0;
  };
  function kick() { if (active && !raf) raf = requestAnimationFrame(frame); }

  /* ---------- input: horizontal drag orbits; vertical drag tilts with a mouse; touch keeps vertical page scroll ---------- */
  let px = 0, py = 0, pid = -1, ptype = '';
  const down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    pid = e.pointerId; ptype = e.pointerType; px = e.clientX; py = e.clientY; dragging = true;
    host.setPointerCapture?.(e.pointerId);
    host.dataset.drag = '1';
    kick();
  };
  const move = (e: PointerEvent) => {
    if (e.pointerId !== pid) return;
    const dx = e.clientX - px, dy = e.clientY - py; px = e.clientX; py = e.clientY;
    utT -= dx * 0.0055;
    if (ptype === 'mouse' || ptype === 'pen') upT = Math.min(0.7, Math.max(-0.3, upT + dy * 0.003));
    kick();
  };
  const up_ = (e: PointerEvent) => { if (e.pointerId !== pid) return; pid = -1; dragging = false; delete host.dataset.drag; kick(); };
  host.addEventListener('pointerdown', down);
  host.addEventListener('pointermove', move);
  host.addEventListener('pointerup', up_);
  host.addEventListener('pointercancel', up_);

  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();
  placeCamera();
  update(st.t);
  renderer.render(scene, camera);

  return {
    setPlaying(p) { playing = p; o.onPlaying?.(p); kick(); },
    playing: () => playing,
    setActive(a) { active = a; if (a) { last = 0; dirty = true; kick(); } else if (raf) { cancelAnimationFrame(raf); raf = 0; last = 0; } },
    state: () => ({ ...st }),
    fps: () => fpsV,
    dispose() {
      cancelAnimationFrame(raf); raf = 0; active = false;
      ro.disconnect();
      host.removeEventListener('pointerdown', down); host.removeEventListener('pointermove', move);
      host.removeEventListener('pointerup', up_); host.removeEventListener('pointercancel', up_);
      labelEls.forEach((l) => l.el.remove());
      scene.traverse((ob) => {
        const m = ob as THREE.Mesh;
        m.geometry?.dispose();
        const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
        for (const mt of mats) { for (const v of Object.values(mt)) if (v instanceof THREE.Texture) v.dispose(); mt.dispose(); }
      });
      renderer.dispose();
      renderer.forceContextLoss();
      cvs.remove();
    },
  };
}

