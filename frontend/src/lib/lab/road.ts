/**
 * Road geometry derived from the served NGSIM data alone (no basemap): carriageway, lane lines,
 * centre line and stop bars for the plan view and the 3D scene. Pure functions, unit-tested.
 *
 * - Lane centrelines come from the per-lane median lateral position of the observed vehicles
 *   (`lanes_geom`, 5 m bins along the corridor). Bins that sit far off a lane's own median are
 *   turning vehicles inside the intersection and are dropped.
 * - The intersection box is the stretch around y = 0 where no lane centreline is observed
 *   (NGSIM assigns no lane inside the intersection); the cross street runs through it.
 * - Stop bars sit at the queue head of stopped vehicles (`stopLine`), held to the box edge.
 * - Markings follow MUTCD dimensions: 4 in lane lines, 10 ft dash / 30 ft gap, double yellow
 *   centre line, 24 in stop bars.
 * - The cross street is derived from the EB/WB through tracks (`crossBand`): a least-squares axis
 *   (so a skewed intersection stays skewed), carriageway edges at the 2nd–98th percentile of lateral
 *   offsets, lane lines between the density peaks of each direction's offsets, the centre line between
 *   the innermost peaks. Crosswalks are not observable in NGSIM and are not derived.
 */
import type { Crosswalk, IntersectionT, LaneGeom, TrackT } from '../traj';
import { percentile, stopLine } from './metrics';

export type XY = [number, number];
export interface RoadLine { kind: 'lane' | 'centre' | 'edge'; pts: XY[] }
export interface RoadGeom {
  /** Lane width used for edges and bars, m: median spacing of adjacent same-direction centrelines, 2.7–3.7 m. */
  laneW: number;
  /** Intersection box along the corridor (y range with no observed lane), or null when none is found. */
  box: { y0: number; y1: number } | null;
  /** Carriageway polygons of the corridor arms, data metres. */
  arms: XY[][];
  /** Lateral extent of the corridor at the box edges, used to size the cross street. */
  cross: { x0: number; x1: number; y0: number; y1: number } | null;
  lines: RoadLine[];
  stops: { dir: 'NB' | 'SB'; a: XY; b: XY; n: number }[];
  /** Left and right carriageway edges of every arm (south arm first), for kerbs that stop at the cross street. */
  armEdges: { left: XY[]; right: XY[] }[];
  /** Cross street derived from the EB/WB tracks, or null when too few are observed. */
  crossBand: CrossBand | null;
  /** Cross-street stop bars when the site's crosswalks give their position (otherwise street.ts stylises them). */
  crossStops?: { dir: 'EB' | 'WB'; a: XY; b: XY }[];
  /** Source of the geometry: NGSIM lane field, or the surveyed crosswalk polygons of a site feed. */
  source: 'lanes' | 'crosswalks';
}

/** The cross street as a band about the axis y = m·x + b; offsets are perpendicular distances from the axis (m, +toward +y). */
export interface CrossBand {
  m: number; b: number;
  /** Carriageway edge offsets (low, high). */
  edges: [number, number];
  /** Centre line offset (between the innermost EB and WB lanes). */
  centre: number;
  /** Lane-line offsets between same-direction lanes. */
  laneLines: number[];
  /** Lane centre offsets per direction. */
  lanes: { dir: 'EB' | 'WB'; off: number }[];
  /** Skew of the axis from the corridor normal, degrees (positive: axis rises with x). */
  skewDeg: number;
  /** Through tracks used. */
  n: number;
  /** x-range (data m) kept free of band markings: the intersection including its crosswalks. */
  clearX?: [number, number];
}

export const MUTCD = { line: 0.1016, dash: 3.048, gap: 9.144, bar: 0.6096, yellowGap: 0.1016 } as const;

/** A lane's centreline with bins far from its own median removed (turning traffic inside the box). */
export function cleanCentre(l: LaneGeom, tol = 2.5): XY[] {
  const xs = l.centre.map((p) => p[0]);
  const med = percentile(xs, 50) ?? 0;
  return l.centre.filter((p) => Math.abs(p[0] - med) <= tol).map((p) => [p[0], p[1]] as XY).sort((a, b) => a[1] - b[1]);
}

