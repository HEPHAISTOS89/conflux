/**
 * Vehicle models shared by the landing world and the intersection lab. Bodies are extruded side profiles
 * (metres tall, unit long, unit wide, so one geometry per class serves every track at its true length and
 * width through the instance matrix), with a glazed greenhouse, roof, four wheels that roll with the track's
 * travelled distance and steer with its yaw rate, and head/tail lamp blocks. Nothing here touches the DOM.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { TrackT } from '../traj';

export type VehicleKind = 'sedan' | 'suv' | 'pickup' | 'truck' | 'ped';
export const KINDS: VehicleKind[] = ['sedan', 'suv', 'pickup', 'truck', 'ped'];

/** Class from the NGSIM vehicle class and length: cars below 5.0 m read as sedans, 5.0–5.6 as SUVs, longer cars as pickups. */
export function kindOf(tr: TrackT): VehicleKind {
  if (tr.cls === 'pedestrian') return 'ped';
  if (tr.cls === 'truck' || tr.cls === 'bus' || tr.len_m > 7) return 'truck';
  if (tr.len_m > 5.6) return 'pickup';
  if (tr.len_m > 5.0) return 'suv';
  return 'sedan';
}

export const WHEEL = { r: 0.33, w: 0.22 } as const;

interface Profile { body: [number, number][]; cabin: [number, number][] | null; roofY: number | null; cabinX: [number, number]; nominalLen: number; height: number; glassInset: number; beltY: number; lampY: [number, number] }

/** Side profiles in metres for a nominal length; x from the rear bumper (negative) to the front (positive), y up. */
const PROFILES: Record<Exclude<VehicleKind, 'ped'>, Profile> = {
  sedan: {
    nominalLen: 4.8, height: 1.42, glassInset: 0.06, beltY: 0.88, lampY: [0.74, 0.8],
    body: [[-2.4, 0.3], [-2.4, 0.74], [-2.3, 0.86], [-1.5, 0.9], [-0.9, 0.9], [1.05, 0.86], [2.1, 0.78], [2.4, 0.66], [2.4, 0.3], [2.15, 0.22], [-2.15, 0.22]],
    cabin: [[-1.55, 0.9], [-0.95, 1.36], [0.35, 1.42], [1.08, 0.9]],
    roofY: 1.42, cabinX: [-0.95, 0.35],
  },
  suv: {
    nominalLen: 5.2, height: 1.78, glassInset: 0.06, beltY: 1.02, lampY: [0.86, 0.95],
    body: [[-2.6, 0.34], [-2.6, 0.95], [-2.5, 1.04], [-0.9, 1.04], [1.3, 1.0], [2.45, 0.9], [2.6, 0.74], [2.6, 0.34], [2.3, 0.24], [-2.3, 0.24]],
    cabin: [[-2.5, 1.04], [-2.3, 1.72], [0.55, 1.78], [1.3, 1.04]],
    roofY: 1.78, cabinX: [-2.3, 0.55],
  },
  pickup: {
    nominalLen: 5.9, height: 1.86, glassInset: 0.06, beltY: 1.05, lampY: [0.9, 1.0],
    body: [[-2.95, 0.36], [-2.95, 1.3], [-0.6, 1.3], [-0.6, 1.08], [1.5, 1.06], [2.75, 0.95], [2.95, 0.78], [2.95, 0.36], [2.6, 0.25], [-2.6, 0.25]],
    cabin: [[-0.6, 1.08], [-0.45, 1.8], [0.9, 1.86], [1.5, 1.08]],
    roofY: 1.86, cabinX: [-0.45, 0.9],
  },
  truck: {
    nominalLen: 9.0, height: 3.4, glassInset: 0.05, beltY: 1.5, lampY: [0.9, 1.2],
    body: [[-4.5, 0.45], [-4.5, 3.4], [-0.9, 3.4], [-0.9, 1.0], [0.9, 1.0], [0.9, 2.2], [1.05, 2.9], [3.2, 2.95], [4.5, 2.5], [4.5, 0.45], [4.2, 0.3], [-4.2, 0.3]],
    cabin: [[1.05, 2.9], [3.2, 2.95], [4.5, 2.5], [4.5, 1.6], [1.05, 1.6]],
    roofY: null, cabinX: [1.05, 4.5],
  },
};

const ex = (pts: [number, number][], depth: number, bevel: number): THREE.BufferGeometry => {
  const s = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 2, steps: 1 });
  g.translate(0, 0, -depth / 2);
  return g;
};

export interface VehicleGeometry { body: THREE.BufferGeometry; glass: THREE.BufferGeometry; wheelX: [number, number] }

