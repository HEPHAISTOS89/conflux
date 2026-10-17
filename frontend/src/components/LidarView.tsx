import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { CHART, conflictColor } from '../lib/format';
import { reducedMotion } from '../lib/motion';
import { activeAt, MPS_TO_MPH, poseAt, useClock, useClockFrame, useSelection, type ConflictT, type IntersectionT } from '../lib/traj';

interface Props { data: IntersectionT; conflicts: ConflictT[]; label: string }

const SENSOR = new THREE.Vector3(-12, 12, 4.5); // pole-mounted roadside LiDAR at the SW corner, 4.5 m
const RANGE = 80;
const PICK_LAYER = 1;
const MAX_PAIRS = 64, MAX_TRAIL = 8 * 30, MAX_BOXES = 12;
type Preset = 'top' | 'sensor' | 'oblique' | 'follow';
const PRESETS: [Preset, string][] = [['top', 'Top'], ['sensor', 'Sensor POV'], ['oblique', 'Oblique'], ['follow', 'Follow selected']];

const heightOf = (cls: string) => (cls === 'truck' ? 3.2 : cls === 'motorcycle' ? 1.3 : 1.5);

/** Sample a vehicle's visible surface as a point cloud: only faces turned toward the sensor return. */
function vehicleCloud(len: number, wid: number, hgt: number, n = 900): Float32Array {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const f = Math.random();
    let x: number, y: number, z: number;
    if (f < 0.35) { x = (Math.random() - 0.5) * len; y = (Math.random() - 0.5) * wid; z = hgt; }
    else if (f < 0.7) { x = (Math.random() - 0.5) * len; y = Math.sign(Math.random() - 0.5) * wid / 2; z = Math.random() * hgt; }
    else { x = Math.sign(Math.random() - 0.5) * len / 2; y = (Math.random() - 0.5) * wid; z = Math.random() * hgt; }
    // roof taper
    if (z > hgt * 0.62) { x *= 0.7; }
    out.push(x, z, y);
  }
  return new Float32Array(out);
}

interface Api { update: (t: number) => void; setSel: (sel: Set<string>, hov: string | null) => void; preset: (p: Preset) => void }