/** Lateral position of a cleaned centreline at y (linear between bins), or null outside it. */
export function xAt(c: XY[], y: number, reach = 2.6): number | null {
  if (!c.length || y < c[0][1] - reach || y > c[c.length - 1][1] + reach) return null;
  if (y <= c[0][1]) return c[0][0];
  for (let i = 1; i < c.length; i++) {
    if (y <= c[i][1]) {
      const [x0, y0] = c[i - 1], [x1, y1] = c[i];
      // a missing bin longer than 12 m is a real break (lane drop / bay start), not a gap to bridge
      if (y1 - y0 > 12) return y - y0 < reach ? x0 : y1 - y < reach ? x1 : null;
      return x0 + ((x1 - x0) * (y - y0)) / (y1 - y0);
    }
  }
  return c[c.length - 1][0];
}

export function roadGeometry(data: Pick<IntersectionT, 'lanes_geom' | 'tracks' | 'bbox'> & { crosswalks?: Crosswalk[] }, step = 1): RoadGeom {
  if (data.crosswalks && data.crosswalks.length >= 3) { const r = crosswalkRoad(data as Pick<IntersectionT, 'tracks' | 'bbox'> & { crosswalks: Crosswalk[] }); if (r) return r; }
  const [[, by0], [, by1]] = data.bbox as [[number, number], [number, number]];
  const lanes = data.lanes_geom
    .filter((l) => l.dir === 'NB' || l.dir === 'SB')
    .map((l) => ({ dir: l.dir, lane: l.lane, c: cleanCentre(l) }))
    .filter((l) => l.c.length >= 2);

  // lane width: adjacent same-direction centrelines at every bin
  const spacing: number[] = [];
  for (let y = by0; y <= by1; y += 5) {
    for (const dir of ['NB', 'SB']) {
      const xs = lanes.filter((l) => l.dir === dir).map((l) => xAt(l.c, y)).filter((v): v is number => v != null).sort((a, b) => a - b);
      for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] > 1.5 && xs[i] - xs[i - 1] < 5) spacing.push(xs[i] - xs[i - 1]);
    }
  }
  const laneW = Math.min(3.7, Math.max(2.7, percentile(spacing, 50) ?? 3.3));

  // intersection box: largest run around y = 0 with no centreline
  const covered = (y: number) => lanes.some((l) => xAt(l.c, y, 0.01) != null);
  let box: RoadGeom['box'] = null;
  if (!covered(0)) {
    let y0 = 0, y1 = 0;
    while (y0 > by0 && !covered(y0 - step)) y0 -= step;
    while (y1 < by1 && !covered(y1 + step)) y1 += step;
    if (y1 - y0 >= 8 && y1 - y0 <= 60) box = { y0, y1 };
  }

  const lines = new Map<string, RoadLine & { last: number }>();
  const done: RoadLine[] = [];
  const push = (key: string, kind: RoadLine['kind'], p: XY) => {
    const cur = lines.get(key);
    if (cur && p[1] - cur.last <= step * 1.5) { cur.pts.push(p); cur.last = p[1]; return; }
    if (cur && cur.pts.length > 1) done.push({ kind: cur.kind, pts: cur.pts });
    lines.set(key, { kind, pts: [p], last: p[1] });
  };
  type At = { dir: string; lane: number; x: number };
  const arms: XY[][] = [];
  const armEdges: RoadGeom['armEdges'] = [];
  const stops: RoadGeom['stops'] = [];
  let xBox0 = Infinity, xBox1 = -Infinity;
  const ranges: [number, number, 'S' | 'N' | null][] = box ? [[by0, box.y0, 'S'], [box.y1, by1, 'N']] : [[by0, by1, null]];
  for (const [ya, yb, side] of ranges) {
    // lanes of this arm only; through lanes (NGSIM ids 1-9) run the whole arm, holding their nearest observed
    // position; turn bays (11, 12, ...) exist only where observed
    const armLanes = lanes.map((l) => ({ ...l, c: l.c.filter((p) => p[1] >= ya - 1 && p[1] <= yb + 1) })).filter((l) => l.c.length >= (l.lane < 10 ? 1 : 2));
    const section = (y: number): At[] => armLanes.map((l) => {
      let x: number | null;
      if (l.lane < 10) {
        const c = l.c;
        x = y <= c[0][1] ? c[0][0] : y >= c[c.length - 1][1] ? c[c.length - 1][0] : null;
        for (let i = 1; x == null && i < c.length; i++) if (y <= c[i][1]) x = c[i - 1][0] + ((c[i][0] - c[i - 1][0]) * (y - c[i - 1][1])) / (c[i][1] - c[i - 1][1]);
      } else x = xAt(l.c, y);
      return { dir: l.dir, lane: l.lane, x };
    }).filter((l): l is At => l.x != null).sort((a, b) => a.x - b.x);
    // carriageway edges: lane-based, widened to the 2nd–98th percentile of observed vehicle positions (a lane the
    // NGSIM lane field does not cover is still pavement), then smoothed
    const ys: number[] = [], secs: At[][] = [], L: number[] = [], Rr: number[] = [];
    for (let y = ya; y <= yb + 1e-9; y += step) {
      const at = section(y);
      if (!at.length) continue;
      ys.push(y); secs.push(at);
      L.push(at[0].x - laneW / 2 - 0.3); Rr.push(at[at.length - 1].x + laneW / 2 + 0.3);
    }
    const bins = new Map<number, number[]>();
    for (const tr of data.tracks) {
      if (tr.dir !== 'NB' && tr.dir !== 'SB') continue;
      for (const p of tr.pts) if (p[2] >= ya && p[2] <= yb) { const k = Math.floor(p[2] / 2); let v = bins.get(k); if (!v) bins.set(k, (v = [])); v.push(p[1]); }
    }
    ys.forEach((y, i) => {
      const v = bins.get(Math.floor(y / 2));
      if (!v || v.length < 12) return;
      L[i] = Math.min(L[i], percentile(v, 2)! - 1.3); Rr[i] = Math.max(Rr[i], percentile(v, 98)! + 1.3);
    });
    const smooth = (a: number[], f: (...x: number[]) => number) => {
      const env = a.map((_, i) => f(...a.slice(Math.max(0, i - 4), i + 5)));
      return env.map((_, i) => { const w = env.slice(Math.max(0, i - 3), i + 4); return w.reduce((s, x) => s + x, 0) / w.length; });
    };
    const Ls = smooth(L, Math.min), Rs = smooth(Rr, Math.max);
    const edgeAt = (y: number): [number, number] | null => { if (!ys.length) return null; let j = 0; for (let i = 1; i < ys.length; i++) if (Math.abs(ys[i] - y) < Math.abs(ys[j] - y)) j = i; return [Ls[j], Rs[j]]; };
    const left: XY[] = [], right: XY[] = [];
    ys.forEach((y, i) => {
      const at = secs[i], l = Ls[i], r = Rs[i];
      left.push([l, y]); right.push([r, y]);
      push('edge-l', 'edge', [l + 0.25, y]); push('edge-r', 'edge', [r - 0.25, y]);
      for (let k = 1; k < at.length; k++) {
        const a = at[k - 1], b = at[k], gap = b.x - a.x;
        if (gap < 1.5) continue; // two bins of one lane
        const kind = a.dir === b.dir ? 'lane' : 'centre';
        if (kind === 'lane' && gap > 5) continue; // a median or an unobserved lane: no marking
        push(`${a.dir}${a.lane}|${b.dir}${b.lane}`, kind, [(a.x + b.x) / 2, y]);
      }
    });
    if (left.length > 1) { armEdges.push({ left: [...left], right: [...right] }); arms.push([...left, ...right.reverse()]); }
    for (const l of lines.values()) if (l.pts.length > 1) done.push({ kind: l.kind, pts: l.pts });
    lines.clear();
    if (!side) continue;
    const yEdge = side === 'S' ? yb : ya;
    const ee = edgeAt(yEdge);
    if (ee) { xBox0 = Math.min(xBox0, ee[0]); xBox1 = Math.max(xBox1, ee[1]); }
    // stop bar of the approach entering the box from this arm: NB from the south, SB from the north
    const dir = side === 'S' ? 'NB' : 'SB';
    const s = stopLine(data.tracks, dir);
    // queue head is the front bumper of the first stopped vehicle; the bar sits ~1 m ahead of it, never inside the box
    let y = s ? s.y + (dir === 'NB' ? 1 : -1) : yEdge;
    y = dir === 'NB' ? Math.min(Math.max(y, ya), yEdge - 0.4) : Math.max(Math.min(y, yb), yEdge + 0.4);
    // the bar runs from the centre line to the kerb on the approach side (NB: east, +x; SB: west, −x)
    const xs = section(y).filter((l) => l.dir === dir).map((l) => l.x), e = edgeAt(y);
    if (xs.length && e) stops.push(dir === 'NB'
      ? { dir, a: [Math.min(...xs) - laneW / 2, y], b: [Math.max(Math.max(...xs) + laneW / 2, e[1] - 0.3), y], n: s?.n ?? 0 }
      : { dir, a: [Math.min(Math.min(...xs) - laneW / 2, e[0] + 0.3), y], b: [Math.max(...xs) + laneW / 2, y], n: s?.n ?? 0 });
  }

  return {
    laneW, box, arms, armEdges, lines: done, stops,
    cross: box && Number.isFinite(xBox0) ? { x0: xBox0, x1: xBox1, y0: box.y0, y1: box.y1 } : null,
    crossBand: box ? crossBand(data.tracks) : null,
    source: 'lanes',
  };
}

