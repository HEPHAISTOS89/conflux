/**
 * Street geometry shared by the landing world and the intersection lab: carriageway (corridor arms, the
 * intersection box and the cross street derived in road.ts), MUTCD markings as true-width ribbons, kerb
 * lines that stop at the cross street, stylised crosswalks, and signal masts with their lamp positions.
 * Everything is built once into a few BufferGeometries; the caller picks materials and heights.
 *
 * Data frame: x across the corridor, y along it (north). Three frame: X = x, Z = −y, Y up.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { bandEdgeY, bandLines, bandPoint, bandPolygon, dashes, MUTCD, offset, ribbon, type RoadGeom, type XY } from './road';

export interface Far { s: number; n: number; w: number; e: number }
export interface StreetColours { lane: string; edge: string; centre: string; stop: string; crosswalk: string }
export interface StreetOpts {
  /** How far the arms and the cross street continue beyond the study area (data m). */
  far: Far;
  colours: StreetColours;
  /** Draw stylised continental crosswalks (not observable in NGSIM). */
  crosswalks: boolean;
  /** Height of markings above the asphalt. */
  markH?: number;
  /** Line width multiplier for the markings (1 = MUTCD 4 in; a touch wider reads better from a distance). */
  lineScale?: number;
}
export interface Street {
  asphalt: THREE.BufferGeometry | null;
  /** Vertex-coloured triangles: lane lines, edges, centre lines, stop bars, crosswalks. */
  markings: THREE.BufferGeometry;
  kerbs: THREE.BufferGeometry;
  /** 3 m concrete strips outside every kerb (stylised context). */
  sidewalks: THREE.BufferGeometry | null;
  /** Lateral extent of the corridor pavement at the box, and the cross street's edge y at the corridor centre. */
  ext: { xWest: number; xEast: number; ySouth: number; yNorth: number; xMid: number; yMid: number };
  /** Crosswalk rectangles (data frame), for the plan view. */
  crosswalks: XY[][];
  /** Stylised cross-street stop bars (EB from the west, WB from the east). */
  crossStops: { dir: 'EB' | 'WB'; a: XY; b: XY }[];
}

const flat = (g: THREE.BufferGeometry) => { g.rotateX(-Math.PI / 2); return g; };
const shape = (pts: XY[]) => flat(new THREE.ShapeGeometry(new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)))));

/** Signed crossing of y = f(x) with a polyline, used to trim corridor edges at the cross street. */
function trimEdgeAt(edge: XY[], yStop: number, fromSouth: boolean): XY[] {
  // the arm's edge polyline ends at the box; extend or cut it so it meets the cross street's edge
  const pts = fromSouth ? edge : [...edge].reverse(); // runs toward the box
  const out: XY[] = [];
  for (const p of pts) { if (fromSouth ? p[1] > yStop : p[1] < yStop) break; out.push(p); }
  const last = out[out.length - 1] ?? pts[0];
  out.push([last[0], yStop]);
  return fromSouth ? out : out.reverse();
}

