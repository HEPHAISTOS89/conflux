/**
 * The landing world: 90 s of NGSIM trajectories at Peachtree St & 10th St replayed on a street derived from
 * the same data (lib/lab/road.ts, lib/lab/street.ts): corridor lanes, the skewed cross street fitted to the
 * EB/WB tracks, MUTCD markings and stop bars. Vehicles are class-shaped bodies (lib/lab/vehicles.ts) with
 * wheels that roll with the travelled distance and steer with the yaw rate, headlights, tail lights that
 * brighten on braking, signal heads whose phase is inferred from flow (./signals.ts) and SSAM conflicts flaring
 * where and when they happened. Duplicate and ID-switched tracks (lib/lab/quality.ts) are faded out while
 * they overlap the vehicle they duplicate, so no car is ever drawn through another.
 *
 * Budget: every repeated part is one InstancedMesh with a shared material (one body + glass + lamp set per
 * vehicle class, one wheel mesh for every wheel, beams, shadows, buildings, poles, pools, signal lamps, rings)
 * and every glow is one Points draw: about 30 draw calls. No post-processing. DPR ≤ 2. The loop stops while
 * the hero is off screen, the tab is hidden, or the replay is paused and the camera has settled.
 */
import * as THREE from 'three';
import type { ConflictT, IntersectionT } from '../../lib/traj';
import { conflictPoint, renderPose } from '../../lib/lab/metrics';
import { roadGeometry } from '../../lib/lab/road';
import { asphaltTexture, buildSignals, buildStreet } from '../../lib/lab/street';
import { conflictIsGhostPair, ghostFade, trackQuality, type Quality } from '../../lib/lab/quality';
import { cumulativeDistance, distanceAt, KINDS, kindOf, lampGeometry, steerAngle, vehicleGeometry, WHEEL, wheelGeometry, wheelOffsets, type VehicleKind } from '../../lib/lab/vehicles';
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
  /** Precomputed track quality (ghost windows); computed here when absent. */
  quality?: Quality | null;
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

/** Per-instance fade (screen-door) for an opaque instanced material: no sorting, no transparency artefacts. */
function withFade(mat: THREE.Material) {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aFade;\nvarying float vFade;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFade = aFade;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vFade;')
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (vFade < 0.999 && fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) > vFade) discard;');
  };
  return mat;
}