/** Point on the band axis at x, shifted by a perpendicular offset. */
export function bandPoint(c: CrossBand, x: number, off: number): XY {
  const k = Math.sqrt(1 + c.m * c.m);
  // unit normal of the axis (−m, 1)/k; moving by `off` along it changes x too
  return [x - (c.m * off) / k, c.m * x + c.b + off / k];
}

/** Polyline of a band offset from xa to xb (two points: the axis is straight). */
export const bandLine = (c: CrossBand, off: number, xa: number, xb: number): XY[] => [bandPoint(c, xa, off), bandPoint(c, xb, off)];

/** Carriageway polygon of the band between xa and xb. */
export function bandPolygon(c: CrossBand, xa: number, xb: number): XY[] {
  return [bandPoint(c, xa, c.edges[0]), bandPoint(c, xb, c.edges[0]), bandPoint(c, xb, c.edges[1]), bandPoint(c, xa, c.edges[1])];
}

/** y of the band's low/high edge at x (for trimming corridor kerbs at the cross street). */
export const bandEdgeY = (c: CrossBand, x: number, which: 0 | 1): number => bandPoint(c, x, c.edges[which])[1];

/** Markings of the band on one side of the corridor (x from xa to xb): edges, centre line and lane lines. */
export function bandLines(c: CrossBand, xa: number, xb: number): RoadLine[] {
  const out: RoadLine[] = [
    { kind: 'edge', pts: bandLine(c, c.edges[0] + 0.25, xa, xb) },
    { kind: 'edge', pts: bandLine(c, c.edges[1] - 0.25, xa, xb) },
    { kind: 'centre', pts: bandLine(c, c.centre, xa, xb) },
  ];
  for (const off of c.laneLines) out.push({ kind: 'lane', pts: bandLine(c, off, xa, xb) });
  return out;
}