export function buildStreet(road: RoadGeom, bbox: [[number, number], [number, number]], o: StreetOpts): Street {
  const [[, by0], [, by1]] = bbox;
  const { far } = o;
  const band = road.crossBand;
  const asphaltGeos: THREE.BufferGeometry[] = [];
  const quad = (x0: number, y0: number, x1: number, y1: number) => asphaltGeos.push(shape([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]));

  // corridor arms, continued straight beyond the study area with their end cross-section
  let xL = Infinity, xR = -Infinity;
  road.arms.forEach((a) => asphaltGeos.push(shape(a)));
  for (const a of road.arms) {
    const n = a.length / 2;
    const ySouth = a[0][1], yNorth = a[n - 1][1];
    for (const p of a) { xL = Math.min(xL, p[0]); xR = Math.max(xR, p[0]); }
    if (ySouth <= by0 + 3) quad(a[0][0], far.s, a[a.length - 1][0], ySouth + 0.5);
    if (yNorth >= by1 - 3) quad(a[n - 1][0], yNorth - 0.5, a[n][0], far.n);
  }
  const cross = road.cross;
  const xWest = Math.min(xL, cross?.x0 ?? xL), xEast = Math.max(xR, cross?.x1 ?? xR), xMid = (xWest + xEast) / 2;
  // the box itself: corridor pavement between the two arms, plus the cross street as a band (or a plain box without EB/WB data)
  let ySouth = cross?.y0 ?? -10, yNorth = cross?.y1 ?? 10;
  if (cross) quad(cross.x0, cross.y0 - 0.5, cross.x1, cross.y1 + 0.5);
  if (band) {
    ySouth = bandEdgeY(band, xMid, 0); yNorth = bandEdgeY(band, xMid, 1);
    asphaltGeos.push(shape(bandPolygon(band, far.w, far.e)));
  } else if (cross) {
    quad(far.w, cross.y0, cross.x0 + 0.5, cross.y1);
    quad(cross.x1 - 0.5, cross.y0, far.e, cross.y1);
  }
  const asphalt = asphaltGeos.length ? mergeGeometries(asphaltGeos.map((g) => (g.index ? g.toNonIndexed() : g))) : null;
  asphaltGeos.forEach((g) => g.dispose());

  /* ---------- markings ---------- */
  const mp: number[] = [], mc: number[] = [];
  const H = o.markH ?? 0.012, w = MUTCD.line * (o.lineScale ?? 1.5);
  const add = (tri: number[], hex: string, h = H) => { const c = new THREE.Color(hex); for (let i = 0; i < tri.length; i += 2) { mp.push(tri[i], h, -tri[i + 1]); mc.push(c.r, c.g, c.b); } };
  const draw = (kind: string, pts: XY[]) => {
    if (pts.length < 2) return;
    if (kind === 'lane') for (const d of dashes(pts)) add(ribbon(d, w), o.colours.lane);
    else if (kind === 'edge') add(ribbon(pts, w), o.colours.edge);
    else { const d = (MUTCD.line + MUTCD.yellowGap) / 2; add(ribbon(offset(pts, -d), w), o.colours.centre); add(ribbon(offset(pts, d), w), o.colours.centre); }
  };
  for (const l of road.lines) {
    draw(l.kind, l.pts);
    const first = l.pts[0], last = l.pts[l.pts.length - 1];
    if (first[1] <= by0 + 3) draw(l.kind, [[first[0], far.s], first]);
    if (last[1] >= by1 - 3) draw(l.kind, [last, [last[0], far.n]]);
  }
  for (const b of road.stops) add(ribbon([b.a, b.b], MUTCD.bar), o.colours.stop, H + 0.002);
  const crossStops: Street['crossStops'] = [];
  const crosswalks: XY[][] = [];
  if (band) {
    // cross-street markings stop at the corridor pavement (no lines inside the box)
    for (const l of bandLines(band, far.w, xWest - 0.6)) draw(l.kind, l.pts);
    for (const l of bandLines(band, xEast + 0.6, far.e)) draw(l.kind, l.pts);
    // stylised stop bars for the cross street: 2 m before the corridor edge, on the approach half (EB south of the centre line)
    const bar = (dir: 'EB' | 'WB') => {
      const x = dir === 'EB' ? xWest - 4.2 : xEast + 4.2;
      const a = bandPoint(band, x, dir === 'EB' ? band.edges[0] + 0.3 : band.centre), b = bandPoint(band, x, dir === 'EB' ? band.centre : band.edges[1] - 0.3);
      crossStops.push({ dir, a, b });
      add(ribbon([a, b], MUTCD.bar), o.colours.stop, H + 0.002);
    };
    bar('EB'); bar('WB');
  } else if (cross) {
    const yCm = (cross.y0 + cross.y1) / 2, half = (cross.y1 - cross.y0) / 2;
    for (const [xa, xb] of [[far.w, cross.x0 - 1], [cross.x1 + 1, far.e]]) {
      draw('centre', [[xa, yCm], [xb, yCm]]);
      draw('edge', [[xa, cross.y0 + 0.5], [xb, cross.y0 + 0.5]]); draw('edge', [[xa, cross.y1 - 0.5], [xb, cross.y1 - 0.5]]);
      if (half > 6.5) { draw('lane', [[xa, yCm - half / 2], [xb, yCm - half / 2]]); draw('lane', [[xa, yCm + half / 2], [xb, yCm + half / 2]]); }
    }
  }
  if (o.crosswalks) {
    // continental crosswalks (MUTCD 3B.18: 2 ft bars, 2 ft gaps, ≥ 6 ft wide; 10 ft drawn): corridor crossings just inside the box edge
    // behind each stop bar, cross-street crossings just outside the corridor pavement
    const BAR = 0.61, GAP = 0.61, WIDTH = 3.05;
    const ladder = (p0: XY, p1: XY, inward: XY) => {
      // bars perpendicular to the crossing direction p0→p1, laid from p0 to p1; `inward` is the unit crossing-width direction
      const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), ux = (p1[0] - p0[0]) / L, uy = (p1[1] - p0[1]) / L;
      const poly: XY[] = [p0, p1, [p1[0] + inward[0] * WIDTH, p1[1] + inward[1] * WIDTH], [p0[0] + inward[0] * WIDTH, p0[1] + inward[1] * WIDTH]];
      crosswalks.push(poly);
      for (let s = GAP; s + BAR <= L - GAP + 1e-6; s += BAR + GAP) {
        const a: XY = [p0[0] + ux * (s + BAR / 2), p0[1] + uy * (s + BAR / 2)];
        const b: XY = [a[0] + inward[0] * WIDTH, a[1] + inward[1] * WIDTH];
        add(ribbon([a, b], BAR), o.colours.crosswalk, H + 0.001);
      }
    };
    for (const s of road.stops) {
      const dir = s.dir === 'NB' ? 1 : -1;
      // from the corridor's west edge to its east edge, 0.6 m beyond the stop bar, toward the box
      const y = s.a[1] + dir * 0.6;
      ladder([xWest + 0.3, y], [xEast - 0.3, y], [0, dir]);
    }
    for (const s of crossStops) {
      const dir = s.dir === 'EB' ? 1 : -1;
      const x = s.a[0] + dir * 0.6;
      const lo = band ? bandPoint(band, x, band.edges[0] + 0.3) : null, hi = band ? bandPoint(band, x, band.edges[1] - 0.3) : null;
      if (lo && hi) ladder(lo, hi, [dir, 0]);
    }
  }
  const markings = new THREE.BufferGeometry();
  markings.setAttribute('position', new THREE.Float32BufferAttribute(mp, 3));
  markings.setAttribute('color', new THREE.Float32BufferAttribute(mc, 3));

  /* ---------- kerbs: arm edges trimmed to the cross street, cross-street edges trimmed to the corridor ---------- */
  const kp: number[] = [], sp: number[] = [];
  const WALK = 3;
  let outward: XY = [0, 0];
  const seg = (a: XY, b: XY) => {
    kp.push(a[0], 0.01, -a[1], b[0], 0.01, -b[1]);
    // sidewalk quad from the kerb outward
    const [ox, oy] = outward;
    const q: XY[] = [a, b, [b[0] + ox * WALK, b[1] + oy * WALK], [a[0] + ox * WALK, a[1] + oy * WALK]];
    for (const [x, y] of [q[0], q[1], q[2], q[0], q[2], q[3]]) sp.push(x, 0.0, -y);
  };
  const line = (pts: XY[]) => { for (let i = 1; i < pts.length; i++) seg(pts[i - 1], pts[i]); };
  road.armEdges.forEach((e, i) => {
    const south = i === 0 && road.armEdges.length > 1 ? true : e.left[0][1] < (cross?.y0 ?? 0);
    for (const edge of [e.left, e.right]) {
      outward = edge === e.left ? [-1, 0] : [1, 0];
      const yStop = band ? bandEdgeY(band, edge[edge.length - 1][0], south ? 0 : 1) : south ? (cross?.y0 ?? edge[edge.length - 1][1]) : (cross?.y1 ?? edge[0][1]);
      line(trimEdgeAt(edge, yStop, south));
      // continue straight beyond the study area
      const endS = edge[0], endN = edge[edge.length - 1];
      if (endS[1] <= by0 + 3) seg([endS[0], far.s], endS);
      if (endN[1] >= by1 - 3) seg(endN, [endN[0], far.n]);
    }
  });
  if (band) {
    for (const which of [0, 1] as const) {
      const off = band.edges[which];
      const k = Math.sqrt(1 + band.m * band.m);
      outward = which === 0 ? [band.m / k, -1 / k] : [-band.m / k, 1 / k];
      line([bandPoint(band, far.w, off), bandPoint(band, xWest, off)]);
      line([bandPoint(band, xEast, off), bandPoint(band, far.e, off)]);
    }
  } else if (cross) {
    for (const y of [cross.y0, cross.y1]) { outward = [0, y === cross.y0 ? -1 : 1]; seg([far.w, y], [cross.x0, y]); seg([cross.x1, y], [far.e, y]); }
  }
  const kerbs = new THREE.BufferGeometry();
  kerbs.setAttribute('position', new THREE.Float32BufferAttribute(kp, 3));
  let sidewalks: THREE.BufferGeometry | null = null;
  if (sp.length) { sidewalks = new THREE.BufferGeometry(); sidewalks.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3)); sidewalks.computeVertexNormals(); }

  return { asphalt, markings, kerbs, sidewalks, ext: { xWest, xEast, ySouth, yNorth, xMid, yMid: (ySouth + yNorth) / 2 }, crosswalks, crossStops };
}