export default function LidarView({ data, conflicts, label }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<Api | null>(null);
  const clock = useClock();
  const sel = useSelection();
  const selRef = useRef(sel);
  selRef.current = sel;
  const [preset, setPreset] = useState<Preset>('oblique');
  const primary = sel ? [...sel.selected][0] ?? null : null;

  // Palette from CHART (swapped per theme; the page remounts on a theme change).
  const PT = { car: CHART.sb, truck: CHART.eb, sel: CHART.accent, hov: CHART.ink, hot: CHART.critical, partner: CHART.caution };

  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    el.appendChild(renderer.domElement);
    const labels = new CSS2DRenderer();
    labels.domElement.className = 'lidar-labels';
    el.appendChild(labels.domElement);

    const bg = new THREE.Color(CHART.ground);
    const scene = new THREE.Scene();
    scene.background = bg;
    scene.fog = new THREE.Fog(bg, 90, 190);
    const cam = new THREE.PerspectiveCamera(42, 1, 0.5, 400);
    const controls = new OrbitControls(cam, renderer.domElement);
    controls.cursorStyle = 'grab'; controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.47; controls.minDistance = 8; controls.maxDistance = 200;

    // World mapping: data (x across, y along) → three (X = x, Z = -y), Y up.
    const W = (x: number, y: number, h = 0) => new THREE.Vector3(x, h, -y);
    const [[bx0, by0], [bx1, by1]] = data.bbox as [[number, number], [number, number]];
    const mid = W((bx0 + bx1) / 2, (by0 + by1) / 2);

    // Ground returns: rings of points around the sensor, the signature of a spinning LiDAR. Intensity blends ground → axis ink.
    const g: number[] = [], gc: number[] = [];
    const ink = new THREE.Color(CHART.axis), tmp = new THREE.Color();
    for (let ring = 0; ring < 64; ring++) {
      const elev = -0.28 + ring * 0.0042;
      const r = SENSOR.z / Math.tan(-elev);
      if (r > RANGE || r < 2) continue;
      const n = Math.round(r * 9);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const x = SENSOR.x + Math.cos(a) * r, y = SENSOR.y + Math.sin(a) * r;
        g.push(x, 0, -y);
        tmp.copy(bg).lerp(ink, 0.35 + 0.5 * Math.exp(-r / 35));
        gc.push(tmp.r, tmp.g, tmp.b);
      }
    }
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.Float32BufferAttribute(g, 3));
    gg.setAttribute('color', new THREE.Float32BufferAttribute(gc, 3));
    scene.add(new THREE.Points(gg, new THREE.PointsMaterial({ size: 0.12, vertexColors: true, sizeAttenuation: true })));

    // Lane centrelines as faint painted lines
    const laneMat = new THREE.LineDashedMaterial({ color: CHART.rule, dashSize: 1.5, gapSize: 2 });
    for (const l of data.lanes_geom) {
      const geo = new THREE.BufferGeometry().setFromPoints(l.centre.map(([x, y]) => W(x, y, 0.02)));
      const line = new THREE.Line(geo, laneMat); line.computeLineDistances(); scene.add(line);
    }

    // Sensor pole and field-of-view ring
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, SENSOR.z, 8), new THREE.MeshBasicMaterial({ color: CHART.axis }));
    pole.position.set(SENSOR.x, SENSOR.z / 2, -SENSOR.y); scene.add(pole);
    const head = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.4, 16), new THREE.MeshBasicMaterial({ color: CHART.ink2 }));
    head.position.set(SENSOR.x, SENSOR.z + 0.2, -SENSOR.y); scene.add(head);
    const fov = new THREE.Mesh(new THREE.RingGeometry(RANGE - 0.3, RANGE, 128), new THREE.MeshBasicMaterial({ color: CHART.rule, side: THREE.DoubleSide }));
    fov.rotation.x = -Math.PI / 2; fov.position.set(SENSOR.x, 0.01, -SENSOR.y); scene.add(fov);

    // One point cloud per road user (template geometry, placed per frame)
    const sensorWorld = new THREE.Vector3(SENSOR.x, SENSOR.z, -SENSOR.y);
    const clouds = new Map<string, THREE.Points>();
    const mat = (c: string, size = 0.2) => new THREE.PointsMaterial({ size, color: c, sizeAttenuation: true, transparent: true, opacity: 0.95 });
    const mats = { car: mat(PT.car), truck: mat(PT.truck), sel: mat(PT.sel, 0.26), hov: mat(PT.hov, 0.24), hot: mat(PT.hot), partner: mat(PT.partner, 0.24) };
    const ids = data.tracks.map((tr) => String(tr.id));
    for (const tr of data.tracks) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(vehicleCloud(tr.len_m, tr.w_m, heightOf(tr.cls), tr.cls === 'truck' ? 1600 : 700), 3));
      const p = new THREE.Points(geo, tr.cls === 'truck' ? mats.truck : mats.car);
      p.visible = false; scene.add(p); clouds.set(String(tr.id), p);
    }

    // Picking: one invisible box per track on a layer the camera never renders; the clouds stay purely visual.
    const pick = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), data.tracks.length);
    pick.layers.set(PICK_LAYER);
    pick.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(pick);
    const ray = new THREE.Raycaster();
    ray.layers.set(PICK_LAYER);

    // Selection outlines (accent for selected, amber for their conflict partners)
    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    const outlineMat = { sel: new THREE.LineBasicMaterial({ color: PT.sel }), partner: new THREE.LineBasicMaterial({ color: PT.partner }) };
    const boxes = Array.from({ length: MAX_BOXES }, () => { const b = new THREE.LineSegments(edges, outlineMat.sel); b.visible = false; scene.add(b); return b; });

    // Dashed links between conflict pairs active at t
    const pairGeo = new THREE.BufferGeometry();
    pairGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_PAIRS * 6), 3).setUsage(THREE.DynamicDrawUsage));
    pairGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_PAIRS * 6), 3).setUsage(THREE.DynamicDrawUsage));
    const pairs = new THREE.LineSegments(pairGeo, new THREE.LineDashedMaterial({ vertexColors: true, dashSize: 0.8, gapSize: 0.6 }));
    pairs.frustumCulled = false; scene.add(pairs);

    // Trails: last 3 s of each selected road user
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_TRAIL * 6), 3).setUsage(THREE.DynamicDrawUsage));
    const trails = new THREE.LineSegments(trailGeo, new THREE.LineBasicMaterial({ color: PT.sel }));
    trails.frustumCulled = false; scene.add(trails);

    // Labels (hovered and selected only)
    const tags = new Map<string, CSS2DObject>();
    const tagFor = (id: string) => {
      let o = tags.get(id);
      if (!o) { const d = document.createElement('div'); d.className = 'lidar-tag'; o = new CSS2DObject(d); scene.add(o); tags.set(id, o); }
      return o;
    };

    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight;
      renderer.setSize(w, h, false); labels.setSize(w, h); cam.aspect = w / h; cam.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize); ro.observe(el); resize();

    let selIds = new Set<string>(), hovId: string | null = null, partnerIds = new Set<string>();
    let tNow = clock.now();
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const posOf = new Map<string, THREE.Vector3>();

    const update = (t: number) => {
      tNow = t;
      const act = activeAt(conflicts, t);
      const hot = new Set(act.flatMap((k) => [String(k.a), String(k.b)]));
      posOf.clear();
      let nb = 0;
      data.tracks.forEach((tr, i) => {
        const id = ids[i];
        const pts = clouds.get(id)!;
        const pose = poseAt(tr, t, data.hz);
        const pos = pose && W(pose.x, pose.y);
        const vis = !!pos && pos.distanceTo(sensorWorld) < RANGE;
        pts.visible = vis;
        if (!vis || !pose || !pos) { m4.makeScale(0, 0, 0); pick.setMatrixAt(i, m4); tags.get(id) && (tags.get(id)!.visible = false); return; }
        posOf.set(id, pos);
        pts.position.copy(pos);
        pts.rotation.y = pose.h;
        const isSel = selIds.has(id), isPartner = partnerIds.has(id);
        pts.material = isSel ? mats.sel : id === hovId ? mats.hov : isPartner ? mats.partner : hot.has(id) ? mats.hot : tr.cls === 'truck' ? mats.truck : mats.car;
        const h = heightOf(tr.cls);
        q.setFromAxisAngle(up, pose.h);
        m4.compose(sc.set(pos.x, h / 2, pos.z), q, new THREE.Vector3(tr.len_m + 0.6, h + 0.4, tr.w_m + 0.6));
        pick.setMatrixAt(i, m4);
        if ((isSel || isPartner) && nb < MAX_BOXES) {
          const b = boxes[nb++];
          b.visible = true; b.material = isSel ? outlineMat.sel : outlineMat.partner;
          b.position.set(pos.x, h / 2, pos.z); b.rotation.set(0, pose.h, 0); b.scale.set(tr.len_m + 0.4, h + 0.3, tr.w_m + 0.4);
        }
        if (isSel || id === hovId) {
          const tag = tagFor(id);
          tag.visible = true; tag.position.set(pos.x, h + 1.2, pos.z);
          tag.element.textContent = `#${id} · ${tr.cls} · ${(pose.v * MPS_TO_MPH).toFixed(1)} mph`;
          tag.element.dataset.sel = isSel ? '1' : '';
        } else if (tags.has(id)) tags.get(id)!.visible = false;
      });
      for (let i = nb; i < MAX_BOXES; i++) boxes[i].visible = false;
      pick.instanceMatrix.needsUpdate = true;
      pick.boundingSphere = null; pick.boundingBox = null;

      // conflict links
      const pp = pairGeo.attributes.position as THREE.BufferAttribute, pc = pairGeo.attributes.color as THREE.BufferAttribute;
      let np = 0;
      for (const k of act) {
        const a = posOf.get(String(k.a)), b = posOf.get(String(k.b));
        if (!a || !b || np >= MAX_PAIRS) continue;
        const c = tmp.set(conflictColor(k.severity));
        pp.setXYZ(np * 2, a.x, 1, a.z); pp.setXYZ(np * 2 + 1, b.x, 1, b.z);
        pc.setXYZ(np * 2, c.r, c.g, c.b); pc.setXYZ(np * 2 + 1, c.r, c.g, c.b);
        np++;
      }
      pairGeo.setDrawRange(0, np * 2); pp.needsUpdate = true; pc.needsUpdate = true;
      pairs.computeLineDistances();

      // trails
      const tp = trailGeo.attributes.position as THREE.BufferAttribute;
      let nt = 0;
      for (const id of selIds) {
        const tr = data.tracks[ids.indexOf(id)];
        if (!tr) continue;
        const i1 = Math.min(tr.pts.length - 1, Math.round((t - tr.pts[0][0]) * data.hz)), i0 = Math.max(0, i1 - 30);
        if (i1 < 1) continue;
        for (let i = i0 + 1; i <= i1 && nt < MAX_TRAIL; i++) {
          const a = tr.pts[i - 1], b = tr.pts[i];
          tp.setXYZ(nt * 2, a[1], 0.15, -a[2]); tp.setXYZ(nt * 2 + 1, b[1], 0.15, -b[2]); nt++;
        }
      }
      trailGeo.setDrawRange(0, nt * 2); tp.needsUpdate = true;
    };

    // Camera presets with a short ease-out tween (reduced motion: jump)
    let mode: Preset = 'oblique';
    let tween: { p0: THREE.Vector3; t0: THREE.Vector3; p1: THREE.Vector3; t1: THREE.Vector3; start: number } | null = null;
    const followOffset = new THREE.Vector3(-22, 20, 22);
    const goal = (p: Preset): [THREE.Vector3, THREE.Vector3] | null => {
      if (p === 'top') return [mid.clone().add(new THREE.Vector3(0.1, 125, 0)), mid.clone()];
      if (p === 'sensor') return [new THREE.Vector3(SENSOR.x + 0.6, SENSOR.z + 0.7, -SENSOR.y), new THREE.Vector3(12, 0, -28)];
      if (p === 'oblique') return [new THREE.Vector3(-38, 34, 44), new THREE.Vector3(0, 0, -15)];
      const at = followed();
      return at ? [at.clone().add(followOffset), at.clone()] : null;
    };
    /** First selected road user currently in the scene. */
    const followed = () => { for (const id of selIds) { const at = posOf.get(id); if (at) return at; } return null; };
    let locked = false;
    const flyTo = (p: Preset) => {
      const gl = goal(p);
      mode = p; locked = !!gl;
      if (!gl) return;
      if (reducedMotion()) { cam.position.copy(gl[0]); controls.target.copy(gl[1]); tween = null; return; }
      tween = { p0: cam.position.clone(), t0: controls.target.clone(), p1: gl[0], t1: gl[1], start: performance.now() };
    };
    { const gl = goal('oblique')!; cam.position.copy(gl[0]); controls.target.copy(gl[1]); }

    // Pointer: hover by raycast in the render loop, click (no drag) selects
    const ndc = new THREE.Vector2();
    let pointerIn = false, dirty = false, downAt: [number, number] | null = null;
    const toNdc = (e: PointerEvent) => { const r = renderer.domElement.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); };
    const hitId = () => {
      ray.setFromCamera(ndc, cam);
      const h = ray.intersectObject(pick, false)[0];
      return h?.instanceId != null ? ids[h.instanceId] : null;
    };
    const onMove = (e: PointerEvent) => { if (e.pointerType !== 'mouse' || e.buttons) return; toNdc(e); pointerIn = true; dirty = true; };
    const onLeave = () => { pointerIn = false; if (selRef.current?.hovered) selRef.current.hover(null); };
    const onDown = (e: PointerEvent) => { downAt = [e.clientX, e.clientY]; };
    const onUp = (e: PointerEvent) => {
      if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) { downAt = null; return; }
      downAt = null;
      toNdc(e);
      const id = hitId(), s = selRef.current;
      if (!s) return;
      if (id) s.select([id], { add: e.shiftKey || e.metaKey });
      else if (!e.shiftKey) s.select(null);
    };
    const cvs = renderer.domElement;
    cvs.addEventListener('pointermove', onMove);
    cvs.addEventListener('pointerleave', onLeave);
    cvs.addEventListener('pointerdown', onDown);
    cvs.addEventListener('pointerup', onUp);

    api.current = {
      update,
      setSel: (s, h) => {
        const changed = s !== selIds;
        selIds = s; hovId = h; partnerIds = new Set();
        for (const k of conflicts) {
          const a = String(k.a), b = String(k.b);
          if (s.has(a) && !s.has(b)) partnerIds.add(b);
          if (s.has(b) && !s.has(a)) partnerIds.add(a);
        }
        update(tNow);
        if (mode === 'follow' && changed) flyTo('follow');
      },
      preset: flyTo,
    };

    let raf = 0;
    const last = new THREE.Vector3();
    const loop = () => {
      if (tween) {
        const u = Math.min(1, (performance.now() - tween.start) / 450), e = 1 - Math.pow(1 - u, 3);
        cam.position.lerpVectors(tween.p0, tween.p1, e); controls.target.lerpVectors(tween.t0, tween.t1, e);
        if (u >= 1) tween = null;
      } else if (mode === 'follow') {
        const at = followed();
        if (!locked) flyTo('follow');
        else if (at) { last.subVectors(at, controls.target); cam.position.add(last); controls.target.copy(at); }
      }
      controls.update();
      if (dirty && pointerIn) {
        dirty = false;
        const id = hitId(), s = selRef.current;
        cvs.style.cursor = id ? 'pointer' : 'grab';
        if (s && id !== s.hovered) s.hover(id);
      }
      renderer.render(scene, cam);
      labels.render(scene, cam);
      raf = requestAnimationFrame(loop);
    };
    loop();

    return () => {
      cancelAnimationFrame(raf); ro.disconnect(); controls.dispose();
      cvs.removeEventListener('pointermove', onMove); cvs.removeEventListener('pointerleave', onLeave);
      cvs.removeEventListener('pointerdown', onDown); cvs.removeEventListener('pointerup', onUp);
      scene.traverse((o: any) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
      Object.values(mats).forEach((m) => m.dispose()); Object.values(outlineMat).forEach((m) => m.dispose()); laneMat.dispose(); edges.dispose();
      renderer.forceContextLoss(); renderer.dispose(); el.removeChild(cvs); el.removeChild(labels.domElement);
      api.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, conflicts]);

  useEffect(() => { api.current?.setSel(sel?.selected ?? new Set(), sel?.hovered ?? null); }, [sel?.selected, sel?.hovered, data, conflicts]);
  useEffect(() => { if (preset === 'follow' && !primary) { setPreset('oblique'); api.current?.preset('oblique'); } }, [preset, primary]);
  useClockFrame((t) => api.current?.update(t), [data, conflicts]);

  return (
    <div ref={host} className="lidar" role="img" aria-label={label}>
      <div className="seg lidar-cams" role="group" aria-label="Camera">
        {PRESETS.map(([p, name]) => (
          <button key={p} aria-pressed={preset === p} disabled={p === 'follow' && !primary} onClick={() => { setPreset(p); api.current?.preset(p); }}
            title={p === 'follow' && !primary ? 'Select a vehicle to follow it' : undefined}>{name}</button>
        ))}
      </div>
      <div className="lidar-legend">
        <span><i style={{ background: PT.car }} /> passenger car</span>
        <span><i style={{ background: PT.truck }} /> heavy vehicle</span>
        <span><i style={{ background: PT.hot }} /> in conflict now</span>
        <span><i style={{ background: PT.sel }} /> selected</span>
        <span><i style={{ background: PT.partner }} /> conflict partner</span>
        <span className="muted">Simulated from NGSIM tracks · 4.5 m pole · 80 m range · drag to orbit, click a vehicle to select</span>
      </div>
    </div>
  );
}