/** Density peaks of 1-D values: 0.5 m bins, 3-bin smoothing, local maxima ≥ `minShare` of the top peak, ≥ `sep` apart. */
export function densityPeaks(values: number[], sep = 2.6, minShare = 0.35, bin = 0.5): number[] {
  if (values.length < 10) return [];
  const lo = Math.floor(Math.min(...values) / bin), hi = Math.ceil(Math.max(...values) / bin);
  const n = hi - lo + 1, h = new Array<number>(n).fill(0);
  for (const v of values) h[Math.min(n - 1, Math.max(0, Math.round(v / bin) - lo))]++;
  const sm = h.map((_, i) => (h[i - 1] ?? 0) + h[i] + (h[i + 1] ?? 0));
  const top = Math.max(...sm);
  const cands: { x: number; w: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (!(sm[i] >= (sm[i - 1] ?? 0) && sm[i] >= (sm[i + 1] ?? 0) && h[i] >= (h[i - 1] ?? 0) && h[i] >= (h[i + 1] ?? 0) && sm[i] >= top * minShare && h[i] > 0)) continue;
    // centroid of the three bins, so a peak sits on the data rather than on the bin grid
    let sw = 0, sx = 0;
    for (let j = Math.max(0, i - 1); j <= Math.min(n - 1, i + 1); j++) { sw += h[j]; sx += h[j] * (j + lo) * bin; }
    cands.push({ x: sx / sw, w: sm[i] });
  }
  cands.sort((a, b) => b.w - a.w);
  const out: number[] = [];
  for (const c of cands) if (out.every((x) => Math.abs(x - c.x) >= sep)) out.push(c.x);
  return out.sort((a, b) => a - b);
}