/* ---------- signal masts ---------- */
export type SignalGroup = 'ns' | 'ew';
export interface SignalHead { g: SignalGroup; rotY: number; lamps: THREE.Vector3[] }
export interface Signals { structure: THREE.BufferGeometry | null; heads: SignalHead[]; lampCount: number }

export const SIGNAL = { poleH: 6.4, headY: 5.6, housing: [0.38, 1.08, 0.3] as const, lampR: 0.13, lampDy: 0.34 } as const;

/**
 * One mast arm per approach on the far-right corner, heads over the through lanes (NB/SB from the derived stop
 * bars; EB/WB from the cross street's lane offsets). `rotY` is the direction a head faces (toward its approach).
 */
export function buildSignals(road: RoadGeom, street: Street): Signals {
  const parts: THREE.BufferGeometry[] = [];
  const heads: SignalHead[] = [];
  const W = (x: number, y: number, h = 0) => new THREE.Vector3(x, h, -y);
  const { poleH: POLE_H, headY: HEAD_Y } = SIGNAL;
  const mk = (g: SignalGroup, base: XY, armTo: XY, at: XY[], rotY: number) => {
    const b = W(base[0], base[1]), e = W(armTo[0], armTo[1]);
    parts.push(new THREE.CylinderGeometry(0.14, 0.17, POLE_H, 8).translate(b.x, POLE_H / 2, b.z));
    const len = b.distanceTo(e), mid = b.clone().add(e).multiplyScalar(0.5);
    const arm = new THREE.BoxGeometry(len, 0.14, 0.14);
    arm.rotateY(-Math.atan2(e.z - b.z, e.x - b.x)); arm.translate(mid.x, POLE_H - 0.2, mid.z);
    parts.push(arm);
    for (const p of at) {
      const c = W(p[0], p[1], HEAD_Y);
      const housing = new THREE.BoxGeometry(...SIGNAL.housing); housing.rotateY(rotY); housing.translate(c.x, c.y, c.z);
      const hood = new THREE.BoxGeometry(0.42, 0.06, 0.2).translate(0, 0.54, 0.12); hood.rotateY(rotY); hood.translate(c.x, c.y, c.z);
      parts.push(housing, hood, new THREE.BoxGeometry(0.05, POLE_H - 0.2 - HEAD_Y - 0.54, 0.05).translate(c.x, (POLE_H - 0.2 + HEAD_Y + 0.54) / 2, c.z));
      const face = new THREE.Vector3(Math.sin(rotY), 0, Math.cos(rotY));
      heads.push({ g, rotY, lamps: [SIGNAL.lampDy, 0, -SIGNAL.lampDy].map((dy) => c.clone().add(new THREE.Vector3(0, dy, 0)).addScaledVector(face, 0.16)) });
    }
  };
  const nbBar = road.stops.find((s) => s.dir === 'NB'), sbBar = road.stops.find((s) => s.dir === 'SB');
  const { xWest, xEast } = street.ext;
  const band = road.crossBand;
  // NB approach (from the south): mast on the north-east corner, heads over the NB lanes, facing south (rotY = 0 faces −Z... +y is −Z, so a head facing south faces +Z: rotY = 0)
  if (nbBar) {
    const [a, b] = [nbBar.a, nbBar.b];
    const yCorner = band ? bandEdgeY(band, xEast + 1.3, 1) + 1.2 : (road.cross?.y1 ?? a[1] + 24) + 1.2;
    mk('ns', [xEast + 1.3, yCorner], [a[0] + 0.6, yCorner], [[a[0] + (b[0] - a[0]) * 0.3, yCorner], [a[0] + (b[0] - a[0]) * 0.72, yCorner]], 0);
  }
  if (sbBar) {
    const [a, b] = [sbBar.a, sbBar.b];
    const yCorner = band ? bandEdgeY(band, xWest - 1.3, 0) - 1.2 : (road.cross?.y0 ?? a[1] - 24) - 1.2;
    mk('ns', [xWest - 1.3, yCorner], [b[0] - 0.6, yCorner], [[b[0] - (b[0] - a[0]) * 0.3, yCorner], [b[0] - (b[0] - a[0]) * 0.72, yCorner]], Math.PI);
  }
  if (band) {
    // EB approach (from the west): mast beyond the east edge of the corridor on the south-east corner... heads face west (rotY = −π/2 faces −X)
    const ebLanes = band.lanes.filter((l) => l.dir === 'EB').map((l) => l.off), wbLanes = band.lanes.filter((l) => l.dir === 'WB').map((l) => l.off);
    const xE = xEast + 1.3, xW = xWest - 1.3;
    const ebAt: XY[] = (ebLanes.length ? ebLanes : [(band.edges[0] + band.centre) / 2]).map((off) => bandPoint(band, xE, off));
    const wbAt: XY[] = (wbLanes.length ? wbLanes : [(band.edges[1] + band.centre) / 2]).map((off) => bandPoint(band, xW, off));
    mk('ew', bandPoint(band, xE, band.edges[0] - 1.2), bandPoint(band, xE, band.centre), ebAt, -Math.PI / 2);
    mk('ew', bandPoint(band, xW, band.edges[1] + 1.2), bandPoint(band, xW, band.centre), wbAt, Math.PI / 2);
  } else if (road.cross) {
    const c = road.cross, yCm = (c.y0 + c.y1) / 2, xE = c.x0 - 1.2, xW = c.x1 + 1.2;
    mk('ew', [xE, c.y0 - 1.3], [xE, yCm - 0.6], [[xE, c.y0 + (yCm - c.y0) * 0.35], [xE, c.y0 + (yCm - c.y0) * 0.78]], -Math.PI / 2);
    mk('ew', [xW, c.y1 + 1.3], [xW, yCm + 0.6], [[xW, c.y1 - (yCm - c.y1) * 0.35], [xW, c.y1 - (yCm - c.y1) * 0.78]], Math.PI / 2);
  }
  const structure = parts.length ? mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p))) : null;
  parts.forEach((p) => p.dispose());
  return { structure, heads, lampCount: heads.length * 3 };
}

/** Procedural asphalt: fine aggregate noise with faint tyre-polished bands; tiles at `metres` per repeat. */
export function asphaltTexture(base: string, metres = 8, size = 256): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const x = c.getContext('2d')!;
  const col = new THREE.Color(base);
  x.fillStyle = `#${col.getHexString()}`; x.fillRect(0, 0, size, size);
  const img = x.getImageData(0, 0, size, size), d = img.data;
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * 26 + (rnd() - 0.5) * 10;
    d[i] = Math.max(0, Math.min(255, d[i] + n)); d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n)); d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  x.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1 / metres, 1 / metres);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
