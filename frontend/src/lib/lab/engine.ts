/**
 * Three.js scene for the intersection lab: a simulated roadside-LiDAR view of NGSIM vehicle tracks.
 * One draw call for all vehicle returns (instanced through a pose texture), one for vehicle bodies,
 * one for picking; render on demand; no work while the tab is hidden.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { CHART, conflictColor } from '../format';
import { reducedMotion } from '../motion';
import { activeAt, leadIn, type ConflictT, type IntersectionT, type TrackT } from '../traj';
import { bearingDeg, bearingLabel, conflictPoint, easeInOutCubic, kinAt, MPS_TO_MPH, projectCA, stopLine } from './metrics';

export type CamMode = 'orbit' | 'fly' | 'follow' | 'top' | 'sensor';
export type PresetId = 'approach' | 'zone' | 'stopline' | 'sensor';
export interface Layers { trails: boolean; projection: boolean; zones: boolean; fov: boolean; cloud: boolean }
export interface ReplayStatus { angle: number; of: number; name: string }

/** Assumed sensor model (simulated): 32-channel spinning LiDAR on a 4.5 m pole, −25°…+15° vertical FOV, 80 m range. */
export const SENSOR = { x: -12, y: 12, z: 4.5, vMin: -25, vMax: 15, range: 80, channels: 32 } as const;
export const BLIND_R = SENSOR.z / Math.tan((-SENSOR.vMin * Math.PI) / 180);

const PICK_LAYER = 1;
const MAX_BOXES = 12, MAX_PROJ = 4, PROJ_STEPS = 20, TRAIL_S = 3;
const heightOf = (cls: string) => (cls === 'truck' ? 3.2 : cls === 'motorcycle' ? 1.3 : 1.5);

/** Points on the faces of a vehicle box (roof, sides, ends), local frame: x along length, y up, z across. */
function vehicleCloud(len: number, wid: number, hgt: number, n: number, rnd: () => number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const f = rnd();
    let x: number, y: number, z: number;
    if (f < 0.35) { x = (rnd() - 0.5) * len; z = (rnd() - 0.5) * wid; y = hgt; }
    else if (f < 0.7) { x = (rnd() - 0.5) * len; z = Math.sign(rnd() - 0.5) * wid / 2; y = rnd() * hgt; }
    else { x = Math.sign(rnd() - 0.5) * len / 2; z = (rnd() - 0.5) * wid; y = rnd() * hgt; }
    if (y > hgt * 0.62) x *= 0.7; // cabin taper
    out.push(x, y, z);
  }
  return out;
}