/**
 * Cross street from the EB/WB through tracks: tracks whose net displacement is mostly across the corridor
 * (|Δx| > 2|Δy|, which drops mislabelled corridor tracks), moving samples only (> 1 m/s).
 */
export function crossBand(tracks: TrackT[], minTracks = 6): CrossBand | null {
  const xs: number[] = [], ys: number[] = [], dirs: ('EB' | 'WB')[] = [];
  let n = 0;
  for (const tr of tracks) {
    if ((tr.dir !== 'EB' && tr.dir !== 'WB') || (tr.move && tr.move !== 'through') || tr.pts.length < 2) continue;
    const p = tr.pts, dx = p[p.length - 1][1] - p[0][1], dy = p[p.length - 1][2] - p[0][2];
    if (Math.abs(dx) < 2 * Math.abs(dy)) continue;
    n++;
    for (const q of p) if (q[3] > 1) { xs.push(q[1]); ys.push(q[2]); dirs.push(tr.dir); }
  }
  if (n < minTracks || xs.length < 50) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length, my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < xs.length; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
  const m = sxx > 0 ? sxy / sxx : 0, b = my - m * mx, k = Math.sqrt(1 + m * m);
  const off = xs.map((x, i) => (ys[i] - m * x - b) / k);
  const eb = off.filter((_, i) => dirs[i] === 'EB'), wb = off.filter((_, i) => dirs[i] === 'WB');
  const all = [...eb, ...wb];
  const edges: [number, number] = [percentile(all, 2)! - 1.3, percentile(all, 98)! + 1.3];
  const pe = densityPeaks(eb), pw = densityPeaks(wb);
  const laneLines: number[] = [];
  for (const peaks of [pe, pw]) for (let i = 1; i < peaks.length; i++) laneLines.push((peaks[i - 1] + peaks[i]) / 2);
  // centre line between the innermost lanes (EB keeps the low side, WB the high side on a right-hand road)
  const ebMax = pe.length ? Math.max(...pe) : percentile(eb, 90)!, wbMin = pw.length ? Math.min(...pw) : percentile(wb, 10)!;
  const centre = wbMin > ebMax ? (ebMax + wbMin) / 2 : (percentile(eb, 98)! + percentile(wb, 2)!) / 2;
  return {
    m, b, edges, centre, laneLines: laneLines.filter((o) => Math.abs(o - centre) > 1.2),
    lanes: [...pe.map((o) => ({ dir: 'EB' as const, off: o })), ...pw.map((o) => ({ dir: 'WB' as const, off: o }))],
    skewDeg: (Math.atan(m) * 180) / Math.PI, n,
  };
}

/* ---------- site feeds: the street from the surveyed crosswalks ---------- */

interface CwBox { xmin: number; xmax: number; ymin: number; ymax: number; cx: number; cy: number }
const cwBox = (poly: XY[]): CwBox => {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  return { xmin: Math.min(...xs), xmax: Math.max(...xs), ymin: Math.min(...ys), ymax: Math.max(...ys), cx: xs.reduce((a, b) => a + b, 0) / xs.length, cy: ys.reduce((a, b) => a + b, 0) / ys.length };
};