export function createWorld(o: WorldOpts): World {
  const { host, data, theme } = o;
  const L = worldLook(theme);
  const C = (h: string) => new THREE.Color(h);
  const dur = data.window_s;
  const tracks = data.tracks;
  const N = tracks.length;
  const quality = o.quality ?? trackQuality(tracks, HZ);

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
  // a second, low key light from the street-lit side gives the car paint a second highlight
  const key = new THREE.DirectionalLight(L.lamp, L.dark ? 0.35 : 0.2); key.position.set(50, 30, -20); scene.add(key);

  const flat = (g: THREE.BufferGeometry) => { g.rotateX(-Math.PI / 2); return g; };

  /* ---------- ground and street (derived from the trajectories; stylised beyond the study area) ---------- */
  const ground = new THREE.Mesh(flat(new THREE.PlaneGeometry(1600, 1600)), new THREE.MeshLambertMaterial({ color: L.lot }));
  ground.position.y = -0.02;
  scene.add(ground);

  const road = roadGeometry(data);
  const FAR = { s: -320, n: 360, w: -300, e: 300 };
  const street = buildStreet(road, data.bbox as [[number, number], [number, number]], {
    far: FAR, crosswalks: true, lineScale: 1.6,
    colours: { lane: L.lane, edge: L.edge, centre: L.centre, stop: L.stop, crosswalk: L.crosswalk },
  });
  const asphaltMap = asphaltTexture(L.asphalt, 9);
  if (street.asphalt) {
    const g = street.asphalt;
    // planar UVs in metres so the aggregate texture tiles evenly across arms and the band
    const pos = g.attributes.position, uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) { uv[i * 2] = pos.getX(i); uv[i * 2 + 1] = pos.getZ(i); }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    scene.add(new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: '#ffffff', map: asphaltMap })));
  }
  scene.add(new THREE.Mesh(street.markings, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })));
  scene.add(new THREE.LineSegments(street.kerbs, new THREE.LineBasicMaterial({ color: L.kerb })));
  if (street.sidewalks) scene.add(new THREE.Mesh(street.sidewalks, new THREE.MeshLambertMaterial({ color: L.walk })));
  const { xWest, xEast, ySouth: yC0, yNorth: yC1 } = street.ext;
  const yCm = (yC0 + yC1) / 2;

  /* ---------- abstract low-rise massing (stylised context, not surveyed) ---------- */
  const glowP: number[] = [], glowC: number[] = [], glowS: number[] = [], glowA: number[] = [];
  const addGlow = (p: THREE.Vector3, col: string, size: number, a: number) => { const c = C(col); glowP.push(p.x, p.y, p.z); glowC.push(c.r, c.g, c.b); glowS.push(size); glowA.push(a); };
  {
    const rand = mulberry(1016);
    const boxes: { x: number; y: number; w: number; d: number; h: number }[] = [];
    const quads: [number, number, number, number, number, number][] = [
      [xWest - 7, FAR.w + 60, yC0 - 7, FAR.s + 60, -1, -1],
      [xEast + 7, FAR.e - 60, yC0 - 7, FAR.s + 60, 1, -1],
      [xWest - 7, FAR.w + 60, yC1 + 7, FAR.n - 60, -1, 1],
      [xEast + 7, FAR.e - 60, yC1 + 7, FAR.n - 60, 1, 1],
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
    for (let y = FAR.s + 20; y < FAR.n - 20; y += 36) {
      if (y > yC0 - 6 && y < yC1 + 6) continue;
      spots.push({ x: xWest - 1.4, y, dir: 1, along: 'y' }, { x: xEast + 1.4, y: y + 18, dir: -1, along: 'y' });
    }
    const band = road.crossBand;
    for (let x = FAR.w + 20; x < FAR.e - 20; x += 36) {
      if (x > xWest - 6 && x < xEast + 6) continue;
      const yLo = band ? band.m * x + band.b + band.edges[0] - 1.4 : yC0 - 1.4, yHi = band ? band.m * (x + 18) + band.b + band.edges[1] + 1.4 : yC1 + 1.4;
      spots.push({ x, y: yLo, dir: 1, along: 'x' }, { x: x + 18, y: yHi, dir: -1, along: 'x' });
    }
    const H = 9, ARM = 2.4;
    const poleGeo = mergeGeo([
      new THREE.CylinderGeometry(0.09, 0.13, H, 6).translate(0, H / 2, 0),
      new THREE.BoxGeometry(ARM, 0.1, 0.1).translate(ARM / 2, H - 0.1, 0),
      new THREE.BoxGeometry(0.6, 0.14, 0.3).translate(ARM, H - 0.2, 0),
    ]);
    const poles = new THREE.InstancedMesh(poleGeo, new THREE.MeshLambertMaterial({ color: L.pole }), spots.length);
    const pools = new THREE.InstancedMesh(flat(new THREE.PlaneGeometry(1, 1)), new THREE.MeshBasicMaterial({
      map: radialTexture([[0, 'rgba(255,255,255,1)'], [0.4, 'rgba(255,255,255,0.45)'], [1, 'rgba(255,255,255,0)']]),
      color: C(L.lamp).multiplyScalar(L.pool), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }), spots.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    spots.forEach((s, i) => {
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

  /* ---------- signal heads on mast arms; phase inferred from flow ---------- */
  const nbBar = road.stops.find((s) => s.dir === 'NB'), sbBar = road.stops.find((s) => s.dir === 'SB');
  const plan = inferSignals(tracks, { nbBar: nbBar?.a[1] ?? null, sbBar: sbBar?.a[1] ?? null, xMid: street.ext.xMid }, dur, HZ);
  const sig = buildSignals(road, street);
  const heads = sig.heads;
  if (sig.structure) scene.add(new THREE.Mesh(sig.structure, new THREE.MeshLambertMaterial({ color: L.housing })));
  const sigLamps = new THREE.InstancedMesh(new THREE.CircleGeometry(0.13, 16), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), Math.max(1, sig.lampCount));
  {
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

  /* ---------- vehicles: one body / glass / lamp set per class, one wheel mesh, beams and shadows ---------- */
  const kinds = tracks.map(kindOf);
  const slotOf = new Int32Array(N); // instance slot inside the class's meshes
  const perKind = new Map<VehicleKind, number[]>();
  KINDS.forEach((k) => perKind.set(k, []));
  tracks.forEach((_, i) => { const arr = perKind.get(kinds[i])!; slotOf[i] = arr.length; arr.push(i); });
  interface ClassMeshes { body: THREE.InstancedMesh; glass: THREE.InstancedMesh; head: THREE.InstancedMesh; tail: THREE.InstancedMesh; fade: THREE.InstancedBufferAttribute; wheelX: [number, number] }
  const bodyMat = new THREE.MeshPhongMaterial({ color: 0xffffff, shininess: 70, specular: C(L.dark ? '#6a6f73' : '#9a9ea0') });
  const glassMat = new THREE.MeshPhongMaterial({ color: L.glass, shininess: 120, specular: C('#c9d2d8') });
  const lampMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  const classMeshes = new Map<VehicleKind, ClassMeshes>();
  const mkInst = (g: THREE.BufferGeometry, m: THREE.Material, n: number) => {
    const im = new THREE.InstancedMesh(g, m, n);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.frustumCulled = false;
    scene.add(im);
    return im;
  };
  for (const k of KINDS) {
    const idx = perKind.get(k)!;
    if (!idx.length) continue;
    const vg = vehicleGeometry(k);
    const fade = new THREE.InstancedBufferAttribute(new Float32Array(idx.length).fill(1), 1).setUsage(THREE.DynamicDrawUsage);
    vg.body.setAttribute('aFade', fade); vg.glass.setAttribute('aFade', fade);
    const hg = lampGeometry(true, k), tg = lampGeometry(false, k);
    hg.setAttribute('aFade', fade); tg.setAttribute('aFade', fade);
    const cm: ClassMeshes = {
      body: mkInst(vg.body, withFade(bodyMat.clone()), idx.length), glass: mkInst(vg.glass, withFade(glassMat.clone()), idx.length),
      head: mkInst(hg, withFade(lampMat.clone()), idx.length), tail: mkInst(tg, withFade(lampMat.clone()), idx.length), fade, wheelX: vg.wheelX,
    };
    for (const im of [cm.body, cm.head, cm.tail]) im.setColorAt(0, C('#000000'));
    classMeshes.set(k, cm);
  }
  const wheelFade = new THREE.InstancedBufferAttribute(new Float32Array(N * 4).fill(1), 1).setUsage(THREE.DynamicDrawUsage);
  const wheelGeo = wheelGeometry(); wheelGeo.setAttribute('aFade', wheelFade);
  const wheels = mkInst(wheelGeo, withFade(new THREE.MeshLambertMaterial({ vertexColors: true })), N * 4);
  const shadowM = mkInst(flat(new THREE.PlaneGeometry(1, 1)), new THREE.MeshBasicMaterial({
    map: radialTexture([[0, 'rgba(255,255,255,1)'], [0.55, 'rgba(255,255,255,0.5)'], [1, 'rgba(255,255,255,0)']]),
    color: L.shadow, transparent: true, opacity: L.shadowA, depthWrite: false,
  }), N);
  shadowM.renderOrder = 1;
  const beamGeo = flat(new THREE.PlaneGeometry(1, 1)).translate(0.5, 0, 0);
  const beamM = L.beam > 0 ? mkInst(beamGeo, new THREE.MeshBasicMaterial({ map: beamTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), N) : null;
  if (beamM) { beamM.renderOrder = 2; beamM.setColorAt(0, C('#000000')); }
  const bodyCol = tracks.map((tr) => C(kinds[tracks.indexOf(tr)] === 'truck' ? L.bodies[3] : L.bodies[hashId(tr.id) % L.bodies.length]));
  const cHead = C(L.head), cTail = C(L.tail), cBrake = C(L.brake), cTailOff = C(L.tailOff), cBeam = C(L.head).multiplyScalar(L.beam);
  const t0s = tracks.map((tr) => tr.pts[0]?.[0] ?? 0), t1s = tracks.map((tr) => tr.pts[tr.pts.length - 1]?.[0] ?? 0);
  const cums = tracks.map(cumulativeDistance);
  const ids = tracks.map((tr) => String(tr.id));

  /* ---------- conflict flares at their real place and time; overlap flags and ghost-pair artefacts excluded ---------- */
  const byId = new Map(tracks.map((tr) => [String(tr.id), tr]));
  const flares = o.conflicts
    .filter((c) => !c.overlap && !conflictIsGhostPair(quality, c.a, c.b, c.t))
    .map((c) => { const p = conflictPoint(c, byId.get(String(c.a)), byId.get(String(c.b)), HZ); return p ? { c, x: p.x, y: p.y, crit: c.severity === 'critical', s: (c.t0 ?? c.t - 0.3) - 0.3, e: (c.t1 ?? c.t + 0.3) + 1.8 } : null; })
    .filter((f): f is NonNullable<typeof f> => !!f)
    .sort((a, b) => a.c.t - b.c.t);
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
  const target = W(street.ext.xMid, yCm + 4);
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
  const m4 = new THREE.Matrix4(), qv = new THREE.Quaternion(), qw = new THREE.Quaternion(), qs = new THREE.Quaternion(), yAxis = new THREE.Vector3(0, 1, 0), zAxis = new THREE.Vector3(0, 0, 1);
  const sv = new THREE.Vector3(), pv = new THREE.Vector3(), wp = new THREE.Vector3();
  const fwd = new THREE.Vector3(), side = new THREE.Vector3(), tmpC = new THREE.Color();
  const HIDE = new THREE.Matrix4().makeScale(0, 0, 0);
  const lastLamp: Record<Group, Lamp | -1> = { ns: -1, ew: -1 };
  const proj = new THREE.Vector3();
  const count = (arr: number[], t: number) => { let lo = 0, hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= t) lo = mid + 1; else hi = mid; } return lo; };
  let lastHud = -1;

  const update = (t: number) => {
    let gi = STATIC_GLOWS, visible = 0;
    for (let i = 0; i < N; i++) {
      const tr = tracks[i], cm = classMeshes.get(kinds[i])!, s = slotOf[i];
      const base = gi + i * 4;
      const p = t >= t0s[i] && t <= t1s[i] ? renderPose(tr, t, HZ, [0, dur]) : null;
      const gf = p ? ghostFade(quality, ids[i], t) : 0;
      if (!p || p.fade * gf <= 0.01) {
        cm.body.setMatrixAt(s, HIDE); cm.glass.setMatrixAt(s, HIDE); cm.head.setMatrixAt(s, HIDE); cm.tail.setMatrixAt(s, HIDE); shadowM.setMatrixAt(i, HIDE); beamM?.setMatrixAt(i, HIDE);
        for (let k = 0; k < 4; k++) { wheels.setMatrixAt(i * 4 + k, HIDE); gSize[base + k] = 0; }
        continue;
      }
      const f = p.fade * gf;
      if (f > 0.5) visible++;
      qv.setFromAxisAngle(yAxis, p.h);
      pv.set(p.x, 0, -p.y);
      sv.set(tr.len_m, 1, tr.w_m);
      m4.compose(pv, qv, sv);
      cm.body.setMatrixAt(s, m4); cm.glass.setMatrixAt(s, m4); cm.head.setMatrixAt(s, m4); cm.tail.setMatrixAt(s, m4);
      cm.fade.setX(s, f);
      cm.body.setColorAt(s, bodyCol[i]);
      cm.head.setColorAt(s, tmpC.copy(cHead));
      const br = p.brake;
      cm.tail.setColorAt(s, tmpC.copy(cTailOff).lerp(cBrake, L.dark ? 0.55 + 0.45 * br : br));
      sv.set(tr.len_m * 1.25, 1, tr.w_m * 1.7); m4.compose(pv, qv, sv); shadowM.setMatrixAt(i, m4);
      fwd.set(Math.cos(p.h), 0, -Math.sin(p.h)); side.set(Math.sin(p.h), 0, Math.cos(p.h));
      // wheels: roll with the travelled distance, front pair steers with the yaw rate (bicycle model)
      const spin = distanceAt(tr, cums[i], t, HZ) / WHEEL.r;
      const ahead = renderPose(tr, Math.min(t1s[i], t + 0.2), HZ, [0, dur]), behind = renderPose(tr, Math.max(t0s[i], t - 0.2), HZ, [0, dur]);
      const rate = ahead && behind ? Math.atan2(Math.sin(ahead.h - behind.h), Math.cos(ahead.h - behind.h)) / 0.4 : 0;
      const steer = steerAngle(rate, p.v, tr.len_m * (cm.wheelX[1] - cm.wheelX[0]));
      const offs = wheelOffsets(cm.wheelX, tr.w_m);
      for (let k = 0; k < 4; k++) {
        const [ax, az] = offs[k];
        wp.copy(pv).addScaledVector(fwd, ax * tr.len_m).addScaledVector(side, az).setY(WHEEL.r);
        qs.setFromAxisAngle(yAxis, k < 2 ? steer : 0);
        qw.setFromAxisAngle(zAxis, -spin);
        qs.multiplyQuaternions(qv, qs).multiply(qw);
        m4.compose(wp, qs, sv.set(1, 1, 1));
        wheels.setMatrixAt(i * 4 + k, m4); wheelFade.setX(i * 4 + k, f);
      }
      if (beamM) {
        const moving = Math.min(1, 0.35 + p.v / 6);
        sv.set(15, 1, 7.5); m4.compose(pv.clone().addScaledVector(fwd, tr.len_m / 2 - 0.2).setY(0.02), qv, sv); beamM.setMatrixAt(i, m4);
        beamM.setColorAt(i, tmpC.copy(cBeam).multiplyScalar(f * moving));
      }
      const hy = kinds[i] === 'truck' ? 1.0 : 0.76, hw = tr.w_m / 2 - 0.3;
      const front = pv.clone().addScaledVector(fwd, tr.len_m / 2 + 0.05).setY(hy), back = pv.clone().addScaledVector(fwd, -tr.len_m / 2 - 0.05).setY(hy + 0.06);
      const hs = L.dark ? 2.3 : 1.1, ha = (L.dark ? 0.85 : 0.45) * f;
      setGlow(base, front.clone().addScaledVector(side, hw), cHead, hs, ha);
      setGlow(base + 1, front.clone().addScaledVector(side, -hw), cHead, hs, ha);
      const ts = (L.dark ? 1.0 : 0.8) + 1.5 * br, ta = ((L.dark ? 0.42 : 0.3) + 0.58 * br) * f;
      setGlow(base + 2, back.clone().addScaledVector(side, hw), cTail, ts, ta);
      setGlow(base + 3, back.clone().addScaledVector(side, -hw), cTail, ts, ta);
    }
    gi += N * 4;
    for (const cm of classMeshes.values()) {
      for (const im of [cm.body, cm.glass, cm.head, cm.tail]) { im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true; }
      cm.fade.needsUpdate = true;
    }
    wheels.instanceMatrix.needsUpdate = true; wheelFade.needsUpdate = true;
    shadowM.instanceMatrix.needsUpdate = true;
    if (beamM) { beamM.instanceMatrix.needsUpdate = true; if (beamM.instanceColor) beamM.instanceColor.needsUpdate = true; }

    // signals
    const lamps: Record<Group, Lamp> = { ns: lampAt(plan, 'ns', t), ew: lampAt(plan, 'ew', t) };
    if (lamps.ns !== lastLamp.ns || lamps.ew !== lastLamp.ew) {
      let k = 0;
      for (const hd of heads) {
        const on = lamps[hd.g];
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

function mergeGeo(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // tiny local merge (positions + normals) so street-light poles stay one geometry without a second import
  const geos = parts.map((p) => (p.index ? p.toNonIndexed() : p));
  const pos: number[] = [], nor: number[] = [];
  for (const g of geos) { pos.push(...Array.from(g.attributes.position.array as Float32Array)); nor.push(...Array.from(g.attributes.normal.array as Float32Array)); }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  parts.forEach((p) => p.dispose()); geos.forEach((g) => g.dispose());
  return out;
}
