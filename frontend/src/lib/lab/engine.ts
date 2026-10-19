/**
 * Three.js scene for the intersection lab: a simulated roadside-LiDAR view of NGSIM vehicle tracks on a road
 * model derived from the same data (lib/lab/road.ts). Draw calls stay flat as traffic grows: one for all
 * vehicle returns (instanced through a pose texture), one each for bodies, lamps, shadows and picking;
 * the static road is three meshes. Renders on demand and stops while the tab is hidden or the view is
 * scrolled off screen.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { reducedMotion } from '../motion';
import { activeAt, leadIn, type ConflictT, type IntersectionT, type TrackT } from '../traj';
import { bearingDeg, bearingLabel, bodyCentre, conflictPoint, easeInOutCubic, kinAt, MPS_TO_MPH, projectCA, renderPose, type RenderPose } from './metrics';
import { labPalette, type LabPalette } from './palette';
import { roadGeometry } from './road';
import { buildSignals, buildStreet } from './street';
import { beamTexture, createGlows, grainTexture, lidarUnitGeometry, massing, massingMesh, occludedShare, planarUv, radialTexture, streetLightGeometry, streetLightPose, streetLightSpots, type Footprint } from './context';
import { ghostFade, trackQuality, type Quality } from './quality';
import { cumulativeDistance, distanceAt, KINDS, kindOf, lampGeometry, pedestrianGeometry, steerAngle, vehicleGeometry, WHEEL, wheelGeometry, wheelOffsets, type VehicleKind } from './vehicles';
import { bodyLength, isPedestrian } from './classes';
import { inferSignals, lampAt, type Group, type Lamp } from '../../components/world/signals';

export type CamMode = 'orbit' | 'fly' | 'follow' | 'top' | 'sensor';
export type PresetId = 'overview' | 'approach' | 'zone' | 'stopline' | 'sensor';
export interface Layers { trails: boolean; projection: boolean; zones: boolean; fov: boolean; cloud: boolean }
export interface ReplayStatus { angle: number; of: number; name: string }
/** Camera state carried across an engine rebuild (theme switch) so the reader keeps their view. */
export interface EngineView { mode: CamMode; pos: [number, number, number]; target: [number, number, number]; fov: number; orthoPos: [number, number]; orthoZoom: number }

/** Assumed sensor model (simulated): 32-channel spinning LiDAR on a 4.5 m pole, −25°…+15° vertical FOV, 80 m range. */
export const SENSOR = { x: -12, y: 12, z: 4.5, vMin: -25, vMax: 15, range: 80, channels: 32 } as const;
export const BLIND_R = SENSOR.z / Math.tan((-SENSOR.vMin * Math.PI) / 180);

const PICK_LAYER = 1;
const MAX_BOXES = 12, MAX_PROJ = 4, PROJ_STEPS = 20, TRAIL_S = 3;
const FT = 3.28084;
const heightOf = (cls: string) => (cls === 'truck' || cls === 'bus' ? 3.2 : cls === 'motorcycle' || cls === 'bicycle' ? 1.3 : cls === 'pedestrian' ? 1.7 : 1.5);

/**
 * Points on the faces of a vehicle box (roof, sides, ends), local frame: x along length, y up, z across.
 * tag: 1 = tail-lamp band on the rear face (retro-reflective, high-intensity returns), 0 otherwise.
 */
/** Returns on a standing person: a 0.5 m wide body with most hits on the torso and head, none tagged as lamps. */
function pedestrianCloud(hgt: number, n: number, rnd: () => number): { p: number[]; tag: number[]; nrm: number[] } {
  const p: number[] = [], tag: number[] = [], nrm: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2, y = rnd() * hgt, r = (y > hgt * 0.88 ? 0.11 : y > hgt * 0.3 ? 0.2 : 0.14) * (0.8 + 0.2 * rnd());
    p.push(Math.cos(a) * r, y, Math.sin(a) * r); tag.push(0); nrm.push(Math.cos(a), 0, Math.sin(a));
  }
  return { p, tag, nrm };
}

function vehicleCloud(len: number, wid: number, hgt: number, n: number, rnd: () => number): { p: number[]; tag: number[]; nrm: number[] } {
  const p: number[] = [], tag: number[] = [], nrm: number[] = [];
  for (let i = 0; i < n; i++) {
    const f = rnd();
    let x: number, y: number, z: number, nx = 0, ny = 0, nz = 0;
    if (f < 0.35) { x = (rnd() - 0.5) * len; z = (rnd() - 0.5) * wid; y = hgt; ny = 1; }
    else if (f < 0.7) { const sg = Math.sign(rnd() - 0.5); x = (rnd() - 0.5) * len; z = sg * wid / 2; y = rnd() * hgt; nz = sg; }
    else { const sg = Math.sign(rnd() - 0.5); x = sg * len / 2; z = (rnd() - 0.5) * wid; y = rnd() * hgt; nx = sg; }
    if (y > hgt * 0.62) x *= 0.7; // cabin taper
    p.push(x, y, z); nrm.push(nx, ny, nz);
    tag.push(x <= -len / 2 + 0.01 && y > hgt * 0.28 && y < hgt * 0.5 && Math.abs(z) > wid * 0.22 ? 1 : 0);
  }
  return { p, tag, nrm };
}

/** Deterministic PRNG so the simulated returns look the same on every visit. */
function mulberry(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// pose texture: row 0 = (x, z, heading, state 1–7: car, truck, hot, partner, hover, selected, pedestrian), row 1 = (fade 0–1, brake 0–1, occluded share 0–1, –)
// A return exists only where the sensor can see the surface: the face must point toward the sensor, the ray must not be
// blocked by a nearer road user (occluded share, computed on the CPU), and density falls with range as a spinning
// LiDAR's angular resolution spreads over distance.
const CLOUD_VS = /* glsl */ `
uniform sampler2D uPose;
uniform float uSize;
uniform float uScale;
uniform float uOrthoPx;
uniform float uMaxPx;
uniform vec3 uCol[7];
uniform vec3 uBrake;
uniform vec3 uSensor;
uniform float uRange;
attribute float slot;
attribute float rnd;
attribute float tag;
attribute vec3 nrm;
varying vec3 vCol;
void main() {
  vec4 p = texelFetch(uPose, ivec2(int(slot), 0), 0);
  vec4 q = texelFetch(uPose, ivec2(int(slot), 1), 0);
  float c = cos(p.z), s = sin(p.z);
  vec3 wp = vec3(p.x + position.x * c + position.z * s, position.y, p.y - position.x * s + position.z * c);
  vec3 wn = vec3(nrm.x * c + nrm.z * s, nrm.y, -nrm.x * s + nrm.z * c);
  vec3 toS = uSensor - wp;
  float d = length(toS);
  float facing = dot(wn, toS / max(d, 0.001));
  // keep: visible face, not occluded, inside the range-dependent density, inside the track's fade
  float keep = q.x * (1.0 - 0.92 * q.z) * clamp(28.0 / max(d, 1.0), 0.18, 1.0);
  if (p.w < 0.5 || facing < 0.08 || rnd > keep) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vCol = vec3(0.0); return; }
  vec4 mv = modelViewMatrix * vec4(wp, 1.0);
  float k = p.w > 4.5 ? 1.3 : 1.0;
  bool persp = projectionMatrix[2][3] == -1.0;
  gl_PointSize = clamp(persp ? uSize * k * uScale / -mv.z : uSize * k * uOrthoPx, 1.2, uMaxPx * k);
  // intensity: grazing incidence and range return weaker; retro-reflective lamp bands stay bright
  float inten = mix(0.55, 1.0, facing) * mix(1.0, 0.6, clamp(d / uRange, 0.0, 1.0));
  vCol = mix(uCol[int(p.w + 0.5) - 1] * inten, uBrake, tag * q.y);
  if (tag * q.y > 0.05) gl_PointSize *= 1.35;
  gl_Position = projectionMatrix * mv;
}`;
const CLOUD_FS = /* glsl */ `
varying vec3 vCol;
void main() {
  if (length(gl_PointCoord - 0.5) > 0.5) discard;
  gl_FragColor = vec4(vCol, 1.0);
}`;

/** Per-instance screen-door fade for an instanced Lambert/Basic material (opaque pipeline, no sorting). */
function withFade(mat: THREE.Material) {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aFade;\nvarying float vFade;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFade = aFade;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vFade;')
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (vFade < 0.999 && fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) > vFade) discard;');
  };
  return mat;
}

export interface EngineOpts {
  host: HTMLElement;
  minimap: HTMLCanvasElement | null;
  compass: HTMLElement | null;
  heading: HTMLElement | null;
  data: IntersectionT;
  conflicts: ConflictT[];
  layers: Layers;
  mode: CamMode;
  palette?: LabPalette;
  view?: EngineView | null;
  /** Ghost windows (lib/lab/quality.ts); computed here when absent. */
  quality?: Quality | null;
  clock: { now: () => number; setT: (t: number) => void; play: () => void; pause: () => void };
  onPick: (id: string | null, add: boolean) => void;
  onHover: (id: string | null) => void;
  onMode: (m: CamMode) => void;
  onReplay: (s: ReplayStatus | null) => void;
  /** Frames per second over the last second while frames are being drawn (performance readout). */
  onFps?: (fps: number | null) => void;
}

export interface Engine {
  update: (t: number) => void;
  setSel: (sel: Set<string>, hov: string | null, focus: ConflictT | null) => void;
  setMode: (m: CamMode) => void;
  preset: (p: PresetId) => void;
  setLayers: (l: Layers) => void;
  replay: () => void;
  cancelReplay: () => void;
  getView: () => EngineView;
  render: () => void;
  dispose: () => void;
}