/** Body (painted parts) and glass for a class, normalised to unit length and unit width; heights in metres. */
export function vehicleGeometry(kind: Exclude<VehicleKind, 'ped'>): VehicleGeometry {
  const p = PROFILES[kind];
  const L = p.nominalLen;
  const bodyParts = [ex(p.body, 1, 0.07)];
  // wheel arches: dark wells are skipped; wheels sit proud of the body underside instead
  if (p.roofY != null && p.cabin) {
    // roof slab in body colour over the greenhouse, pillars implied by the glass inset
    const [x0, x1] = p.cabinX;
    bodyParts.push(new THREE.BoxGeometry(x1 - x0 + 0.1, 0.06, 0.9).translate((x0 + x1) / 2, p.roofY - 0.03, 0));
  }
  const body = mergeGeometries(bodyParts.map((g) => (g.index ? g.toNonIndexed() : g)))!;
  bodyParts.forEach((g) => g.dispose());
  const glass = p.cabin ? ex(p.cabin, 1 - p.glassInset * 2, 0.02) : new THREE.BufferGeometry();
  // normalise x to unit length; z is already unit width
  body.scale(1 / L, 1, 1); glass.scale(1 / L, 1, 1);
  body.computeVertexNormals(); glass.computeVertexNormals();
  const wheelX: [number, number] = kind === 'truck' ? [-0.36, 0.34] : [-0.31, 0.32];
  return { body, glass, wheelX };
}

/** A wheel: tyre + hub, axis along z, vertex-coloured (tyre dark, hub light) so one instanced material serves all. */
export function wheelGeometry(): THREE.BufferGeometry {
  const tyre = new THREE.CylinderGeometry(WHEEL.r, WHEEL.r, WHEEL.w, 18, 1);
  const hub = new THREE.CylinderGeometry(WHEEL.r * 0.58, WHEEL.r * 0.58, WHEEL.w + 0.02, 12, 1);
  const paint = (g: THREE.BufferGeometry, c: THREE.Color) => {
    const n = g.attributes.position.count, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  };
  paint(tyre, new THREE.Color('#121312')); paint(hub, new THREE.Color('#8e918f'));
  const g = mergeGeometries([(tyre.index ? tyre.toNonIndexed() : tyre), (hub.index ? hub.toNonIndexed() : hub)])!;
  g.rotateX(Math.PI / 2); // cylinder axis y → z (across the vehicle)
  tyre.dispose(); hub.dispose();
  return g;
}

/** Lamp blocks at the ends of a unit body: x = ±0.5, at the class's lamp height, 0.14 in from each side. */
export function lampGeometry(front: boolean, kind: Exclude<VehicleKind, 'ped'>): THREE.BufferGeometry {
  const p = PROFILES[kind], y = front ? p.lampY[0] : p.lampY[1];
  const x = front ? 0.5 : -0.5, w = kind === 'truck' ? 0.14 : 0.2;
  return mergeGeometries([new THREE.BoxGeometry(0.03, 0.1, w).translate(x, y, 0.5 - 0.16), new THREE.BoxGeometry(0.03, 0.1, w).translate(x, y, -(0.5 - 0.16))])!;
}

/** Cumulative travelled distance per sample (m), for wheel rotation. */
export function cumulativeDistance(tr: TrackT): Float32Array {
  const p = tr.pts, out = new Float32Array(p.length);
  for (let i = 1; i < p.length; i++) out[i] = out[i - 1] + Math.hypot(p[i][1] - p[i - 1][1], p[i][2] - p[i - 1][2]);
  return out;
}

/** Travelled distance at t, interpolated between samples. */
export function distanceAt(tr: TrackT, cum: Float32Array, t: number, hz = 10): number {
  const p = tr.pts;
  if (!p.length) return 0;
  const f = Math.max(0, (t - p[0][0]) * hz), i = Math.min(p.length - 1, Math.floor(f)), j = Math.min(p.length - 1, i + 1), u = j === i ? 0 : Math.min(1, f - i);
  return cum[i] + (cum[j] - cum[i]) * u;
}

/**
 * Front-wheel steer angle (rad) from the yaw rate and speed through the bicycle model, δ = atan(ω · L / v),
 * with L the wheelbase; zero below 0.5 m/s (no meaningful heading), clamped to ±35°.
 */
export function steerAngle(headingRate: number, v: number, wheelbase: number): number {
  if (v < 0.5) return 0;
  return Math.max(-0.61, Math.min(0.61, Math.atan((headingRate * wheelbase) / v)));
}

/** Wheel positions: [fraction of length along the body, metres across] for front-right, front-left, rear-right, rear-left. */
export function wheelOffsets(wheelX: [number, number], widthM: number): [number, number][] {
  const z = widthM / 2 - WHEEL.w / 2 - 0.02;
  return [[wheelX[1], z], [wheelX[1], -z], [wheelX[0], z], [wheelX[0], -z]];
}

/** Pedestrian body in metres (not scaled by the instance like vehicles): a 1.7 m capsule torso with a head. */
export function pedestrianGeometry(): THREE.BufferGeometry {
  const torso = new THREE.CapsuleGeometry(0.19, 0.95, 3, 10).translate(0, 0.78, 0);
  const head = new THREE.SphereGeometry(0.11, 10, 8).translate(0, 1.58, 0);
  const g = mergeGeometries([torso, head], false)!;
  g.computeVertexNormals();
  return g;
}