/** Lateral percentiles of moving samples of a direction (vehicles only), or null below 30 samples. */
function lateral(tracks: TrackT[], dir: string, axis: 1 | 2, lo: number, hi: number): [number, number] | null {
  const v: number[] = [];
  for (const tr of tracks) { if (tr.dir !== dir || tr.cls === 'pedestrian') continue; for (const p of tr.pts) if (p[3] > 1) v.push(p[axis]); }
  if (v.length < 30) return null;
  return [percentile(v, lo)!, percentile(v, hi)!];
}

/**
 * A four-arm intersection from its surveyed crosswalk polygons (site feeds, docs/SITE_TRAJECTORY_SCHEMA.md): the
 * box is the pavement between the four crosswalks (crosswalks included), each arm is as wide as its crosswalk is
 * long, the centre line sits between the two directions' observed traffic and lane lines follow at 3.5 m
 * (11.5 ft) from it, stop bars lie 1 m upstream of each crosswalk. Returns null without a crosswalk on both axes.
 */
export function crosswalkRoad(data: Pick<IntersectionT, 'tracks' | 'bbox'> & { crosswalks: Crosswalk[] }): RoadGeom | null {
  const [[bx0, by0], [bx1, by1]] = data.bbox as [[number, number], [number, number]];
  const boxes = data.crosswalks.map((c) => ({ id: c.id, b: cwBox(c.polygon), across: (() => { const b = cwBox(c.polygon); return b.xmax - b.xmin >= b.ymax - b.ymin; })() }));
  const ns = boxes.filter((c) => c.across).sort((a, b) => a.b.cy - b.b.cy), ew = boxes.filter((c) => !c.across).sort((a, b) => a.b.cx - b.b.cx);
  if (!ns.length || !ew.length) return null;
  const S = ns[0].b, N = ns[ns.length - 1].b, Wc = ew[0].b, E = ew[ew.length - 1].b;
  const laneW = 3.5;
  const y0 = ns.length > 1 ? S.ymin : Math.min(S.ymin, Wc.ymin, E.ymin), y1 = ns.length > 1 ? N.ymax : Math.max(S.ymax, Wc.ymax, E.ymax);
  const x0 = ew.length > 1 ? Wc.xmin : Math.min(Wc.xmin, S.xmin, N.xmin), x1 = ew.length > 1 ? E.xmax : Math.max(Wc.xmax, S.xmax, N.xmax);
  const lines: RoadLine[] = [], arms: XY[][] = [], armEdges: RoadGeom['armEdges'] = [], stops: RoadGeom['stops'] = [];
  // corridor centre: between southbound traffic (west, smaller x) and northbound traffic (east)
  const sbX = lateral(data.tracks, 'SB', 1, 5, 95), nbX = lateral(data.tracks, 'NB', 1, 5, 95);
  const corridorArms: [number, number, number, number, 'S' | 'N'][] = [[S.xmin, S.xmax, by0 - 1, y0, 'S'], [N.xmin, N.xmax, y1, by1 + 1, 'N']];
  for (const [xa, xb, ya, yb, side] of corridorArms) {
    const left: XY[] = [[xa, ya], [xa, yb]], right: XY[] = [[xb, ya], [xb, yb]];
    arms.push([...left, ...right.slice().reverse()]); armEdges.push({ left, right });
    lines.push({ kind: 'edge', pts: [[xa + 0.25, ya], [xa + 0.25, yb]] }, { kind: 'edge', pts: [[xb - 0.25, ya], [xb - 0.25, yb]] });
    const centre = sbX && nbX ? (sbX[1] + nbX[0]) / 2 : (xa + xb) / 2;
    lines.push({ kind: 'centre', pts: [[centre, ya], [centre, yb]] });
    for (let x = centre + laneW; x < xb - 1.2; x += laneW) lines.push({ kind: 'lane', pts: [[x, ya], [x, yb]] });
    for (let x = centre - laneW; x > xa + 1.2; x -= laneW) lines.push({ kind: 'lane', pts: [[x, ya], [x, yb]] });
    // stop bar 1 m upstream of the crosswalk on the approach half (NB east of the centre line, SB west of it)
    if (side === 'S') stops.push({ dir: 'NB', a: [centre, S.ymin - 1], b: [xb - 0.3, S.ymin - 1], n: 0 });
    else stops.push({ dir: 'SB', a: [xa + 0.3, N.ymax + 1], b: [centre, N.ymax + 1], n: 0 });
  }
  // cross street: axis through the E/W crosswalk centroids, edges at their extents, centre between EB and WB traffic
  const m = E.cx !== Wc.cx ? (E.cy - Wc.cy) / (E.cx - Wc.cx) : 0;
  const mx = (E.cx + Wc.cx) / 2, my = (E.cy + Wc.cy) / 2, b = my - m * mx, k = Math.sqrt(1 + m * m);
  const off = (x: number, y: number) => (y - m * x - b) / k;
  const edges: [number, number] = [Math.min(off(Wc.cx, Wc.ymin), off(E.cx, E.ymin)), Math.max(off(Wc.cx, Wc.ymax), off(E.cx, E.ymax))];
  const ebY = lateral(data.tracks, 'EB', 2, 5, 95), wbY = lateral(data.tracks, 'WB', 2, 5, 95);
  const centre = ebY && wbY ? (off(mx, ebY[1]) + off(mx, wbY[0])) / 2 : (edges[0] + edges[1]) / 2;
  const laneLines: number[] = [];
  for (let o = centre + laneW; o < edges[1] - 1.2; o += laneW) laneLines.push(o);
  for (let o = centre - laneW; o > edges[0] + 1.2; o -= laneW) laneLines.push(o);
  const band: CrossBand = { m, b, edges, centre, laneLines, lanes: [], skewDeg: (Math.atan(m) * 180) / Math.PI, n: 0, clearX: [x0, x1] };
  const crossStops: RoadGeom['crossStops'] = [
    { dir: 'EB', a: bandPoint(band, Wc.xmin - 1, edges[0] + 0.3), b: bandPoint(band, Wc.xmin - 1, centre) },
    { dir: 'WB', a: bandPoint(band, E.xmax + 1, centre), b: bandPoint(band, E.xmax + 1, edges[1] - 0.3) },
  ];
  return {
    laneW, box: { y0, y1 }, arms, armEdges, lines, stops,
    cross: { x0, x1, y0, y1 },
    crossBand: band, crossStops, source: 'crosswalks',
  };
}