/** Deterministic PRNG so the simulated returns look the same on every visit. */
function mulberry(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const CLOUD_VS = /* glsl */ `
uniform sampler2D uPose;
uniform float uSize;
uniform float uScale;
uniform float uOrthoPx;
uniform float uMaxPx;
uniform vec3 uCol[6];
attribute float slot;
varying vec3 vCol;
void main() {
  vec4 p = texelFetch(uPose, ivec2(int(slot), 0), 0);
  if (p.w < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vCol = vec3(0.0); return; }
  float c = cos(p.z), s = sin(p.z);
  vec3 wp = vec3(p.x + position.x * c + position.z * s, position.y, p.y - position.x * s + position.z * c);
  vec4 mv = modelViewMatrix * vec4(wp, 1.0);
  float k = p.w > 4.5 ? 1.3 : 1.0;
  bool persp = projectionMatrix[2][3] == -1.0;
  gl_PointSize = clamp(persp ? uSize * k * uScale / -mv.z : uSize * k * uOrthoPx, 1.2, uMaxPx * k);
  vCol = uCol[int(p.w + 0.5) - 1];
  gl_Position = projectionMatrix * mv;
}`;
const CLOUD_FS = /* glsl */ `
varying vec3 vCol;
void main() {
  if (length(gl_PointCoord - 0.5) > 0.5) discard;
  gl_FragColor = vec4(vCol, 1.0);
}`;

export interface EngineOpts {
  host: HTMLElement;
  minimap: HTMLCanvasElement | null;
  compass: HTMLElement | null;
  heading: HTMLElement | null;
  data: IntersectionT;
  conflicts: ConflictT[];
  layers: Layers;
  mode: CamMode;
  clock: { now: () => number; setT: (t: number) => void; play: () => void; pause: () => void };
  onPick: (id: string | null, add: boolean) => void;
  onHover: (id: string | null) => void;
  onMode: (m: CamMode) => void;
  onReplay: (s: ReplayStatus | null) => void;
}

export interface Engine {
  update: (t: number) => void;
  setSel: (sel: Set<string>, hov: string | null, focus: ConflictT | null) => void;
  setMode: (m: CamMode) => void;
  preset: (p: PresetId) => void;
  setLayers: (l: Layers) => void;
  replay: () => void;
  cancelReplay: () => void;
  render: () => void;
  dispose: () => void;
}

export function createEngine(o: EngineOpts): Engine {
  const { host: el, data, conflicts } = o;
  const PT = { car: CHART.sb, truck: CHART.eb, hot: CHART.critical, partner: CHART.caution, hov: CHART.ink, sel: CHART.accent };

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  const cvs = renderer.domElement;
  cvs.className = 'lidar-gl';
  el.prepend(cvs);
  const labels = new CSS2DRenderer();
  labels.domElement.className = 'lidar-labels';
  el.insertBefore(labels.domElement, cvs.nextSibling);

  const bg = new THREE.Color(CHART.ground);
  const scene = new THREE.Scene();
  scene.background = bg;
  scene.fog = new THREE.Fog(bg, 110, 230);
  scene.add(new THREE.HemisphereLight(0xffffff, new THREE.Color(CHART.ground), 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(-30, 60, 20); scene.add(sun);

  // World mapping: data (x across, y along corridor) → three (X = x, Z = −y), Y up.
  const W = (x: number, y: number, h = 0) => new THREE.Vector3(x, h, -y);
  const [[bx0, by0], [bx1, by1]] = data.bbox as [[number, number], [number, number]];
  const mid = W((bx0 + bx1) / 2, (by0 + by1) / 2);
  const sensorWorld = new THREE.Vector3(SENSOR.x, SENSOR.z + 0.25, -SENSOR.y);
  const byId = new Map(data.tracks.map((t) => [String(t.id), t]));
  const ids = data.tracks.map((t) => String(t.id));
  const N = data.tracks.length;

  /* ----- ground: ring returns (cloud on) or a plain apron (cloud off) ----- */
  const g: number[] = [], gc: number[] = [];
  const ink = new THREE.Color(CHART.axis), tmp = new THREE.Color();
  for (let ch = 0; ch < SENSOR.channels; ch++) {
    const elev = SENSOR.vMin + (ch * (SENSOR.vMax - SENSOR.vMin)) / (SENSOR.channels - 1);
    if (elev >= -0.5) continue;
    const r = SENSOR.z / Math.tan((-elev * Math.PI) / 180);
    if (r > SENSOR.range) continue;
    const n = Math.round(r * 9);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      g.push(SENSOR.x + Math.cos(a) * r, 0, -(SENSOR.y + Math.sin(a) * r));
      tmp.copy(bg).lerp(ink, 0.3 + 0.5 * Math.exp(-r / 35));
      gc.push(tmp.r, tmp.g, tmp.b);
    }
  }
  const groundGeo = new THREE.BufferGeometry();
  groundGeo.setAttribute('position', new THREE.Float32BufferAttribute(g, 3));
  groundGeo.setAttribute('color', new THREE.Float32BufferAttribute(gc, 3));
  const groundMat = new THREE.PointsMaterial({ size: 0.12, vertexColors: true, sizeAttenuation: true });
  const groundPts = new THREE.Points(groundGeo, groundMat);
  scene.add(groundPts);
  const apron = new THREE.Mesh(new THREE.PlaneGeometry(bx1 - bx0 + 40, by1 - by0 + 40), new THREE.MeshBasicMaterial({ color: CHART.graticule }));
  apron.rotation.x = -Math.PI / 2; apron.position.set(mid.x, -0.02, mid.z); scene.add(apron);

  /* ----- lane centrelines and derived stop bars ----- */
  const laneMat = new THREE.LineDashedMaterial({ color: CHART.rule, dashSize: 1.5, gapSize: 2 });
  for (const l of data.lanes_geom) {
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(l.centre.map(([x, y]) => W(x, y, 0.02))), laneMat);
    line.computeLineDistances(); scene.add(line);
  }
  const stops = { NB: stopLine(data.tracks, 'NB'), SB: stopLine(data.tracks, 'SB') };
  const laneX = (dir: string, y: number) => data.lanes_geom.filter((l) => l.dir === dir).map((l) => {
    const c = l.centre; let best = c[0];
    for (const p of c) if (Math.abs(p[1] - y) < Math.abs(best[1] - y)) best = p;
    return Math.abs(best[1] - y) < 12 ? best[0] : null;
  }).filter((v): v is number => v != null);
  const stopMat = new THREE.LineBasicMaterial({ color: CHART.ink2 });
  for (const dir of ['NB', 'SB'] as const) {
    const s = stops[dir];
    if (!s) continue;
    const xs = laneX(dir, s.y);
    const xa = xs.length ? Math.min(...xs) - 1.8 : s.x - 3.6, xb = xs.length ? Math.max(...xs) + 1.8 : s.x + 3.6;
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([W(xa, s.y, 0.04), W(xb, s.y, 0.04)]), stopMat));
  }

  /* ----- sensor pole, head and FOV ----- */
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, SENSOR.z, 8), new THREE.MeshBasicMaterial({ color: CHART.axis }));
  pole.position.set(SENSOR.x, SENSOR.z / 2, -SENSOR.y); scene.add(pole);
  const head = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.4, 16), new THREE.MeshBasicMaterial({ color: CHART.ink2 }));
  head.position.set(SENSOR.x, SENSOR.z + 0.2, -SENSOR.y); scene.add(head);
  const fov = new THREE.Group();
  const cone = new THREE.Mesh(new THREE.ConeGeometry(SENSOR.range, SENSOR.z, 96, 1, true),
    new THREE.MeshBasicMaterial({ color: CHART.accent, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false }));
  cone.position.set(SENSOR.x, SENSOR.z / 2, -SENSOR.y);
  fov.add(cone);
  const fovLine = new THREE.LineBasicMaterial({ color: CHART.accent, transparent: true, opacity: 0.55 });
  const spokes: THREE.Vector3[] = [];
  for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; spokes.push(sensorWorld.clone(), new THREE.Vector3(SENSOR.x + Math.cos(a) * SENSOR.range, 0.03, -SENSOR.y - Math.sin(a) * SENSOR.range)); }
  fov.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(spokes), new THREE.LineBasicMaterial({ color: CHART.accent, transparent: true, opacity: 0.32 })));
  const ring = (r: number) => { const pts: THREE.Vector3[] = []; for (let i = 0; i <= 128; i++) { const a = (i / 128) * Math.PI * 2; pts.push(new THREE.Vector3(SENSOR.x + Math.cos(a) * r, 0.03, -SENSOR.y - Math.sin(a) * r)); } return new THREE.BufferGeometry().setFromPoints(pts); };
  fov.add(new THREE.Line(ring(SENSOR.range), fovLine));
  const blind = new THREE.Line(ring(BLIND_R), new THREE.LineDashedMaterial({ color: CHART.caution, dashSize: 0.6, gapSize: 0.5 }));
  blind.computeLineDistances(); fov.add(blind);
  scene.add(fov);

  /* ----- vehicle returns: one Points, posed per slot from a float texture ----- */
  const poseArr = new Float32Array(N * 4);
  const poseTex = new THREE.DataTexture(poseArr, N, 1, THREE.RGBAFormat, THREE.FloatType);
  poseTex.needsUpdate = true;
  const rnd = mulberry(20251017);
  const cp: number[] = [], cs: number[] = [];
  data.tracks.forEach((tr, i) => {
    const pts = vehicleCloud(tr.len_m, tr.w_m, heightOf(tr.cls), tr.cls === 'truck' ? 1300 : 520, rnd);
    cp.push(...pts);
    for (let k = 0; k < pts.length / 3; k++) cs.push(i);
  });
  const cloudGeo = new THREE.BufferGeometry();
  cloudGeo.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
  cloudGeo.setAttribute('slot', new THREE.Float32BufferAttribute(cs, 1));
  const cols = [PT.car, PT.truck, PT.hot, PT.partner, PT.hov, PT.sel].map((c) => new THREE.Color(c));
  const cloudMat = new THREE.ShaderMaterial({
    vertexShader: CLOUD_VS, fragmentShader: CLOUD_FS, fog: false,
    uniforms: { uPose: { value: poseTex }, uSize: { value: 0.2 }, uScale: { value: 300 }, uOrthoPx: { value: 4 }, uMaxPx: { value: 3.4 * Math.min(2, devicePixelRatio) }, uCol: { value: cols } },
  });
  const cloud = new THREE.Points(cloudGeo, cloudMat);
  cloud.frustumCulled = false;
  scene.add(cloud);

  /* ----- vehicle bodies (cloud off) and picking proxies: instanced ----- */
  const boxGeo = new THREE.BoxGeometry(1, 1, 1); boxGeo.translate(0, 0.5, 0);
  const bodies = new THREE.InstancedMesh(boxGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), N);
  bodies.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  bodies.setColorAt(0, cols[0]);
  bodies.frustumCulled = false;
  scene.add(bodies);
  const pick = new THREE.InstancedMesh(boxGeo, new THREE.MeshBasicMaterial(), N);
  pick.layers.set(PICK_LAYER);
  pick.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(pick);
  const ray = new THREE.Raycaster();
  ray.layers.set(PICK_LAYER);

  /* ----- outlines, trails, projections, conflict zones, focus beacon ----- */
  const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
  const outlineMat = { sel: new THREE.LineBasicMaterial({ color: PT.sel }), partner: new THREE.LineBasicMaterial({ color: PT.partner }) };
  const boxes = Array.from({ length: MAX_BOXES }, () => { const b = new THREE.LineSegments(edges, outlineMat.sel); b.visible = false; scene.add(b); return b; });

  const MAX_TRAIL = N * TRAIL_S * 10;
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_TRAIL * 6), 3).setUsage(THREE.DynamicDrawUsage));
  trailGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_TRAIL * 6), 3).setUsage(THREE.DynamicDrawUsage));
  const trails = new THREE.LineSegments(trailGeo, new THREE.LineBasicMaterial({ vertexColors: true }));
  trails.frustumCulled = false; scene.add(trails);
  const trailFaint = new THREE.Color(CHART.ground).lerp(new THREE.Color(CHART.ink2), 0.32), trailSel = new THREE.Color(PT.sel), trailPartner = new THREE.Color(PT.partner);

  const projGeo = new THREE.BufferGeometry();
  projGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_PROJ * PROJ_STEPS * 6), 3).setUsage(THREE.DynamicDrawUsage));
  const proj = new THREE.LineSegments(projGeo, new THREE.LineDashedMaterial({ color: PT.sel, dashSize: 0.7, gapSize: 0.5 }));
  proj.frustumCulled = false; scene.add(proj);

  const cpts = conflicts.map((c) => conflictPoint(c, byId.get(String(c.a)), byId.get(String(c.b)), data.hz));
  const zoneGeo = new THREE.RingGeometry(0.55, 0.85, 28); zoneGeo.rotateX(-Math.PI / 2);
  const zones = new THREE.InstancedMesh(zoneGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }), Math.max(1, conflicts.length));
  zones.renderOrder = 1;
  {
    const m = new THREE.Matrix4();
    conflicts.forEach((c, i) => {
      const p = cpts[i];
      m.makeTranslation(p ? p.x : 0, 0.05 + i * 0.0004, p ? -p.y : 0);
      if (!p) m.scale(new THREE.Vector3(0, 0, 0));
      zones.setMatrixAt(i, m);
      zones.setColorAt(i, new THREE.Color(CHART.ground).lerp(new THREE.Color(conflictColor(c.severity)), 0.5));
    });
    if (!conflicts.length) zones.count = 0;
  }
  scene.add(zones);

  const beacon = new THREE.Group();
  const beaconRing = new THREE.Mesh(new THREE.RingGeometry(1.5, 1.85, 48), new THREE.MeshBasicMaterial({ color: CHART.critical, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
  beaconRing.rotation.x = -Math.PI / 2; beaconRing.position.y = 0.08;
  const beaconPole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 7, 6), new THREE.MeshBasicMaterial({ color: CHART.critical, transparent: true }));
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
  const persp = new THREE.PerspectiveCamera(42, 1, 0.3, 600);
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 600);
  ortho.up.set(0, 0, -1); ortho.position.set(mid.x, 200, mid.z); ortho.lookAt(mid);
  let cam: THREE.Camera = persp;
  const controls = new OrbitControls(persp, cvs);
  controls.enableDamping = true; controls.dampingFactor = 0.09; controls.maxPolarAngle = Math.PI * 0.47; controls.minDistance = 6; controls.maxDistance = 220;
  controls.cursorStyle = 'grab';
  const OBLIQUE: [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(mid.x - 38, 34, mid.z + 44), new THREE.Vector3(mid.x, 0, mid.z + 6)];
  persp.position.copy(OBLIQUE[0]); controls.target.copy(OBLIQUE[1]);

  let W0 = 1, H0 = 1, orthoZoom = 1;
  const fitOrtho = () => {
    const aspect = W0 / H0, halfH = Math.max((by1 - by0) / 2 + 6, ((bx1 - bx0) / 2 + 6) / aspect);
    ortho.left = -halfH * aspect; ortho.right = halfH * aspect; ortho.top = halfH; ortho.bottom = -halfH;
    ortho.zoom = orthoZoom; ortho.updateProjectionMatrix();
  };
  const resize = () => {
    W0 = Math.max(1, el.clientWidth); H0 = Math.max(1, el.clientHeight);
    renderer.setSize(W0, H0, false); labels.setSize(W0, H0);
    persp.aspect = W0 / H0; persp.updateProjectionMatrix(); fitOrtho();
    cloudMat.uniforms.uScale.value = (H0 * renderer.getPixelRatio()) / 2;
    dirty = true;
  };
  let dirty = true;
  const ro = new ResizeObserver(resize); ro.observe(el);

  /* ----- state ----- */
  let layers = o.layers;
  let mode: CamMode = 'orbit';
  let selIds = new Set<string>(), hovId: string | null = null, partnerIds = new Set<string>(), focus: ConflictT | null = null, focusPt: { x: number; y: number } | null = null;
  let tNow = o.clock.now();
  const posOf = new Map<string, THREE.Vector3>();
  const kinOf = new Map<string, NonNullable<ReturnType<typeof kinAt>>>();
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), v3 = new THREE.Vector3();
  let lastActive = '';

  const applyLayers = () => {
    groundPts.visible = layers.cloud; apron.visible = !layers.cloud;
    cloud.visible = layers.cloud; bodies.visible = !layers.cloud;
    trails.visible = layers.trails; proj.visible = layers.projection;
    zones.visible = layers.zones; fov.visible = layers.fov;
    dirty = true;
  };

  const update = (t: number) => {
    tNow = t;
    const act = activeAt(conflicts, t);
    const hot = new Set(act.flatMap((k) => [String(k.a), String(k.b)]));
    posOf.clear(); kinOf.clear();
    let nb = 0;
    for (let i = 0; i < N; i++) {
      const tr = data.tracks[i], id = ids[i];
      const k = kinAt(tr, t, data.hz);
      const pos = k && W(k.x, k.y);
      const inRange = !!pos && Math.hypot(pos.x - sensorWorld.x, pos.z - sensorWorld.z) < SENSOR.range;
      if (!k || !pos || !inRange) {
        poseArr[i * 4 + 3] = 0;
        m4.makeScale(0, 0, 0); pick.setMatrixAt(i, m4); bodies.setMatrixAt(i, m4);
        const tg = tags.get(id); if (tg) tg.visible = false;
        continue;
      }
      posOf.set(id, pos); kinOf.set(id, k);
      const isSel = selIds.has(id), isPartner = partnerIds.has(id), isHov = id === hovId;
      const state = isSel ? 6 : isHov ? 5 : isPartner ? 4 : hot.has(id) ? 3 : tr.cls === 'truck' ? 2 : 1;
      poseArr[i * 4] = pos.x; poseArr[i * 4 + 1] = pos.z; poseArr[i * 4 + 2] = k.h; poseArr[i * 4 + 3] = state;
      const h = heightOf(tr.cls);
      q.setFromAxisAngle(up, k.h);
      m4.compose(sc.set(pos.x, 0, pos.z), q, v3.set(tr.len_m, h, tr.w_m)); bodies.setMatrixAt(i, m4);
      bodies.setColorAt(i, cols[state - 1]);
      m4.compose(sc.set(pos.x, -0.2, pos.z), q, v3.set(tr.len_m + 0.6, h + 0.4, tr.w_m + 0.6)); pick.setMatrixAt(i, m4);
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
    poseTex.needsUpdate = true;
    pick.instanceMatrix.needsUpdate = true; pick.boundingSphere = null; pick.boundingBox = null;
    bodies.instanceMatrix.needsUpdate = true; if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;

    // trails: 3 s for every road user in view (faint), selected and partners in colour
    if (layers.trails) {
      const tp = trailGeo.attributes.position as THREE.BufferAttribute, tc = trailGeo.attributes.color as THREE.BufferAttribute;
      let nt = 0;
      for (const id of posOf.keys()) {
        const tr = byId.get(id)!, c = selIds.has(id) ? trailSel : partnerIds.has(id) ? trailPartner : trailFaint;
        const lift = selIds.has(id) ? 0.12 : 0.06;
        const i1 = Math.min(tr.pts.length - 1, Math.round((t - tr.pts[0][0]) * data.hz)), i0 = Math.max(0, i1 - TRAIL_S * 10);
        for (let i = i0 + 1; i <= i1 && nt < MAX_TRAIL; i++) {
          const a = tr.pts[i - 1], b = tr.pts[i];
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
        conflicts.forEach((c, i) => zones.setColorAt(i, tmp.set(CHART.ground).lerp(new THREE.Color(conflictColor(c.severity)), on.has(c.id) ? 1 : 0.42)));
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

  let tween: { p0: THREE.Vector3; p1: THREE.Vector3; t0: THREE.Vector3; t1: THREE.Vector3; f0: number; f1: number; start: number; dur: number; then: CamMode } | null = null;
  const setModeInner = (m: CamMode, notify = true) => {
    if (m === 'follow' && !primary()) m = 'orbit';
    const prev = mode;
    mode = m;
    if (prev === 'sensor' && m !== 'sensor') { persp.fov = 42; persp.updateProjectionMatrix(); }
    controls.enabled = m === 'orbit';
    cam = m === 'top' ? ortho : persp;
    groundMat.size = m === 'top' ? 1.6 : 0.12; groundMat.sizeAttenuation = m !== 'top'; groundMat.needsUpdate = true;
    if (m === 'orbit' && prev !== 'orbit' && prev !== 'top') controls.target.copy(groundAhead());
    if (m === 'orbit' && prev === 'top') { persp.position.copy(OBLIQUE[0]); controls.target.copy(OBLIQUE[1]); }
    if (m === 'fly') lookFrom();
    if (m === 'sensor') { persp.position.copy(sensorWorld); persp.fov = 68; persp.updateProjectionMatrix(); persp.lookAt(mid.x, 0, mid.z); lookFrom(); }
    if (m === 'follow') { followYaw = 0; }
    if (m === 'top') { orthoZoom = 1.5; ortho.position.set(mid.x, 200, mid.z); fitOrtho(); }
    cvs.dataset.mode = m;
    dirty = true;
    if (notify) o.onMode(m);
  };

  const flyTo = (p: THREE.Vector3, t: THREE.Vector3, then: CamMode, fov = 42, dur = 900) => {
    if (mode === 'top') { setModeInner('orbit', false); }
    controls.enabled = false; cam = persp;
    const t0 = mode === 'orbit' ? controls.target.clone() : groundAhead();
    if (reducedMotion()) { persp.position.copy(p); controls.target.copy(t); persp.fov = fov; persp.updateProjectionMatrix(); persp.lookAt(t); setModeInner(then); if (then === 'sensor') { persp.lookAt(t); lookFrom(); } return; }
    tween = { p0: persp.position.clone(), p1: p, t0, t1: t, f0: persp.fov, f1: fov, start: performance.now(), dur, then };
    mode = then === 'sensor' ? 'sensor' : 'orbit';
    o.onMode(then);
  };

  const conflictCentroid = () => {
    if (focusPt) return focusPt;
    let sx = 0, sy = 0, n = 0;
    cpts.forEach((p, i) => { if (!p) return; const w = conflicts[i].severity === 'critical' ? 2 : 1; sx += p.x * w; sy += p.y * w; n += w; });
    return n ? { x: sx / n, y: sy / n } : { x: 0, y: 0 };
  };
  const preset = (p: PresetId) => {
    cancelReplay();
    const nb = stops.NB ?? { x: 4, y: -16 };
    if (p === 'approach') flyTo(W(nb.x, nb.y - 58, 7.5), W(nb.x - 0.5, nb.y + 14, 0), 'orbit', 50);
    else if (p === 'zone') { const c = conflictCentroid(); flyTo(W(c.x - 16, c.y - 20, 22), W(c.x, c.y, 0), 'orbit'); }
    else if (p === 'stopline') flyTo(W(nb.x + 16, nb.y - 9, 4.2), W(nb.x - 1, nb.y + 1, 0.6), 'orbit', 46);
    else flyTo(sensorWorld.clone(), W(4, -10, 0), 'sensor', 68);
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
    controls.target.copy(W(c0.x, c0.y, 0));
    setModeInner('orbit');
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
        ortho.position.x -= dx * s; ortho.position.z -= dy * s; dirty = true;
      }
      return;
    }
    if (e.pointerType !== 'mouse') return;
    toNdc(e); pointerIn = true; hoverDirty = true;
  };
  const onLeave = () => { pointerIn = false; o.onHover(null); };
  const onDown = (e: PointerEvent) => {
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
    if (c.width !== Math.round(r.width * d)) { c.width = Math.round(r.width * d); c.height = Math.round(r.height * d); }
    const Wm = r.width, Hm = r.height;
    mm.setTransform(d, 0, 0, d, 0, 0);
    mm.clearRect(0, 0, Wm, Hm);
    const s = Math.min(Wm / (bx1 - bx0 + 30), Hm / (by1 - by0 + 10)), cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2;
    const P = (x: number, y: number): [number, number] => [Wm / 2 + (x - cx) * s, Hm / 2 - (y - cy) * s];
    mm.strokeStyle = CHART.rule; mm.lineWidth = 1;
    for (const l of data.lanes_geom) { mm.beginPath(); l.centre.forEach(([x, y], i) => { const [a, b] = P(x, y); i ? mm.lineTo(a, b) : mm.moveTo(a, b); }); mm.stroke(); }
    // sensor and range
    const [sx, sy] = P(SENSOR.x, SENSOR.y);
    mm.fillStyle = CHART.ink2; mm.fillRect(sx - 2.5, sy - 2.5, 5, 5);
    for (const [id, p] of posOf) {
      const [a, b] = P(p.x, -p.z);
      mm.fillStyle = selIds.has(id) ? CHART.accent : partnerIds.has(id) ? CHART.caution : CHART.axis;
      const rr = selIds.has(id) ? 3 : 1.6;
      mm.beginPath(); mm.arc(a, b, rr, 0, Math.PI * 2); mm.fill();
    }
    if (focusPt) { const [a, b] = P(focusPt.x, focusPt.y); mm.strokeStyle = CHART.critical; mm.lineWidth = 1.5; mm.beginPath(); mm.arc(a, b, 5, 0, Math.PI * 2); mm.stroke(); }
    // camera footprint: position and view direction on the ground
    const camPos = cam === ortho ? new THREE.Vector3(ortho.position.x, 0, ortho.position.z) : persp.position;
    const dir = new THREE.Vector3(); (cam as THREE.Camera).getWorldDirection(dir);
    const [px, py] = P(camPos.x, -camPos.z);
    if (cam === ortho) {
      const hw = (ortho.right - ortho.left) / 2 / ortho.zoom, hh = (ortho.top - ortho.bottom) / 2 / ortho.zoom;
      mm.strokeStyle = CHART.accent; mm.lineWidth = 1.25; mm.strokeRect(px - hw * s, py - hh * s, hw * 2 * s, hh * 2 * s);
    } else {
      const ang = Math.atan2(-dir.z, dir.x), half = ((persp.fov * persp.aspect) / 2) * (Math.PI / 180) * 0.7;
      mm.fillStyle = CHART.accent; mm.globalAlpha = 0.22;
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
    cancelReplay();
    if (mode === 'top') { ortho.position.x = x; ortho.position.z = -y; dirty = true; return; }
    if (mode !== 'orbit') setModeInner('orbit');
    const off = persp.position.clone().sub(controls.target);
    controls.target.set(x, 0, -y); persp.position.copy(controls.target).add(off); dirty = true;
  };
  o.minimap?.addEventListener('click', onMiniClick);

  /* ----- loop ----- */
  let raf = 0, last = performance.now();
  const render = () => { renderer.render(scene, cam); labels.render(scene, cam); };
  const frame = (now: number) => {
    raf = 0;
    if (document.hidden) return;
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (tween) {
      const u = Math.min(1, (now - tween.start) / tween.dur), e = easeInOutCubic(u);
      persp.position.lerpVectors(tween.p0, tween.p1, e);
      lookTarget.lerpVectors(tween.t0, tween.t1, e);
      persp.fov = tween.f0 + (tween.f1 - tween.f0) * e; persp.updateProjectionMatrix();
      persp.lookAt(lookTarget);
      if (u >= 1) { const then = tween.then; controls.target.copy(tween.t1); tween = null; setModeInner(then, false); if (then === 'sensor') { persp.position.copy(sensorWorld); persp.lookAt(lookTarget); lookFrom(); } }
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
    } else if (mode === 'fly') {
      if (keys.size) {
        const sp = (keys.has('shift') || keysShift ? 36 : 11) * dt;
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
    if (dirty) { dirty = false; mmDirty = true; render(); }
    if (mmDirty && now - mmLast > 45) { mmDirty = false; mmLast = now; drawMinimap(); }
    raf = requestAnimationFrame(frame);
  };
  let keysShift = false;
  const shiftDown = (e: KeyboardEvent) => { keysShift = e.shiftKey; };
  window.addEventListener('keydown', shiftDown);
  window.addEventListener('keyup', shiftDown);
  const vis = () => { if (!document.hidden && !raf) { last = performance.now(); dirty = true; raf = requestAnimationFrame(frame); } };
  document.addEventListener('visibilitychange', vis);

  resize();
  applyLayers();
  update(tNow);
  setModeInner(o.mode === 'follow' ? 'orbit' : o.mode, false);
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
        // linked selection: bring the conflict point to the centre of the orbit, keeping the viewing angle
        if (f && focusPt && mode === 'orbit' && !replay && !tween) {
          const off = persp.position.clone().sub(controls.target);
          if (off.length() > 70) off.setLength(70);
          const t1 = W(focusPt.x, focusPt.y, 0);
          flyTo(t1.clone().add(off), t1, 'orbit', persp.fov, 700);
        }
      }
      update(tNow);
      if (changed && mode === 'follow' && !primary()) setModeInner('orbit');
    },
    setMode: (m) => { cancelReplay(); tween = null; setModeInner(m); },
    preset,
    setLayers: (l) => { layers = l; applyLayers(); update(tNow); },
    replay: replayGo,
    cancelReplay: () => { if (replay) { cancelReplay(); o.clock.pause(); setModeInner('orbit'); } },
    render,
    dispose: () => {
      cancelAnimationFrame(raf); ro.disconnect(); controls.dispose();
      controls.removeEventListener('change', onControls);
      cvs.removeEventListener('pointermove', onMove); cvs.removeEventListener('pointerleave', onLeave);
      cvs.removeEventListener('pointerdown', onDown); cvs.removeEventListener('pointerup', onUp); cvs.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey, true); window.removeEventListener('keyup', onKeyUp, true); window.removeEventListener('blur', onBlur);
      window.removeEventListener('keydown', shiftDown); window.removeEventListener('keyup', shiftDown);
      document.removeEventListener('visibilitychange', vis);
      el.removeEventListener('lab:render', onRenderReq); el.parentElement?.removeEventListener('lab:render', onRenderReq);
      o.minimap?.removeEventListener('click', onMiniClick);
      scene.traverse((ob: THREE.Object3D) => { const m = ob as THREE.Mesh; m.geometry?.dispose?.(); const mat = m.material as THREE.Material | THREE.Material[] | undefined; (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach((x) => x.dispose()); });
      edges.dispose(); poseTex.dispose(); Object.values(outlineMat).forEach((x) => x.dispose());
      renderer.forceContextLoss(); renderer.dispose();
      cvs.remove(); labels.domElement.remove();
    },
  };
}

export type { TrackT };