export function createEngine(o: EngineOpts): Engine {
  const { host: el, data, conflicts } = o;
  const pal = o.palette ?? labPalette();
  const C = (h: string) => new THREE.Color(h);

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  const cvs = renderer.domElement;
  cvs.className = 'lidar-gl';
  el.prepend(cvs);
  const labels = new CSS2DRenderer();
  labels.domElement.className = 'lidar-labels';
  el.insertBefore(labels.domElement, cvs.nextSibling);

  const bg = C(pal.horizon);
  const scene = new THREE.Scene();
  scene.background = bg;
  const FOG: [number, number] = pal.dark ? [120, 420] : [150, 480];
  scene.fog = new THREE.Fog(bg, FOG[0], FOG[1]);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = pal.exposure;
  // daylight (light theme) casts real shadows from one sun; night (dark theme) is lit by a moon, street lamps and headlights
  const daylight = !pal.dark;
  renderer.shadowMap.enabled = daylight;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  scene.add(new THREE.HemisphereLight(pal.sky, pal.lot, pal.dark ? 1.1 : 1.35));
  const sun = new THREE.DirectionalLight(pal.dark ? '#c3cfdc' : '#fff4e0', pal.dark ? 0.9 : 2.2);
  sun.position.set(-55, 95, 45); scene.add(sun);
  if (pal.dark) { const key = new THREE.DirectionalLight(pal.lamp, 0.35); key.position.set(50, 30, -20); scene.add(key); }

  // World mapping: data (x across, y along corridor) → three (X = x, Z = −y), Y up.
  const W = (x: number, y: number, h = 0) => new THREE.Vector3(x, h, -y);
  const [[bx0, by0], [bx1, by1]] = data.bbox as [[number, number], [number, number]];
  const mid = W((bx0 + bx1) / 2, (by0 + by1) / 2);
  const sensorWorld = new THREE.Vector3(SENSOR.x, SENSOR.z + 0.25, -SENSOR.y);
  const byId = new Map(data.tracks.map((t) => [String(t.id), t]));
  const ids = data.tracks.map((t) => String(t.id));
  const N = data.tracks.length;
  const win: [number, number] = [0, data.window_s];
  if (daylight) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera as THREE.OrthographicCamera;
    const R = Math.max(bx1 - bx0, by1 - by0) / 2 + 45;
    sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R; sc.near = 10; sc.far = 320;
    sun.shadow.bias = -0.0008; sun.shadow.normalBias = 0.04;
    sun.target.position.copy(mid); scene.add(sun.target);
  }
  const flat = (geo: THREE.BufferGeometry) => { geo.rotateX(-Math.PI / 2); return geo; };

  /* ----- ground: lot beyond the kerbs, with the 50 ft survey grid kept as an instrument overlay (FOV layer) ----- */
  const ground = new THREE.Mesh(flat(new THREE.PlaneGeometry(1600, 1600)), new THREE.MeshLambertMaterial({ color: '#ffffff', map: grainTexture(pal.lot, 14, 14) }));
  ground.position.set(mid.x, -0.02, mid.z); ground.receiveShadow = daylight; scene.add(ground);
  const grid = new THREE.Group();
  {
    const g = 50 / FT, R = 260, minor: number[] = [], major: number[] = [];
    const k0 = Math.floor((mid.x - R) / g), k1 = Math.ceil((mid.x + R) / g), j0 = Math.floor((-mid.z - R) / g), j1 = Math.ceil((-mid.z + R) / g);
    for (let k = k0; k <= k1; k++) (k % 5 ? minor : major).push(k * g, 0.02, -(-mid.z - R), k * g, 0.02, -(-mid.z + R));
    for (let j = j0; j <= j1; j++) (j % 5 ? minor : major).push(mid.x - R, 0.02, -j * g, mid.x + R, 0.02, -j * g);
    for (const [arr, col] of [[minor, pal.grid], [major, pal.gridMajor]] as [number[], string][]) {
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      grid.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.6 })));
    }
  }
  scene.add(grid);

  /* ----- street derived from the data: carriageway, cross street from the EB/WB tracks, MUTCD markings, stop bars, kerbs ----- */
  const road = roadGeometry(data);
  const FAR = { s: by0 - 300, n: by1 + 300, w: bx0 - 300, e: bx1 + 300 };
  const street = buildStreet(road, data.bbox as [[number, number], [number, number]], {
    far: FAR, crosswalks: !data.crosswalks?.length, crosswalkPolygons: data.crosswalks?.map((c) => c.polygon as [number, number][]), lineScale: 1.5, markH: 0.014, kerbHeight: 0.15,
    colours: { lane: pal.lane, edge: pal.edge, centre: pal.centre, stop: pal.stop, crosswalk: pal.lane },
  });
  if (street.asphalt) {
    const m = new THREE.Mesh(planarUv(street.asphalt), new THREE.MeshLambertMaterial({ color: '#ffffff', map: grainTexture(pal.asphalt, 9) }));
    m.receiveShadow = daylight; scene.add(m);
  }
  { const m = new THREE.Mesh(street.markings, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })); m.receiveShadow = daylight; scene.add(m); }
  if (street.sidewalks) { const m = new THREE.Mesh(street.sidewalks, new THREE.MeshLambertMaterial({ color: '#ffffff', map: grainTexture(pal.walk, 6, 18) })); planarUv(street.sidewalks); m.receiveShadow = daylight; m.castShadow = daylight; scene.add(m); }

  /* ----- stylised context: low-rise massing and street lights (declared in the Info; not surveyed) ----- */
  const massingMeshObj = massingMesh(massing(street.ext, FAR, 1016), { building: pal.building, roof: pal.roof, window: pal.window, windowAmt: pal.windowAmt });
  massingMeshObj.castShadow = daylight; massingMeshObj.receiveShadow = daylight; scene.add(massingMeshObj);
  const lampSpots = streetLightSpots(street.ext, road.crossBand, FAR);
  const lampPoses = lampSpots.map(streetLightPose);
  {
    const poles = new THREE.InstancedMesh(streetLightGeometry(), new THREE.MeshLambertMaterial({ color: pal.pole }), lampSpots.length);
    const m = new THREE.Matrix4(), qq = new THREE.Quaternion(), upv = new THREE.Vector3(0, 1, 0);
    lampPoses.forEach((lp, i) => { qq.setFromAxisAngle(upv, lp.yaw); m.compose(lp.base, qq, new THREE.Vector3(1, 1, 1)); poles.setMatrixAt(i, m); });
    poles.castShadow = daylight; scene.add(poles);
    if (pal.dark) {
      const pools = new THREE.InstancedMesh(flat(new THREE.PlaneGeometry(1, 1)), new THREE.MeshBasicMaterial({
        map: radialTexture([[0, 'rgba(255,255,255,1)'], [0.4, 'rgba(255,255,255,0.45)'], [1, 'rgba(255,255,255,0)']]),
        color: C(pal.lamp).multiplyScalar(0.2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      }), lampSpots.length);
      lampPoses.forEach((lp, i) => { m.compose(new THREE.Vector3(lp.head.x, 0.03, lp.head.z), new THREE.Quaternion(), new THREE.Vector3(20, 1, 20)); pools.setMatrixAt(i, m); });
      pools.renderOrder = 2; scene.add(pools);
    }
  }

  /* ----- signal heads on mast arms; phase inferred from flow (components/world/signals.ts) ----- */
  const nbBar = road.stops.find((s) => s.dir === 'NB'), sbBar = road.stops.find((s) => s.dir === 'SB');
  const plan = inferSignals(data.tracks, { nbBar: nbBar?.a[1] ?? null, sbBar: sbBar?.a[1] ?? null, xMid: street.ext.xMid }, data.window_s, data.hz);
  const sig = buildSignals(road, street);
  if (sig.structure) { const m = new THREE.Mesh(sig.structure, new THREE.MeshLambertMaterial({ color: pal.housing })); m.castShadow = daylight; scene.add(m); }
  const sigLamps = new THREE.InstancedMesh(new THREE.CircleGeometry(0.13, 16), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), Math.max(1, sig.lampCount));
  {
    const m = new THREE.Matrix4(), qq = new THREE.Quaternion();
    let k = 0;
    sig.heads.forEach((h) => { qq.setFromAxisAngle(new THREE.Vector3(0, 1, 0), h.rotY); for (const p of h.lamps) { m.compose(p, qq, new THREE.Vector3(1, 1, 1)); sigLamps.setMatrixAt(k++, m); } });
    sigLamps.count = k;
    scene.add(sigLamps);
  }
  const SIG = [C(pal.dark ? '#ff3a26' : '#e5261a'), C(pal.dark ? '#ffb21e' : '#e89a00'), C(pal.dark ? '#2ee6a0' : '#0fa36a')], SIG_OFF = C(pal.dark ? '#1b1d1c' : '#5a5c59');
  const lastLamp: Record<Group, Lamp | -1> = { ns: -1, ew: -1 };

  /* ----- glows: street lamps (static), signal lamps, vehicle lamps ----- */
  const GLOW_LAMPS = lampSpots.length, GLOW_SIG = sig.heads.length, GLOW_VEH = N * 4;
  const glows = createGlows(GLOW_LAMPS + GLOW_SIG + GLOW_VEH, FOG, pal.dark);
  scene.add(glows.points);
  { const lc = C(pal.lamp); lampPoses.forEach((lp, i) => glows.set(i, lp.head, lc, pal.dark ? 2.6 : 1.2, pal.dark ? 1 : 0.35)); }
  const quality = o.quality ?? trackQuality(data.tracks, data.hz);

  /* ----- simulated ground returns: rings of the sensor's down-looking channels (cloud layer) ----- */
  const g: number[] = [], gc: number[] = [];
  const ink = C(pal.ink3), tmp = new THREE.Color();
  for (let ch = 0; ch < SENSOR.channels; ch++) {
    const elev = SENSOR.vMin + (ch * (SENSOR.vMax - SENSOR.vMin)) / (SENSOR.channels - 1);
    if (elev >= -0.5) continue;
    const r = SENSOR.z / Math.tan((-elev * Math.PI) / 180);
    if (r > SENSOR.range) continue;
    const n = Math.round(r * 9);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      g.push(SENSOR.x + Math.cos(a) * r, 0.02, -(SENSOR.y + Math.sin(a) * r));
      tmp.copy(bg).lerp(ink, (pal.dark ? 0.12 : 0.18) + 0.35 * Math.exp(-r / 30));
      gc.push(tmp.r, tmp.g, tmp.b);
    }
  }
  const groundGeo = new THREE.BufferGeometry();
  groundGeo.setAttribute('position', new THREE.Float32BufferAttribute(g, 3));
  groundGeo.setAttribute('color', new THREE.Float32BufferAttribute(gc, 3));
  const groundMat = new THREE.PointsMaterial({ size: 0.1, vertexColors: true, sizeAttenuation: true });
  const groundPts = new THREE.Points(groundGeo, groundMat);
  scene.add(groundPts);

  /* ----- sensor pole, head and FOV ----- */
  {
    const unit = lidarUnitGeometry(SENSOR.z);
    const pole = new THREE.Mesh(unit.structure, new THREE.MeshLambertMaterial({ color: pal.pole }));
    const puck = new THREE.Mesh(unit.puck, new THREE.MeshPhongMaterial({ color: pal.dark ? '#2a2d2b' : '#3a3d3b', shininess: 80, specular: C('#9aa0a3') }));
    for (const m of [pole, puck]) { m.position.set(SENSOR.x, 0, -SENSOR.y); m.castShadow = daylight; scene.add(m); }
  }
  const fov = new THREE.Group();
  const cone = new THREE.Mesh(new THREE.ConeGeometry(SENSOR.range, SENSOR.z, 96, 1, true),
    new THREE.MeshBasicMaterial({ color: pal.accent, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false }));
  cone.position.set(SENSOR.x, SENSOR.z / 2, -SENSOR.y);
  fov.add(cone);
  const fovLine = new THREE.LineBasicMaterial({ color: pal.accent, transparent: true, opacity: 0.55 });
  const spokes: THREE.Vector3[] = [];
  for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; spokes.push(sensorWorld.clone(), new THREE.Vector3(SENSOR.x + Math.cos(a) * SENSOR.range, 0.03, -SENSOR.y - Math.sin(a) * SENSOR.range)); }
  fov.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(spokes), new THREE.LineBasicMaterial({ color: pal.accent, transparent: true, opacity: 0.3 })));
  const ring = (r: number) => { const pts: THREE.Vector3[] = []; for (let i = 0; i <= 128; i++) { const a = (i / 128) * Math.PI * 2; pts.push(new THREE.Vector3(SENSOR.x + Math.cos(a) * r, 0.03, -SENSOR.y - Math.sin(a) * r)); } return new THREE.BufferGeometry().setFromPoints(pts); };
  fov.add(new THREE.Line(ring(SENSOR.range), fovLine));
  const blind = new THREE.Line(ring(BLIND_R), new THREE.LineDashedMaterial({ color: pal.caution, dashSize: 0.6, gapSize: 0.5 }));
  blind.computeLineDistances(); fov.add(blind);
  scene.add(fov);

  /* ----- vehicle returns: one Points, posed per slot from a float texture ----- */
  const poseArr = new Float32Array(N * 4 * 2);
  const poseTex = new THREE.DataTexture(poseArr, N, 2, THREE.RGBAFormat, THREE.FloatType);
  poseTex.needsUpdate = true;
  const rand = mulberry(20251017);
  const cp: number[] = [], cs: number[] = [], cr: number[] = [], ct: number[] = [], cn: number[] = [];
  data.tracks.forEach((tr, i) => {
    const { p, tag, nrm } = isPedestrian(tr) ? pedestrianCloud(heightOf(tr.cls), 160, rand) : vehicleCloud(tr.len_m, tr.w_m, heightOf(tr.cls), tr.cls === 'truck' || tr.cls === 'bus' ? 2200 : 900, rand);
    cp.push(...p); ct.push(...tag); cn.push(...nrm);
    for (let k = 0; k < p.length / 3; k++) { cs.push(i); cr.push(rand() * 0.999); }
  });
  const cloudGeo = new THREE.BufferGeometry();
  cloudGeo.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
  cloudGeo.setAttribute('nrm', new THREE.Float32BufferAttribute(cn, 3));
  cloudGeo.setAttribute('slot', new THREE.Float32BufferAttribute(cs, 1));
  cloudGeo.setAttribute('rnd', new THREE.Float32BufferAttribute(cr, 1));
  cloudGeo.setAttribute('tag', new THREE.Float32BufferAttribute(ct, 1));
  const cols = [pal.car, pal.truck, pal.hot, pal.partner, pal.hov, pal.sel, pal.ped].map(C);
  const cloudMat = new THREE.ShaderMaterial({
    vertexShader: CLOUD_VS, fragmentShader: CLOUD_FS, fog: false,
    uniforms: { uPose: { value: poseTex }, uSize: { value: 0.24 }, uScale: { value: 300 }, uOrthoPx: { value: 4 }, uMaxPx: { value: 3.4 * Math.min(2, devicePixelRatio) }, uCol: { value: cols }, uBrake: { value: C(pal.brake) }, uSensor: { value: sensorWorld }, uRange: { value: SENSOR.range } },
  });
  const cloud = new THREE.Points(cloudGeo, cloudMat);
  cloud.frustumCulled = false;
  scene.add(cloud);

  /* ----- vehicle bodies (cloud off): class-shaped bodies, glass, lamps and rolling wheels (lib/lab/vehicles.ts) ----- */
  const unitBox = (sx: number, sy: number, sz: number, x: number, y: number, z = 0) => new THREE.BoxGeometry(sx, sy, sz).translate(x, y, z);
  const kinds = data.tracks.map(kindOf);
  const slotOf = new Int32Array(N);
  const perKind = new Map<VehicleKind, number[]>();
  KINDS.forEach((k) => perKind.set(k, []));
  data.tracks.forEach((_, i) => { const arr = perKind.get(kinds[i])!; slotOf[i] = arr.length; arr.push(i); });
  interface ClassMeshes { body: THREE.InstancedMesh; glass: THREE.InstancedMesh; head: THREE.InstancedMesh; tail: THREE.InstancedMesh; fade: THREE.InstancedBufferAttribute; wheelX: [number, number] }
  const classMeshes = new Map<VehicleKind, ClassMeshes>();
  const vehicleParts: THREE.InstancedMesh[] = [];
  const mkInst = (g: THREE.BufferGeometry, m: THREE.Material, n: number) => { const im = new THREE.InstancedMesh(g, m, n); im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); im.frustumCulled = false; scene.add(im); vehicleParts.push(im); return im; };
  for (const k of KINDS) {
    const idx = perKind.get(k)!;
    if (!idx.length) continue;
    const vg = k === 'ped' ? { body: pedestrianGeometry(), glass: new THREE.BufferGeometry(), wheelX: [0, 0] as [number, number] } : vehicleGeometry(k);
    const fade = new THREE.InstancedBufferAttribute(new Float32Array(idx.length).fill(1), 1).setUsage(THREE.DynamicDrawUsage);
    const hg = k === 'ped' ? new THREE.BufferGeometry() : lampGeometry(true, k), tg = k === 'ped' ? new THREE.BufferGeometry() : lampGeometry(false, k);
    for (const g of [vg.body, vg.glass, hg, tg]) g.setAttribute('aFade', fade);
    const cm: ClassMeshes = {
      body: mkInst(vg.body, withFade(new THREE.MeshPhongMaterial({ color: 0xffffff, shininess: 60, specular: C(pal.dark ? '#5a5f63' : '#9a9ea0') })), idx.length),
      glass: mkInst(vg.glass, withFade(new THREE.MeshPhongMaterial({ color: pal.dark ? '#141a1e' : '#2a3238', shininess: 110, specular: C('#c9d2d8') })), idx.length),
      head: mkInst(hg, withFade(new THREE.MeshBasicMaterial({ color: pal.head })), idx.length),
      tail: mkInst(tg, withFade(new THREE.MeshBasicMaterial({ color: 0xffffff })), idx.length),
      fade, wheelX: vg.wheelX,
    };
    cm.body.setColorAt(0, cols[0]); cm.tail.setColorAt(0, C(pal.lampOff));
    cm.body.castShadow = daylight; cm.glass.castShadow = daylight;
    classMeshes.set(k, cm);
  }
  // pedestrians: two legs per person swing with the travelled distance (stride 1.3 m)
  const pedIdx = data.tracks.map((tr, i) => (isPedestrian(tr) ? i : -1)).filter((i) => i >= 0);
  const legSlot = new Int32Array(N).fill(-1); pedIdx.forEach((i, k) => { legSlot[i] = k; });
  const legFade = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, pedIdx.length * 2)).fill(1), 1).setUsage(THREE.DynamicDrawUsage);
  const legGeo = new THREE.CapsuleGeometry(0.075, 0.62, 2, 8).translate(0, -0.31, 0); legGeo.setAttribute('aFade', legFade);
  const legs = mkInst(legGeo, withFade(new THREE.MeshLambertMaterial({ color: pal.dark ? '#5f6a70' : '#3b4a52' })), Math.max(1, pedIdx.length * 2));
  legs.castShadow = daylight; if (!pedIdx.length) legs.count = 0;
  // turn indicators: inferred from the recorded turning movement (left/right), blinking at 1.5 Hz until the turn is done
  const indGeo = (side: 1 | -1) => mergeGeometries([new THREE.BoxGeometry(0.03, 0.08, 0.14).translate(0.5, 0.7, side * 0.44), new THREE.BoxGeometry(0.03, 0.08, 0.14).translate(-0.5, 0.78, side * 0.44)].map((g) => g.toNonIndexed()))!;
  const indFade = new THREE.InstancedBufferAttribute(new Float32Array(N).fill(1), 1).setUsage(THREE.DynamicDrawUsage);
  const indL = indGeo(-1), indR = indGeo(1); indL.setAttribute('aFade', indFade); indR.setAttribute('aFade', indFade);
  const indicators = { L: mkInst(indL, withFade(new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })), N), R: mkInst(indR, withFade(new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })), N) };
  const cAmber = C('#ffb21e'), cIndOff = C(pal.dark ? '#3a2a12' : '#8a7a5a');
  const turnEnd = data.tracks.map((tr) => {
    if (tr.move !== 'left' && tr.move !== 'right' || tr.pts.length < 4) return -1;
    const k0 = kinAt(tr, tr.pts[0][0], data.hz); if (!k0) return -1;
    for (const pt of tr.pts) { const kk = kinAt(tr, pt[0], data.hz); if (kk && Math.abs(Math.atan2(Math.sin(kk.h - k0.h), Math.cos(kk.h - k0.h))) > 0.9) return pt[0] + 0.8; }
    return tr.pts[tr.pts.length - 1][0];
  });
  // headlight throw on the road at night
  const beams = pal.dark ? mkInst(flat(new THREE.PlaneGeometry(1, 1)).translate(0.5, 0, 0), new THREE.MeshBasicMaterial({ map: beamTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), N) : null;
  if (beams) { beams.renderOrder = 2; beams.setColorAt(0, C('#000000')); }
  const cBeam = C(pal.head).multiplyScalar(0.3), cHeadGlow = C(pal.head), cTailGlow = C(pal.tail);
  const wheelFade = new THREE.InstancedBufferAttribute(new Float32Array(N * 4).fill(1), 1).setUsage(THREE.DynamicDrawUsage);
  const wheelGeo = wheelGeometry(); wheelGeo.setAttribute('aFade', wheelFade);
  const wheels = mkInst(wheelGeo, withFade(new THREE.MeshLambertMaterial({ vertexColors: true })), N * 4);
  const cums = data.tracks.map(cumulativeDistance);
  const wq = new THREE.Quaternion(), wq2 = new THREE.Quaternion(), wp = new THREE.Vector3(), fwdV = new THREE.Vector3(), sideV = new THREE.Vector3(), zAxis = new THREE.Vector3(0, 0, 1);
  const fadeAttr = { setX: (_i: number, _v: number) => {}, needsUpdate: false }; // kept for the per-class attributes below
  void unitBox;
  const shadowTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d')!, gr = x.createRadialGradient(32, 32, 4, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.55, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();
  const shadows = new THREE.InstancedMesh(flat(new THREE.PlaneGeometry(1, 1)), new THREE.MeshBasicMaterial({ map: shadowTex, color: pal.shadow, transparent: true, opacity: pal.dark ? 0.6 : 0.28, depthWrite: false }), N);
  shadows.instanceMatrix.setUsage(THREE.DynamicDrawUsage); shadows.frustumCulled = false; shadows.renderOrder = 1; scene.add(shadows); vehicleParts.push(shadows);
  const pick = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshBasicMaterial(), N);
  pick.layers.set(PICK_LAYER);
  pick.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(pick);
  const ray = new THREE.Raycaster();
  ray.layers.set(PICK_LAYER);

  /* ----- outlines, trails, projections, conflict zones, focus beacon ----- */
  const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
  const outlineMat = { sel: new THREE.LineBasicMaterial({ color: pal.sel }), partner: new THREE.LineBasicMaterial({ color: pal.partner }) };
  const boxes = Array.from({ length: MAX_BOXES }, () => { const b = new THREE.LineSegments(edges, outlineMat.sel); b.visible = false; scene.add(b); return b; });

  const MAX_TRAIL = N * (TRAIL_S * 10 + 1);
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_TRAIL * 6), 3).setUsage(THREE.DynamicDrawUsage));
  trailGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_TRAIL * 6), 3).setUsage(THREE.DynamicDrawUsage));
  const trails = new THREE.LineSegments(trailGeo, new THREE.LineBasicMaterial({ vertexColors: true }));
  trails.frustumCulled = false; scene.add(trails);
  const trailFaint = C(pal.asphalt).lerp(C(pal.trail), pal.dark ? 0.32 : 0.4), trailSel = C(pal.sel), trailPartner = C(pal.partner);

  const projGeo = new THREE.BufferGeometry();
  projGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_PROJ * PROJ_STEPS * 6), 3).setUsage(THREE.DynamicDrawUsage));
  const proj = new THREE.LineSegments(projGeo, new THREE.LineDashedMaterial({ color: pal.sel, dashSize: 0.7, gapSize: 0.5 }));
  proj.frustumCulled = false; scene.add(proj);

  const sevCol = (s: string) => C(s === 'critical' ? pal.critical : pal.caution);
  const cpts = conflicts.map((c) => conflictPoint(c, byId.get(String(c.a)), byId.get(String(c.b)), data.hz));
  // crosswalk polygons from a site feed (site.json), drawn as flat marked slabs on the asphalt
  if (data.crosswalks?.length) {
    const cwMat = new THREE.MeshBasicMaterial({ color: C(pal.stop), transparent: true, opacity: pal.dark ? 0.16 : 0.22, depthWrite: false });
    for (const cw of data.crosswalks) {
      const sh = new THREE.Shape(cw.polygon.map(([x, y]) => new THREE.Vector2(x, -y)));
      const g = new THREE.ShapeGeometry(sh); g.rotateX(-Math.PI / 2); g.translate(0, 0.012, 0);
      const m = new THREE.Mesh(g, cwMat); m.renderOrder = 1; scene.add(m);
    }
  }
  const zoneGeo = new THREE.RingGeometry(0.55, 0.85, 28); zoneGeo.rotateX(-Math.PI / 2);
  const zones = new THREE.InstancedMesh(zoneGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }), Math.max(1, conflicts.length));
  zones.renderOrder = 2;
  {
    const m = new THREE.Matrix4();
    conflicts.forEach((c, i) => {
      const p = cpts[i];
      m.makeTranslation(p ? p.x : 0, 0.05 + i * 0.0004, p ? -p.y : 0);
      if (!p) m.scale(new THREE.Vector3(0, 0, 0));
      zones.setMatrixAt(i, m);
      zones.setColorAt(i, C(pal.asphalt).lerp(sevCol(c.severity), 0.5));
    });
    if (!conflicts.length) zones.count = 0;
  }
  scene.add(zones);

  const beacon = new THREE.Group();
  const beaconRing = new THREE.Mesh(new THREE.RingGeometry(1.5, 1.85, 48), new THREE.MeshBasicMaterial({ color: pal.critical, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
  beaconRing.rotation.x = -Math.PI / 2; beaconRing.position.y = 0.08;
  const beaconPole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 7, 6), new THREE.MeshBasicMaterial({ color: pal.critical, transparent: true }));
  beaconPole.position.y = 3.5;
  beacon.add(beaconRing, beaconPole); beacon.visible = false; scene.add(beacon);

  /* ----- labels ----- */
  const tags = new Map<string, CSS2DObject>();
  const tagFor = (id: string, cls = 'lidar-tag') => {
    let t = tags.get(id);
    if (!t) { const d = document.createElement('div'); d.className = cls; t = new CSS2DObject(d); scene.add(t); tags.set(id, t); }
    return t;
  };
  const projTag = tagFor('__proj', 'lidar-tag lidar-tag-proj'); projTag.element.textContent = '2 s projection'; projTag.visible = false;
  const focusTag = tagFor('__focus', 'lidar-tag lidar-tag-focus'); focusTag.visible = false;

  /* ----- cameras ----- */
  const persp = new THREE.PerspectiveCamera(42, 1, 0.3, 700);
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 600);
  ortho.up.set(0, 0, -1); ortho.position.set(mid.x, 200, mid.z); ortho.lookAt(mid);
  let cam: THREE.Camera = persp;
  const controls = new OrbitControls(persp, cvs);
  controls.enableDamping = true; controls.dampingFactor = 0.09; controls.maxPolarAngle = Math.PI * 0.47; controls.minDistance = 6; controls.maxDistance = 240;
  controls.cursorStyle = 'grab';

  let W0 = 1, H0 = 1, orthoZoom = 1.5;
  const fitOrtho = () => {
    const aspect = W0 / H0, halfH = Math.max((by1 - by0) / 2 + 6, ((bx1 - bx0) / 2 + 6) / aspect);
    ortho.left = -halfH * aspect; ortho.right = halfH * aspect; ortho.top = halfH; ortho.bottom = -halfH;
    ortho.zoom = orthoZoom; ortho.updateProjectionMatrix();
  };
  let dirty = true;

  const conflictCentroid = () => {
    let sx = 0, sy = 0, n = 0;
    cpts.forEach((p, i) => { if (!p) return; const w = conflicts[i].severity === 'critical' ? 2 : 1; sx += p.x * w; sy += p.y * w; n += w; });
    return n ? { x: sx / n, y: sy / n } : { x: (bx0 + bx1) / 2, y: 0 };
  };
  /**
   * Home composition: the conflict zone at the centre, the corridor crossing the frame on a diagonal on wide
   * screens and running away from the viewer on tall ones, about 300 ft of corridor in view.
   */
  const homePose = (): [THREE.Vector3, THREE.Vector3] => {
    const c = conflictCentroid();
    const t = W(Math.max(bx0, Math.min(bx1, c.x)), Math.max(by0 + 20, Math.min(by1 - 20, c.y)), 0);
    const aspect = W0 / H0;
    const az = (aspect > 1.25 ? 52 : aspect > 0.85 ? 34 : 14) * (Math.PI / 180);
    const el = (aspect > 0.85 ? 33 : 42) * (Math.PI / 180);
    const R = Math.min(120, Math.max(58, 92 / Math.min(1.6, Math.max(0.6, aspect))));
    // camera south-east of the target: +X across, +Z is south
    const p = new THREE.Vector3(t.x + Math.sin(az) * Math.cos(el) * R, Math.sin(el) * R, t.z + Math.cos(az) * Math.cos(el) * R);
    return [p, t];
  };

  const resize = () => {
    W0 = Math.max(1, el.clientWidth); H0 = Math.max(1, el.clientHeight);
    renderer.setSize(W0, H0, false); labels.setSize(W0, H0);
    persp.aspect = W0 / H0; persp.updateProjectionMatrix(); fitOrtho();
    cloudMat.uniforms.uScale.value = (H0 * renderer.getPixelRatio()) / 2;
    glows.fit(H0, persp.fov, renderer.getPixelRatio());
    dirty = true;
  };
  const ro = new ResizeObserver(resize); ro.observe(el);

  /* ----- state ----- */
  let layers = o.layers;
  let mode: CamMode = 'orbit';
  let selIds = new Set<string>(), hovId: string | null = null, partnerIds = new Set<string>(), focus: ConflictT | null = null, focusPt: { x: number; y: number } | null = null;
  let tNow = o.clock.now();
  const posOf = new Map<string, THREE.Vector3>();
  const kinOf = new Map<string, RenderPose>();
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), v3 = new THREE.Vector3();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const lampOff = C(pal.lampOff), lampOn = C(pal.brake), lampC = new THREE.Color();
  let lastActive = '';

  const applyLayers = () => {
    groundPts.visible = layers.cloud;
    cloud.visible = layers.cloud; for (const im of vehicleParts) im.visible = !layers.cloud;
    shadows.visible = !layers.cloud && !daylight; // blob shadows only where there is no shadow map
    trails.visible = layers.trails; proj.visible = layers.projection;
    zones.visible = layers.zones; fov.visible = layers.fov; grid.visible = layers.fov;
    if (beams) beams.visible = !layers.cloud;
    legs.visible = indicators.L.visible = indicators.R.visible = !layers.cloud;
    dirty = true;
  };

  const fpNow: (Footprint & { i: number; d: number })[] = [];
  const occl = new Float32Array(N);
  /** Line of sight from the sensor: nearer road users hide farther ones (share of three rays blocked). */
  const occlusionPass = () => {
    fpNow.sort((a, b) => a.d - b.d);
    occl.fill(0);
    for (let j = 0; j < fpNow.length; j++) {
      const f = fpNow[j];
      occl[f.i] = occludedShare(SENSOR.x, SENSOR.y, f, fpNow.slice(0, j).filter((g) => g.d < f.d - 0.5));
    }
  };
  const update = (t: number) => {
    tNow = t;
    const act = activeAt(conflicts, t);
    const hot = new Set(act.flatMap((k) => [String(k.a), String(k.b)]));
    posOf.clear(); kinOf.clear();
    let nb = 0;
    // occlusion of the simulated returns: footprints of everything in range at t (data frame, body centres)
    fpNow.length = 0;
    for (let i = 0; i < N; i++) {
      const tr = data.tracks[i];
      const k = renderPose(tr, t, data.hz, win);
      if (!k) continue;
      const [cx, cy] = bodyCentre(k.x, k.y, k.h, bodyLength(tr));
      const d = Math.hypot(cx - SENSOR.x, cy - SENSOR.y);
      if (d < SENSOR.range) fpNow.push({ i, d, x: cx, y: cy, h: k.h, len: bodyLength(tr), w: tr.w_m });
    }
    occlusionPass();
    const blinkOn = (t % 0.667) < 0.333;
    for (let i = 0; i < N; i++) {
      const tr = data.tracks[i], id = ids[i];
      const k = renderPose(tr, t, data.hz, win);
      // served point = NGSIM front-bumper centre; the body (and its returns) sit behind it
      const pos = k && (([cx, cy]) => W(cx, cy))(bodyCentre(k.x, k.y, k.h, bodyLength(tr)));
      const inRange = !!pos && Math.hypot(pos.x - sensorWorld.x, pos.z - sensorWorld.z) < SENSOR.range;
      const gf = k ? ghostFade(quality, id, t) : 0;
      const cm = classMeshes.get(kinds[i])!, slot = slotOf[i];
      if (!k || !pos || !inRange || k.fade * gf <= 0) {
        poseArr[i * 4 + 3] = 0;
        for (const m of [pick, shadows]) m.setMatrixAt(i, zero);
        for (const m of [cm.body, cm.glass, cm.head, cm.tail]) m.setMatrixAt(slot, zero);
        for (let w = 0; w < 4; w++) wheels.setMatrixAt(i * 4 + w, zero);
        indicators.L.setMatrixAt(i, zero); indicators.R.setMatrixAt(i, zero); beams?.setMatrixAt(i, zero);
        if (legSlot[i] >= 0) { legs.setMatrixAt(legSlot[i] * 2, zero); legs.setMatrixAt(legSlot[i] * 2 + 1, zero); }
        const tg = tags.get(id); if (tg) tg.visible = false;
        continue;
      }
      k.fade *= gf;
      posOf.set(id, pos); kinOf.set(id, k);
      const isSel = selIds.has(id), isPartner = partnerIds.has(id), isHov = id === hovId;
      const ped = kinds[i] === 'ped';
      const state = isSel ? 6 : isHov ? 5 : isPartner ? 4 : hot.has(id) ? 3 : ped ? 7 : tr.cls === 'truck' || tr.cls === 'bus' ? 2 : 1;
      poseArr[i * 4] = pos.x; poseArr[i * 4 + 1] = pos.z; poseArr[i * 4 + 2] = k.h; poseArr[i * 4 + 3] = state;
      poseArr[N * 4 + i * 4] = k.fade; poseArr[N * 4 + i * 4 + 1] = k.brake; poseArr[N * 4 + i * 4 + 2] = occl[i];
      const h = heightOf(tr.cls);
      q.setFromAxisAngle(up, k.h);
      m4.compose(sc.set(pos.x, 0, pos.z), q, ped ? v3.set(1, 1, 1) : v3.set(tr.len_m, 1, tr.w_m));
      cm.body.setMatrixAt(slot, m4); cm.glass.setMatrixAt(slot, m4); cm.tail.setMatrixAt(slot, m4); cm.head.setMatrixAt(slot, m4);
      cm.fade.setX(slot, k.fade);
      cm.body.setColorAt(slot, cols[state - 1]);
      cm.tail.setColorAt(slot, lampC.copy(lampOff).lerp(lampOn, k.brake));
      if (ped) {
        for (let w = 0; w < 4; w++) wheels.setMatrixAt(i * 4 + w, zero);
        indicators.L.setMatrixAt(i, zero); indicators.R.setMatrixAt(i, zero); beams?.setMatrixAt(i, zero);
        if (!layers.cloud && legSlot[i] >= 0) {
          // legs swing about the hip with the stride; still legs when standing
          const sw = k.v > 0.3 ? Math.sin((distanceAt(tr, cums[i], t, data.hz) / 1.3) * Math.PI * 2) * 0.55 : 0;
          fwdV.set(Math.cos(k.h), 0, -Math.sin(k.h)); sideV.set(Math.sin(k.h), 0, Math.cos(k.h));
          for (let l = 0; l < 2; l++) {
            wp.copy(pos).addScaledVector(sideV, l ? 0.1 : -0.1).setY(0.86);
            wq.setFromAxisAngle(sideV, (l ? -sw : sw)); wq.multiplyQuaternions(wq, q);
            m4.compose(wp, wq, v3.set(1, 1, 1));
            legs.setMatrixAt(legSlot[i] * 2 + l, m4); legFade.setX(legSlot[i] * 2 + l, k.fade);
          }
        }
      } else if (!layers.cloud) {
        // indicators (inferred from the turning movement) and night headlight throw
        const turning = turnEnd[i] > 0 && t <= turnEnd[i];
        const left = tr.move === 'left';
        indicators.L.setMatrixAt(i, m4); indicators.R.setMatrixAt(i, m4); indFade.setX(i, k.fade);
        indicators.L.setColorAt(i, turning && left && blinkOn ? cAmber : cIndOff);
        indicators.R.setColorAt(i, turning && !left && blinkOn ? cAmber : cIndOff);
        if (beams) {
          fwdV.set(Math.cos(k.h), 0, -Math.sin(k.h));
          m4.compose(wp.copy(pos).addScaledVector(fwdV, bodyLength(tr) / 2 - 0.2).setY(0.02), q, v3.set(15, 1, 7.5)); beams.setMatrixAt(i, m4);
          beams.setColorAt(i, lampC.copy(cBeam).multiplyScalar(k.fade * Math.min(1, 0.35 + k.v / 6)));
        }
        // wheels roll with the travelled distance; the front pair steers with the yaw rate (bicycle model)
        fwdV.set(Math.cos(k.h), 0, -Math.sin(k.h)); sideV.set(Math.sin(k.h), 0, Math.cos(k.h));
        const spin = distanceAt(tr, cums[i], t, data.hz) / WHEEL.r;
        const ahead = renderPose(tr, t + 0.2, data.hz, win), behind = renderPose(tr, t - 0.2, data.hz, win);
        const rate = ahead && behind ? Math.atan2(Math.sin(ahead.h - behind.h), Math.cos(ahead.h - behind.h)) / 0.4 : 0;
        const steer = steerAngle(rate, k.v, tr.len_m * (cm.wheelX[1] - cm.wheelX[0]));
        const offs = wheelOffsets(cm.wheelX, tr.w_m);
        for (let w = 0; w < 4; w++) {
          const [ax, az] = offs[w];
          wp.copy(pos).addScaledVector(fwdV, ax * tr.len_m).addScaledVector(sideV, az).setY(WHEEL.r);
          wq.setFromAxisAngle(up, w < 2 ? steer : 0); wq2.setFromAxisAngle(zAxis, -spin);
          wq.multiplyQuaternions(q, wq).multiply(wq2);
          m4.compose(wp, wq, v3.set(1, 1, 1));
          wheels.setMatrixAt(i * 4 + w, m4); wheelFade.setX(i * 4 + w, k.fade);
        }
      }
      m4.compose(sc.set(pos.x, 0.012, pos.z), q, v3.set((bodyLength(tr) + (ped ? 0.6 : 1.1)) * k.fade, 1, (tr.w_m + (ped ? 0.5 : 1.3)) * k.fade)); shadows.setMatrixAt(i, m4);
      m4.compose(sc.set(pos.x, -0.2, pos.z), q, v3.set(bodyLength(tr) + (ped ? 1.0 : 0.6), h + 0.4, tr.w_m + (ped ? 1.0 : 0.6))); pick.setMatrixAt(i, m4);
      if ((isSel || isPartner) && nb < MAX_BOXES) {
        const b = boxes[nb++];
        b.visible = true; b.material = isSel ? outlineMat.sel : outlineMat.partner;
        b.position.set(pos.x, h / 2, pos.z); b.rotation.set(0, k.h, 0); b.scale.set(tr.len_m + 0.4, h + 0.3, tr.w_m + 0.4);
      }
      if (isSel || isHov) {
        const tag = tagFor(id);
        tag.visible = true; tag.position.set(pos.x, h + 1.2, pos.z);
        tag.element.textContent = `#${id} · ${(k.v * MPS_TO_MPH).toFixed(1)} mph`;
        tag.element.dataset.sel = isSel ? '1' : '';
      } else { const tg = tags.get(id); if (tg) tg.visible = false; }
    }
    for (let i = nb; i < MAX_BOXES; i++) boxes[i].visible = false;
    // vehicle lamp glows (bodies on): head lamps, tail lamps brighter on braking
    for (let i = 0; i < N; i++) {
      const base = GLOW_LAMPS + GLOW_SIG + i * 4;
      const k = kinOf.get(ids[i]), pos = posOf.get(ids[i]);
      if (!k || !pos || layers.cloud || kinds[i] === 'ped') { for (let g = 0; g < 4; g++) glows.hide(base + g); continue; }
      const tr = data.tracks[i], L = bodyLength(tr);
      fwdV.set(Math.cos(k.h), 0, -Math.sin(k.h)); sideV.set(Math.sin(k.h), 0, Math.cos(k.h));
      const hy = tr.cls === 'truck' || tr.cls === 'bus' ? 1.0 : 0.76, hw = tr.w_m / 2 - 0.3, br = k.brake;
      const front = wp.copy(pos).addScaledVector(fwdV, L / 2 + 0.05).setY(hy).clone(), back = wp.copy(pos).addScaledVector(fwdV, -L / 2 - 0.05).setY(hy + 0.06).clone();
      const hs = pal.dark ? 2.3 : 0.9, ha = (pal.dark ? 0.85 : 0.3) * k.fade;
      glows.set(base, front.clone().addScaledVector(sideV, hw), cHeadGlow, hs, ha);
      glows.set(base + 1, front.clone().addScaledVector(sideV, -hw), cHeadGlow, hs, ha);
      const ts = (pal.dark ? 1.0 : 0.6) + 1.5 * br, ta = ((pal.dark ? 0.42 : 0.2) + 0.58 * br) * k.fade;
      glows.set(base + 2, back.clone().addScaledVector(sideV, hw), cTailGlow, ts, ta);
      glows.set(base + 3, back.clone().addScaledVector(sideV, -hw), cTailGlow, ts, ta);
    }
    glows.commit();
    poseTex.needsUpdate = true;
    for (const m of [pick, shadows, wheels, legs, indicators.L, indicators.R, ...(beams ? [beams] : [])]) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
    legFade.needsUpdate = true; indFade.needsUpdate = true;
    for (const cm of classMeshes.values()) { for (const m of [cm.body, cm.glass, cm.head, cm.tail]) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; } cm.fade.needsUpdate = true; }
    wheelFade.needsUpdate = true;
    pick.boundingSphere = null; pick.boundingBox = null;
    fadeAttr.needsUpdate = true;
    // signal lamps follow the inferred plan
    const lamps: Record<Group, Lamp> = { ns: lampAt(plan, 'ns', t), ew: lampAt(plan, 'ew', t) };
    if (lamps.ns !== lastLamp.ns || lamps.ew !== lastLamp.ew) {
      let kk = 0;
      for (const hd of sig.heads) { const on = lamps[hd.g]; [0, 1, 2].forEach((slot2) => { const li = (2 - slot2) as Lamp; sigLamps.setColorAt(kk++, li === on ? SIG[li] : SIG_OFF); }); }
      if (sigLamps.instanceColor) sigLamps.instanceColor.needsUpdate = true;
      lastLamp.ns = lamps.ns; lastLamp.ew = lamps.ew;
      sig.heads.forEach((hd, j) => { const on = lamps[hd.g]; glows.set(GLOW_LAMPS + j, hd.lamps[2 - on], SIG[on], pal.dark ? 3.2 : 1.6, pal.dark ? 1 : 0.6); });
    }

    // trails: 3 s for every road user in view (faint), selected and partners in colour; ends at the drawn pose
    if (layers.trails) {
      const tp = trailGeo.attributes.position as THREE.BufferAttribute, tc = trailGeo.attributes.color as THREE.BufferAttribute;
      let nt = 0;
      for (const [id, pos] of posOf) {
        const tr = byId.get(id)!, c = selIds.has(id) ? trailSel : partnerIds.has(id) ? trailPartner : trailFaint;
        const lift = selIds.has(id) ? 0.12 : 0.06;
        const i1 = Math.min(tr.pts.length - 1, Math.floor((t - tr.pts[0][0]) * data.hz + 1e-6)), i0 = Math.max(0, i1 - TRAIL_S * 10);
        for (let i = i0 + 1; i <= i1 + 1 && nt < MAX_TRAIL; i++) {
          const a = tr.pts[i - 1], b = i <= i1 ? [0, tr.pts[i][1], tr.pts[i][2]] : [0, pos.x, -pos.z];
          tp.setXYZ(nt * 2, a[1], lift, -a[2]); tp.setXYZ(nt * 2 + 1, b[1], lift, -b[2]);
          tc.setXYZ(nt * 2, c.r, c.g, c.b); tc.setXYZ(nt * 2 + 1, c.r, c.g, c.b); nt++;
        }
      }
      trailGeo.setDrawRange(0, nt * 2); tp.needsUpdate = true; tc.needsUpdate = true;
    }

    // projection: constant-acceleration 2 s path of the selected road users
    projTag.visible = false;
    if (layers.projection) {
      const pp = projGeo.attributes.position as THREE.BufferAttribute;
      let np = 0, n = 0;
      for (const id of selIds) {
        const k = kinOf.get(id);
        if (!k || n++ >= MAX_PROJ) continue;
        const path = projectCA(k, 2, 0.1);
        for (let i = 1; i < path.length; i++) { pp.setXYZ(np * 2, path[i - 1][0], 0.2, -path[i - 1][1]); pp.setXYZ(np * 2 + 1, path[i][0], 0.2, -path[i][1]); np++; }
        if (n === 1 && k.v > 0.5) { const e = path[path.length - 1]; projTag.position.set(e[0], 0.9, -e[1]); projTag.visible = true; }
      }
      projGeo.setDrawRange(0, np * 2); pp.needsUpdate = true; proj.computeLineDistances();
    }

    // conflict zones: brighten those active now (colours only rewritten when the active set changes)
    if (layers.zones && conflicts.length) {
      const key = act.map((k) => k.id).join(',');
      if (key !== lastActive) {
        lastActive = key;
        const on = new Set(act.map((k) => k.id));
        conflicts.forEach((c, i) => zones.setColorAt(i, tmp.set(pal.asphalt).lerp(sevCol(c.severity), on.has(c.id) ? 1 : 0.42)));
        if (zones.instanceColor) zones.instanceColor.needsUpdate = true;
      }
    }

    // near-miss highlight at the focus conflict point
    if (focus && focusPt) {
      const d = Math.abs(t - focus.t), u = Math.max(0, 1 - d / 2.5);
      beacon.visible = true;
      beacon.position.set(focusPt.x, 0, -focusPt.y);
      const s = 1 + 0.6 * u * (0.5 + 0.5 * Math.sin(performance.now() / 160));
      beaconRing.scale.set(s, s, s);
      (beaconRing.material as THREE.MeshBasicMaterial).opacity = 0.25 + 0.75 * u;
      (beaconPole.material as THREE.MeshBasicMaterial).opacity = 0.15 + 0.7 * u;
      focusTag.visible = u > 0.05;
      focusTag.position.set(focusPt.x, 7.6, -focusPt.y);
      focusTag.element.textContent = `${focus.type.replace('_', '-')} · ${focus.ttc_min != null ? `TTC ${focus.ttc_min.toFixed(2)} s` : `PET ${focus.pet?.toFixed(2)} s`} · t ${focus.t.toFixed(1)} s`;
    } else { beacon.visible = false; focusTag.visible = false; }
    dirty = true;
  };

  /* ----- camera modes ----- */
  let yaw = 0, pitch = 0, followYaw = 0, followDist = 15;
  const keys = new Set<string>();
  const lookTarget = new THREE.Vector3();
  const lookFrom = () => {
    const d = new THREE.Vector3(); persp.getWorldDirection(d);
    yaw = Math.atan2(-d.x, -d.z); pitch = Math.asin(Math.max(-1, Math.min(1, d.y)));
  };
  const applyLook = () => { persp.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ')); };
  const groundAhead = () => {
    const d = new THREE.Vector3(); persp.getWorldDirection(d);
    const tt = d.y < -0.05 ? -persp.position.y / d.y : 40;
    return persp.position.clone().addScaledVector(d, Math.min(120, tt));
  };
  const primary = () => { for (const id of selIds) if (posOf.has(id)) return id; return null; };
  /** Height at which the perspective camera, looking straight down, frames the same ground as the top view. */
  const overheadH = () => ((ortho.top - ortho.bottom) / 2 / orthoZoom) / Math.tan(((persp.fov / 2) * Math.PI) / 180);
  /** Where the camera looks on the ground now, in any mode. */
  const viewCentre = () => (mode === 'top' ? new THREE.Vector3(ortho.position.x, 0, ortho.position.z) : mode === 'orbit' && !tween ? controls.target.clone() : groundAhead());

  let tween: { p0: THREE.Vector3; p1: THREE.Vector3; t0: THREE.Vector3; t1: THREE.Vector3; f0: number; f1: number; start: number; dur: number; then: CamMode } | null = null;
  let orthoPan: { from: THREE.Vector2; to: THREE.Vector2; start: number } | null = null;

  const setModeInner = (m: CamMode, notify = true) => {
    if (m === 'follow' && !primary()) m = 'orbit';
    const prev = mode;
    mode = m;
    if (prev === 'sensor' && m !== 'sensor') { persp.fov = 42; persp.updateProjectionMatrix(); }
    controls.enabled = m === 'orbit';
    cam = m === 'top' ? ortho : persp;
    groundMat.size = m === 'top' ? 1.6 : 0.1; groundMat.sizeAttenuation = m !== 'top'; groundMat.needsUpdate = true;
    if (m === 'orbit' && (prev === 'fly' || prev === 'follow' || prev === 'sensor')) controls.target.copy(groundAhead());
    if (m === 'fly' || m === 'sensor') lookFrom();
    if (m === 'follow') { followYaw = 0; }
    if (m === 'top') { const c = prev === 'top' ? new THREE.Vector3(ortho.position.x, 0, ortho.position.z) : groundAhead(); ortho.position.set(c.x, 200, c.z); fitOrtho(); }
    cvs.dataset.mode = m;
    dirty = true;
    if (notify) o.onMode(m);
  };

  /** Leave the orthographic top view for the matching overhead perspective pose (no jump), ready to tween. */
  const leaveTop = () => {
    if (mode !== 'top') return;
    const c = new THREE.Vector3(ortho.position.x, 0, ortho.position.z);
    persp.fov = 42; persp.updateProjectionMatrix();
    persp.position.set(c.x, overheadH(), c.z + 0.01); persp.lookAt(c);
    controls.target.copy(c);
    mode = 'orbit'; cam = persp;
  };

  const flyTo = (p: THREE.Vector3, t: THREE.Vector3, then: CamMode, fovEnd = 42, dur = 900) => {
    const t0 = viewCentre();
    leaveTop();
    controls.enabled = false; cam = persp;
    if (reducedMotion()) {
      persp.position.copy(p); controls.target.copy(t); persp.fov = fovEnd; persp.updateProjectionMatrix(); persp.lookAt(t);
      mode = then === 'sensor' ? 'sensor' : 'orbit';
      setModeInner(then);
      return;
    }
    tween = { p0: persp.position.clone(), p1: p, t0, t1: t, f0: persp.fov, f1: fovEnd, start: performance.now(), dur, then };
    mode = then === 'sensor' ? 'sensor' : 'orbit';
    o.onMode(then);
    dirty = true;
  };
  /** Finish a tween where it stands (the reader grabbed the view). */
  const settleTween = () => {
    if (!tween) return;
    const then = tween.then === 'top' ? 'orbit' : tween.then;
    tween = null;
    controls.target.copy(lookTarget);
    setModeInner(then);
  };

  const preset = (p: PresetId) => {
    cancelReplay();
    const nb = road.stops.find((s) => s.dir === 'NB');
    const nbx = nb ? (nb.a[0] + nb.b[0]) / 2 : 4, nby = nb ? nb.a[1] : -16;
    if (p === 'overview') { const [hp, ht] = homePose(); flyTo(hp, ht, 'orbit', 42); }
    else if (p === 'approach') flyTo(W(nbx, nby - 58, 7.5), W(nbx - 0.5, nby + 14, 0), 'orbit', 50);
    else if (p === 'zone') { const c = focusPt ?? conflictCentroid(); flyTo(W(c.x + 16, c.y - 22, 24), W(c.x, c.y, 0), 'orbit'); }
    else if (p === 'stopline') flyTo(W(nbx + 16, nby - 9, 4.2), W(nbx - 1, nby + 1, 0.6), 'orbit', 46);
    else flyTo(sensorWorld.clone(), W(4, -10, 0), 'sensor', 68);
  };

  /** Eased change of camera mode: top and sensor are flown to; orbit from top tilts back to an oblique view. */
  const setMode = (m: CamMode) => {
    cancelReplay(); settleTween();
    if (m === mode) return;
    if (m === 'top') {
      const c = viewCentre();
      orthoZoom = 1.5; fitOrtho();
      const h = overheadH();
      if (reducedMotion()) { setModeInner('top'); ortho.position.set(c.x, 200, c.z); return; }
      flyTo(new THREE.Vector3(c.x, h, c.z + 0.01), c, 'top', 42, 750);
      return;
    }
    if (m === 'sensor') { flyTo(sensorWorld.clone(), viewCentre(), 'sensor', 68, 850); return; }
    if (mode === 'top' && m === 'orbit') {
      const c = new THREE.Vector3(ortho.position.x, 0, ortho.position.z);
      const [hp, ht] = homePose(), off = hp.sub(ht).setLength(Math.min(90, overheadH() * 0.8));
      flyTo(c.clone().add(off), c, 'orbit', 42, 800);
      return;
    }
    leaveTop();
    setModeInner(m);
  };

  /* ----- replay from three angles ----- */
  let replay: { c: ConflictT; i: number; end: number } | null = null;
  const angleName = (c: ConflictT, i: number) => (i === 0 ? `#${c.a} chase` : i === 1 ? `#${c.b} chase` : 'Overhead, conflict point');
  const startAngle = (i: number) => {
    if (!replay) return;
    replay.i = i;
    const c = replay.c;
    o.clock.pause();
    o.clock.setT(leadIn(c));
    update(o.clock.now());
    o.onReplay({ angle: i + 1, of: 3, name: angleName(c, i) });
    const id = i === 0 ? String(c.a) : i === 1 ? String(c.b) : null;
    const k = id ? kinOf.get(id) : null;
    leaveTop();
    if (id && k) {
      const d = new THREE.Vector3(Math.cos(k.h), 0, -Math.sin(k.h));
      const at = W(k.x, k.y);
      persp.position.copy(at).addScaledVector(d, -13).add(new THREE.Vector3(0, 5.5, 0));
      lookTarget.copy(at).addScaledVector(d, 8);
      persp.lookAt(lookTarget);
    } else {
      const c0 = focusPt ?? conflictCentroid();
      persp.position.copy(W(c0.x - 9, c0.y - 12, 26)); lookTarget.copy(W(c0.x, c0.y, 0)); persp.lookAt(lookTarget);
    }
    cam = persp; controls.enabled = false; tween = null;
    o.clock.play();
  };
  const replayGo = () => {
    if (!focus) return;
    replay = { c: focus, i: 0, end: (focus.t1 ?? focus.t) + 1.4 };
    if (mode === 'top') leaveTop();
    mode = 'orbit';
    startAngle(0);
  };
  function cancelReplay() {
    if (!replay) return;
    replay = null;
    o.onReplay(null);
  }
  const finishReplay = () => {
    const c0 = focusPt ?? conflictCentroid();
    replay = null;
    o.clock.pause();
    o.onReplay(null);
    setModeInner('orbit');
    controls.target.copy(W(c0.x, c0.y, 0));
  };

  /* ----- input ----- */
  const ndc = new THREE.Vector2();
  let pointerIn = false, hoverDirty = false, down: { x: number; y: number; moved: boolean } | null = null;
  const toNdc = (e: PointerEvent) => { const r = cvs.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); };
  const hitId = () => { ray.setFromCamera(ndc, cam); const h = ray.intersectObject(pick, false)[0]; return h?.instanceId != null ? ids[h.instanceId] : null; };
  const onMove = (e: PointerEvent) => {
    if (down) {
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (!down.moved && Math.hypot(dx, dy) < 4) return;
      down.moved = true; down.x = e.clientX; down.y = e.clientY;
      if (mode === 'fly' || mode === 'sensor') { yaw -= dx * 0.004; pitch = Math.max(-1.45, Math.min(1.45, pitch - dy * 0.004)); applyLook(); dirty = true; }
      else if (mode === 'follow') { followYaw -= dx * 0.008; dirty = true; }
      else if (mode === 'top') {
        const s = (ortho.top - ortho.bottom) / ortho.zoom / H0;
        ortho.position.x -= dx * s; ortho.position.z -= dy * s; orthoPan = null; dirty = true;
      }
      return;
    }
    if (e.pointerType !== 'mouse') return;
    toNdc(e); pointerIn = true; hoverDirty = true;
  };
  const onLeave = () => { pointerIn = false; o.onHover(null); };
  const onDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.button !== 2) return;
    if (tween) settleTween();
    if (e.button !== 0) return;
    down = { x: e.clientX, y: e.clientY, moved: false };
    if (mode !== 'orbit') cvs.setPointerCapture(e.pointerId);
    if (replay && mode !== 'orbit') cancelReplay();
  };
  const onUp = (e: PointerEvent) => {
    const d = down; down = null;
    if (!d || d.moved) return;
    toNdc(e);
    const id = hitId();
    if (id) o.onPick(id, e.shiftKey || e.metaKey);
    else if (!e.shiftKey) o.onPick(null, false);
  };
  const onWheel = (e: WheelEvent) => {
    if (tween) settleTween();
    if (mode === 'orbit') return; // OrbitControls zooms
    e.preventDefault();
    const f = Math.exp(-e.deltaY * 0.0015);
    if (mode === 'top') { orthoZoom = Math.max(0.6, Math.min(10, orthoZoom * f)); ortho.zoom = orthoZoom; ortho.updateProjectionMatrix(); }
    else if (mode === 'follow') followDist = Math.max(6, Math.min(60, followDist / f));
    else if (mode === 'sensor') { persp.fov = Math.max(25, Math.min(95, persp.fov / f)); persp.updateProjectionMatrix(); }
    else if (mode === 'fly') { const d = new THREE.Vector3(); persp.getWorldDirection(d); persp.position.addScaledVector(d, -e.deltaY * 0.05); persp.position.y = Math.max(0.6, persp.position.y); }
    dirty = true;
  };
  const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName));
  const FLY_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
  const onKey = (e: KeyboardEvent) => {
    if (mode !== 'fly' || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
    const k = e.key.toLowerCase();
    if (!FLY_KEYS.has(k)) return;
    e.preventDefault(); // keeps ←/→ from stepping time while flying
    keys.add(k);
  };
  const onKeyUp = (e: KeyboardEvent) => { keys.delete(e.key.toLowerCase()); };
  const onBlur = () => keys.clear();
  const onControls = () => { dirty = true; };
  cvs.addEventListener('pointermove', onMove);
  cvs.addEventListener('pointerleave', onLeave);
  cvs.addEventListener('pointerdown', onDown);
  cvs.addEventListener('pointerup', onUp);
  cvs.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', onBlur);
  controls.addEventListener('change', onControls);
  const onRenderReq = () => render();
  el.addEventListener('lab:render', onRenderReq);
  el.parentElement?.addEventListener('lab:render', onRenderReq);

  /* ----- minimap and compass ----- */
  const mm = o.minimap?.getContext('2d') ?? null;
  let mmLast = 0, mmDirty = true;
  const drawMinimap = () => {
    const c = o.minimap;
    if (!c || !mm) return;
    const r = c.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1);
    if (!r.width) return;
    if (c.width !== Math.round(r.width * d)) { c.width = Math.round(r.width * d); c.height = Math.round(r.height * d); }
    const Wm = r.width, Hm = r.height;
    mm.setTransform(d, 0, 0, d, 0, 0);
    mm.clearRect(0, 0, Wm, Hm);
    const s = Math.min(Wm / (bx1 - bx0 + 30), Hm / (by1 - by0 + 10)), cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2;
    const P = (x: number, y: number): [number, number] => [Wm / 2 + (x - cx) * s, Hm / 2 - (y - cy) * s];
    mm.fillStyle = pal.asphalt;
    for (const a of road.arms) { mm.beginPath(); a.forEach(([x, y], i) => { const [u, v] = P(x, y); i ? mm.lineTo(u, v) : mm.moveTo(u, v); }); mm.closePath(); mm.fill(); }
    if (road.cross) { const [u0, v0] = P(road.cross.x0 - 12, road.cross.y1), [u1, v1] = P(road.cross.x1 + 12, road.cross.y0); mm.fillRect(u0, v0, u1 - u0, v1 - v0); }
    // sensor
    const [sx, sy] = P(SENSOR.x, SENSOR.y);
    mm.fillStyle = pal.ink2; mm.fillRect(sx - 2.5, sy - 2.5, 5, 5);
    for (const [id, p] of posOf) {
      const [a, b] = P(p.x, -p.z);
      mm.fillStyle = selIds.has(id) ? pal.sel : partnerIds.has(id) ? pal.partner : pal.ink3;
      const rr = selIds.has(id) ? 3 : 1.6;
      mm.beginPath(); mm.arc(a, b, rr, 0, Math.PI * 2); mm.fill();
    }
    if (focusPt) { const [a, b] = P(focusPt.x, focusPt.y); mm.strokeStyle = pal.critical; mm.lineWidth = 1.5; mm.beginPath(); mm.arc(a, b, 5, 0, Math.PI * 2); mm.stroke(); }
    // camera footprint: position and view direction on the ground
    const camPos = cam === ortho ? new THREE.Vector3(ortho.position.x, 0, ortho.position.z) : persp.position;
    const dir = new THREE.Vector3(); (cam as THREE.Camera).getWorldDirection(dir);
    const [px, py] = P(camPos.x, -camPos.z);
    mm.fillStyle = pal.accent; mm.strokeStyle = pal.accent;
    if (cam === ortho) {
      const hw = (ortho.right - ortho.left) / 2 / ortho.zoom, hh = (ortho.top - ortho.bottom) / 2 / ortho.zoom;
      mm.lineWidth = 1.25; mm.strokeRect(px - hw * s, py - hh * s, hw * 2 * s, hh * 2 * s);
    } else {
      const ang = Math.atan2(-dir.z, dir.x), half = ((persp.fov * persp.aspect) / 2) * (Math.PI / 180) * 0.7;
      mm.globalAlpha = 0.22;
      mm.beginPath(); mm.moveTo(px, py);
      mm.arc(px, py, 34, -(ang + half), -(ang - half)); mm.closePath(); mm.fill();
      mm.globalAlpha = 1; mm.beginPath(); mm.arc(px, py, 3.2, 0, Math.PI * 2); mm.fill();
    }
    // compass: needle points to corridor north in screen space
    const brg = cam === ortho ? 0 : bearingDeg(Math.atan2(-dir.z, dir.x));
    if (o.compass) o.compass.style.transform = `rotate(${-brg}deg)`;
    if (o.heading) o.heading.textContent = `${String(Math.round(brg) % 360).padStart(3, '0')}° ${bearingLabel(brg)}`;
  };
  const onMiniClick = (e: MouseEvent) => {
    const c = o.minimap!; const r = c.getBoundingClientRect();
    const s = Math.min(r.width / (bx1 - bx0 + 30), r.height / (by1 - by0 + 10)), cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2;
    const x = cx + (e.clientX - r.left - r.width / 2) / s, y = cy - (e.clientY - r.top - r.height / 2) / s;
    cancelReplay(); settleTween();
    if (mode === 'top') { orthoPan = { from: new THREE.Vector2(ortho.position.x, ortho.position.z), to: new THREE.Vector2(x, -y), start: performance.now() }; dirty = true; return; }
    if (mode !== 'orbit') setModeInner('orbit');
    const off = persp.position.clone().sub(controls.target);
    const t1 = new THREE.Vector3(x, 0, -y);
    flyTo(t1.clone().add(off), t1, 'orbit', persp.fov, 600);
  };
  o.minimap?.addEventListener('click', onMiniClick);

  /* ----- loop: on demand, paused while hidden or scrolled away ----- */
  let raf = 0, last = performance.now(), onScreen = true, frames = 0, fpsT0 = performance.now(), slow = 0;
  const born = performance.now();
  const render = () => { renderer.render(scene, cam); labels.render(scene, cam); };
  const frame = (now: number) => {
    raf = 0;
    if (document.hidden || !onScreen) return;
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (tween) {
      const u = Math.min(1, (now - tween.start) / tween.dur), e = easeInOutCubic(u);
      persp.position.lerpVectors(tween.p0, tween.p1, e);
      lookTarget.lerpVectors(tween.t0, tween.t1, e);
      persp.fov = tween.f0 + (tween.f1 - tween.f0) * e; persp.updateProjectionMatrix();
      persp.lookAt(lookTarget);
      if (u >= 1) {
        const then = tween.then, t1 = tween.t1.clone();
        tween = null;
        if (then === 'top') { mode = 'orbit'; setModeInner('top', false); ortho.position.set(t1.x, 200, t1.z); }
        else if (then === 'sensor') { setModeInner('sensor', false); persp.position.copy(sensorWorld); persp.lookAt(t1); lookFrom(); }
        else { setModeInner(then, false); if (then === 'orbit') controls.target.copy(t1); }
        o.onMode(mode);
      }
      dirty = true;
    } else if (replay) {
      const c = replay.c, id = replay.i === 0 ? String(c.a) : replay.i === 1 ? String(c.b) : null;
      const k = id ? kinOf.get(id) : null;
      if (k) {
        const d = new THREE.Vector3(Math.cos(k.h), 0, -Math.sin(k.h)), at = W(k.x, k.y);
        const want = at.clone().addScaledVector(d, -13).add(new THREE.Vector3(0, 5.5, 0));
        const a = 1 - Math.exp(-dt * 4);
        persp.position.lerp(want, a); lookTarget.lerp(at.clone().addScaledVector(d, 8), a); persp.lookAt(lookTarget);
      }
      if (tNow >= replay.end) { if (replay.i < 2) startAngle(replay.i + 1); else finishReplay(); }
      dirty = true;
    } else if (mode === 'orbit') {
      if (controls.update()) dirty = true;
    } else if (mode === 'top' && orthoPan) {
      const u = Math.min(1, (now - orthoPan.start) / 600), e = easeInOutCubic(u);
      ortho.position.x = orthoPan.from.x + (orthoPan.to.x - orthoPan.from.x) * e; ortho.position.z = orthoPan.from.y + (orthoPan.to.y - orthoPan.from.y) * e;
      if (u >= 1) orthoPan = null;
      dirty = true;
    } else if (mode === 'fly') {
      if (keys.size) {
        const sp = (keysShift ? 36 : 11) * dt;
        const f = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)), rgt = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
        if (keys.has('w') || keys.has('arrowup')) persp.position.addScaledVector(f, sp);
        if (keys.has('s') || keys.has('arrowdown')) persp.position.addScaledVector(f, -sp);
        if (keys.has('d') || keys.has('arrowright')) persp.position.addScaledVector(rgt, sp);
        if (keys.has('a') || keys.has('arrowleft')) persp.position.addScaledVector(rgt, -sp);
        if (keys.has('e')) persp.position.y += sp;
        if (keys.has('q')) persp.position.y = Math.max(0.6, persp.position.y - sp);
        dirty = true;
      }
    } else if (mode === 'follow') {
      const id = primary(), k = id ? kinOf.get(id) : null;
      if (k) {
        const hd = k.h + followYaw;
        const d = new THREE.Vector3(Math.cos(hd), 0, -Math.sin(hd)), at = W(k.x, k.y);
        const want = at.clone().addScaledVector(d, -followDist).add(new THREE.Vector3(0, 2.5 + followDist * 0.32, 0));
        const a = 1 - Math.exp(-dt * 5);
        persp.position.lerp(want, a);
        lookTarget.lerp(at.clone().addScaledVector(new THREE.Vector3(Math.cos(k.h), 0, -Math.sin(k.h)), 6), a);
        persp.lookAt(lookTarget);
        if (persp.position.distanceToSquared(want) > 1e-4) dirty = true;
      }
    }
    if (hoverDirty && pointerIn && !down) {
      hoverDirty = false;
      const id = hitId();
      cvs.style.cursor = id ? 'pointer' : '';
      if (id !== hovId) o.onHover(id);
    }
    if (cam === ortho) cloudMat.uniforms.uOrthoPx.value = ((H0 * renderer.getPixelRatio()) / (ortho.top - ortho.bottom)) * ortho.zoom;
    if (dirty) {
      dirty = false; mmDirty = true; render(); frames++;
      if (now - fpsT0 >= 1000) {
        const f = Math.round((frames * 1000) / (now - fpsT0));
        o.onFps?.(f);
        // adaptive resolution: a GPU that cannot hold 45 fps gets fewer pixels (DPR steps down to 1), never more work
        const pr = renderer.getPixelRatio();
        // two slow seconds in a row, after the first 4 s (loading, shader compile), before stepping down
        slow = f < 45 && now - born > 4000 ? slow + 1 : 0;
        if (slow >= 2 && pr > 1) { slow = 0; renderer.setPixelRatio(Math.max(1, pr - 0.5)); cloudMat.uniforms.uMaxPx.value = 3.4 * renderer.getPixelRatio(); resize(); }
        frames = 0; fpsT0 = now;
      }
    } else { if (frames || now - fpsT0 > 1000) o.onFps?.(null); frames = 0; fpsT0 = now; }
    if (mmDirty && now - mmLast > 45) { mmDirty = false; mmLast = now; drawMinimap(); }
    raf = requestAnimationFrame(frame);
  };
  let keysShift = false;
  const shiftDown = (e: KeyboardEvent) => { keysShift = e.shiftKey; };
  window.addEventListener('keydown', shiftDown);
  window.addEventListener('keyup', shiftDown);
  const wake = () => { if (!document.hidden && onScreen && !raf) { last = fpsT0 = performance.now(); frames = 0; dirty = true; raf = requestAnimationFrame(frame); } };
  document.addEventListener('visibilitychange', wake);
  const io = new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; wake(); });
  io.observe(el);

  resize();
  applyLayers();
  update(tNow);
  {
    const v = o.view;
    if (v) {
      persp.position.set(...v.pos); controls.target.set(...v.target); persp.fov = v.fov; persp.updateProjectionMatrix(); persp.lookAt(controls.target);
      orthoZoom = v.orthoZoom; ortho.position.set(v.orthoPos[0], 200, v.orthoPos[1]); fitOrtho();
      setModeInner(v.mode === 'follow' ? 'orbit' : v.mode, false);
      if (v.mode === 'top') ortho.position.set(v.orthoPos[0], 200, v.orthoPos[1]);
      if (v.mode === 'orbit') controls.target.set(...v.target);
    } else {
      const [hp, ht] = homePose();
      persp.position.copy(hp); controls.target.copy(ht); persp.lookAt(ht);
      if (o.mode === 'sensor') { persp.position.copy(sensorWorld); persp.fov = 68; persp.updateProjectionMatrix(); persp.lookAt(ht); }
      setModeInner(o.mode === 'follow' ? 'orbit' : o.mode, false);
      if (o.mode === 'sensor') { persp.fov = 68; persp.updateProjectionMatrix(); }
    }
  }
  raf = requestAnimationFrame(frame);

  return {
    update,
    setSel: (s, h, f) => {
      const changed = s !== selIds;
      selIds = s; hovId = h; partnerIds = new Set();
      for (const k of conflicts) {
        const a = String(k.a), b = String(k.b);
        if (s.has(a) && !s.has(b)) partnerIds.add(b);
        if (s.has(b) && !s.has(a)) partnerIds.add(a);
      }
      if (f !== focus) {
        focus = f;
        const i = f ? conflicts.findIndex((c) => c.id === f.id) : -1;
        focusPt = i >= 0 ? cpts[i] : f ? conflictPoint(f, byId.get(String(f.a)), byId.get(String(f.b)), data.hz) : null;
        if (!f) cancelReplay();
        // linked selection: frame the pair around the conflict point, keeping the viewing direction
        if (f && focusPt && !replay) {
          const A = byId.get(String(f.a)), B = byId.get(String(f.b));
          let spread = 0;
          for (const t of [leadIn(f), f.t]) { const a = A && kinAt(A, t, data.hz), b = B && kinAt(B, t, data.hz); if (a && b) spread = Math.max(spread, Math.hypot(a.x - b.x, a.y - b.y)); }
          const t1 = W(focusPt.x, focusPt.y, 0);
          if (mode === 'top') { orthoPan = { from: new THREE.Vector2(ortho.position.x, ortho.position.z), to: new THREE.Vector2(t1.x, t1.z), start: performance.now() }; dirty = true; }
          else if (mode === 'orbit' || tween) {
            settleTween();
            const off = persp.position.clone().sub(controls.target);
            off.y = Math.max(off.y, off.length() * 0.45);
            off.setLength(Math.min(70, Math.max(24, spread * 1.8 + 18)));
            flyTo(t1.clone().add(off), t1, 'orbit', 42, 800);
          }
        }
      }
      update(tNow);
      if (changed && mode === 'follow' && !primary()) setModeInner('orbit');
    },
    setMode,
    preset,
    setLayers: (l) => { layers = l; applyLayers(); update(tNow); },
    replay: replayGo,
    cancelReplay: () => { if (replay) { const c = lookTarget.clone(); cancelReplay(); o.clock.pause(); setModeInner('orbit'); controls.target.copy(c); } },
    getView: () => ({
      mode: tween ? tween.then : mode,
      pos: (tween ? tween.p1 : persp.position).toArray() as [number, number, number],
      target: (tween ? tween.t1 : mode === 'orbit' ? controls.target : groundAhead()).toArray() as [number, number, number],
      fov: tween ? tween.f1 : persp.fov,
      orthoPos: [ortho.position.x, ortho.position.z], orthoZoom,
    }),
    render,
    dispose: () => {
      cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); controls.dispose();
      controls.removeEventListener('change', onControls);
      cvs.removeEventListener('pointermove', onMove); cvs.removeEventListener('pointerleave', onLeave);
      cvs.removeEventListener('pointerdown', onDown); cvs.removeEventListener('pointerup', onUp); cvs.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey, true); window.removeEventListener('keyup', onKeyUp, true); window.removeEventListener('blur', onBlur);
      window.removeEventListener('keydown', shiftDown); window.removeEventListener('keyup', shiftDown);
      document.removeEventListener('visibilitychange', wake);
      el.removeEventListener('lab:render', onRenderReq); el.parentElement?.removeEventListener('lab:render', onRenderReq);
      o.minimap?.removeEventListener('click', onMiniClick);
      scene.traverse((ob: THREE.Object3D) => { const m = ob as THREE.Mesh; m.geometry?.dispose?.(); const mat = m.material as THREE.Material | THREE.Material[] | undefined; (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => x.dispose()); });
      edges.dispose(); poseTex.dispose(); shadowTex.dispose(); Object.values(outlineMat).forEach((x) => x.dispose());
      for (const t of tags.values()) t.element.remove();
      renderer.forceContextLoss(); renderer.dispose();
      cvs.remove(); labels.domElement.remove();
    },
  };
}

export type { TrackT };