/** Split a polyline into dashes of `dash` m separated by `gap` m, measured along the line. */
export function dashes(pts: XY[], dash: number = MUTCD.dash, gap: number = MUTCD.gap, phase = 0): XY[][] {
  const out: XY[][] = [];
  const period = dash + gap;
  let s = phase % period, cur: XY[] | null = s < dash ? [pts[0]] : null;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    const L = Math.hypot(x1 - x0, y1 - y0);
    let d = 0;
    while (d < L) {
      const on = s < dash, next = on ? dash : period;
      const take = Math.min(L - d, next - s);
      d += take; s += take;
      const p: XY = [x0 + ((x1 - x0) * d) / L, y0 + ((y1 - y0) * d) / L];
      if (on) cur!.push(p);
      if (s >= next - 1e-9) {
        if (on) { if (cur!.length > 1) out.push(cur!); cur = null; } else cur = [p];
        if (s >= period - 1e-9) s = 0;
      }
    }
  }
  if (cur && cur.length > 1) out.push(cur);
  return out;
}

/** Offset a polyline sideways by d m (positive to the right of travel). */
export function offset(pts: XY[], d: number): XY[] {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [p[0] + ((b[1] - a[1]) / L) * d, p[1] - ((b[0] - a[0]) / L) * d] as XY;
  });
}

/** Triangles (x, y pairs, two per vertex) of a ribbon of width w along a polyline. */
export function ribbon(pts: XY[], w: number): number[] {
  const l = offset(pts, -w / 2), r = offset(pts, w / 2), out: number[] = [];
  for (let i = 1; i < pts.length; i++) out.push(...l[i - 1], ...r[i - 1], ...r[i], ...l[i - 1], ...r[i], ...l[i]);
  return out;
}
