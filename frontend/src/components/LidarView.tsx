import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { poseAt, useClockFrame, type ConflictT, type IntersectionT } from '../lib/traj';

interface Props { data: IntersectionT; conflicts: ConflictT[]; selected: string | null; label: string }

const SENSOR = new THREE.Vector3(-12, 12, 4.5); // pole-mounted roadside LiDAR at the SW corner, 4.5 m
const RANGE = 80;

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

export default function LidarView({ data, conflicts, selected, label }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<{ update: (t: number) => void } | null>(null);

  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0b0e11');
    scene.fog = new THREE.Fog('#0b0e11', 70, 150);
    const cam = new THREE.PerspectiveCamera(42, 1, 0.5, 400);
    cam.position.set(-48, 46, 62);
    const controls = new OrbitControls(cam, renderer.domElement);
    controls.target.set(0, 0, -15);
    controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.47; controls.minDistance = 20; controls.maxDistance = 160;

    // World mapping: data (x across, y along) → three (X = x, Z = -y), Y up.
    const W = (x: number, y: number, h = 0) => new THREE.Vector3(x, h, -y);

    // Ground returns: rings of points around the sensor, the signature of a spinning LiDAR.
    const g: number[] = [], gc: number[] = [];
    for (let ring = 0; ring < 64; ring++) {
      const elev = -0.28 + ring * 0.0042;
      const r = SENSOR.z / Math.tan(-elev);
      if (r > RANGE || r < 2) continue;
      const n = Math.round(r * 9);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const x = SENSOR.x + Math.cos(a) * r, y = SENSOR.y + Math.sin(a) * r;
        g.push(x, 0, -y);
        const inten = 0.18 + 0.25 * Math.exp(-r / 40);
        gc.push(inten * 0.7, inten * 0.85, inten);
      }
    }
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('position', new THREE.Float32BufferAttribute(g, 3));
    gg.setAttribute('color', new THREE.Float32BufferAttribute(gc, 3));
    scene.add(new THREE.Points(gg, new THREE.PointsMaterial({ size: 0.12, vertexColors: true, sizeAttenuation: true })));

    // Lane centrelines as faint painted lines
    const laneMat = new THREE.LineDashedMaterial({ color: '#3d4a55', dashSize: 1.5, gapSize: 2 });
    for (const l of data.lanes_geom) {
      const geo = new THREE.BufferGeometry().setFromPoints(l.centre.map(([x, y]) => W(x, y, 0.02)));
      const line = new THREE.Line(geo, laneMat); line.computeLineDistances(); scene.add(line);
    }

    // Sensor pole and field-of-view ring
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, SENSOR.z, 8), new THREE.MeshBasicMaterial({ color: '#5d6b77' }));
    pole.position.set(SENSOR.x, SENSOR.z / 2, -SENSOR.y); scene.add(pole);
    const head = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.4, 16), new THREE.MeshBasicMaterial({ color: '#d7dde2' }));
    head.position.set(SENSOR.x, SENSOR.z + 0.2, -SENSOR.y); scene.add(head);
    const fov = new THREE.Mesh(new THREE.RingGeometry(RANGE - 0.3, RANGE, 128), new THREE.MeshBasicMaterial({ color: '#2a333b', side: THREE.DoubleSide }));
    fov.rotation.x = -Math.PI / 2; fov.position.set(SENSOR.x, 0.01, -SENSOR.y); scene.add(fov);

    // One point cloud per road user (template geometry, placed per frame)
    const sensorWorld = new THREE.Vector3(SENSOR.x, SENSOR.z, -SENSOR.y);
    const clouds = new Map<string, THREE.Points>();
    const baseMat = (c: string) => new THREE.PointsMaterial({ size: 0.16, color: c, sizeAttenuation: true, transparent: true, opacity: 0.95 });
    const mats = { car: baseMat('#9fd4e8'), truck: baseMat('#e8d79f'), sel: baseMat('#ffb21a'), hot: baseMat('#ff5a4a') };
    for (const tr of data.tracks) {
      const h = tr.cls === 'truck' ? 3.2 : tr.cls === 'motorcycle' ? 1.3 : 1.5;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(vehicleCloud(tr.len_m, tr.w_m, h, tr.cls === 'truck' ? 1600 : 700), 3));
      const p = new THREE.Points(geo, tr.cls === 'truck' ? mats.truck : mats.car);
      p.visible = false; scene.add(p); clouds.set(String(tr.id), p);
    }

    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight;
      renderer.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize); ro.observe(el); resize();

    let selectedId: string | null = null;
    const update = (t: number) => {
      const hot = new Set(conflicts.filter((k) => Math.abs(k.t - t) < 0.9).flatMap((k) => [String(k.a), String(k.b)]));
      for (const tr of data.tracks) {
        const id = String(tr.id);
        const pts = clouds.get(id)!;
        const pose = poseAt(tr, t, data.hz);
        if (!pose) { pts.visible = false; continue; }
        const pos = W(pose.x, pose.y);
        pts.visible = pos.distanceTo(sensorWorld) < RANGE;
        pts.position.copy(pos);
        pts.rotation.y = pose.h;
        pts.material = id === selectedId ? mats.sel : hot.has(id) ? mats.hot : tr.cls === 'truck' ? mats.truck : mats.car;
      }
    };
    api.current = { update: (t) => update(t) };
    (api.current as any).select = (id: string | null) => { selectedId = id; };

    let raf = 0;
    const loop = () => { controls.update(); renderer.render(scene, cam); raf = requestAnimationFrame(loop); };
    loop();

    return () => {
      cancelAnimationFrame(raf); ro.disconnect(); controls.dispose();
      scene.traverse((o: any) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
      renderer.dispose(); el.removeChild(renderer.domElement);
    };
  }, [data, conflicts]);

  useEffect(() => { (api.current as any)?.select?.(selected); }, [selected]);
  useClockFrame((t) => api.current?.update(t), [data, conflicts]);

  return (
    <div ref={host} className="lidar" role="img" aria-label={label}>
      <div className="lidar-legend">
        <span><i style={{ background: '#9fd4e8' }} /> passenger car returns</span>
        <span><i style={{ background: '#e8d79f' }} /> heavy vehicle</span>
        <span><i style={{ background: '#ff5a4a' }} /> in conflict</span>
        <span className="muted">Simulated roadside LiDAR view (4.5 m pole, 80 m range) rendered from NGSIM tracks. Drag to orbit.</span>
      </div>
    </div>
  );
}
