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
 *   centre line, 24 in stop bars. Cross-street lanes and crosswalks are not observable in
 *   NGSIM and are not drawn.
 */
import type { IntersectionT, LaneGeom } from '../traj';
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

export function roadGeometry(data: Pick<IntersectionT, 'lanes_geom' | 'tracks' | 'bbox'>, step = 1): RoadGeom {
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
    if (left.length > 1) arms.push([...left, ...right.reverse()]);
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
    laneW, box, arms, lines: done, stops,
    cross: box && Number.isFinite(xBox0) ? { x0: xBox0, x1: xBox1, y0: box.y0, y1: box.y1 } : null,
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
