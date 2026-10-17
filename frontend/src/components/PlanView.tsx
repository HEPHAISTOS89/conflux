import { useEffect, useRef } from 'react';
import { CHART, conflictColor } from '../lib/format';
import { fitCanvas, poseAt, useClockFrame, type ConflictT, type IntersectionT, type TrackT } from '../lib/traj';

interface Props {
  data: IntersectionT;
  conflicts: ConflictT[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  occlusion?: Map<string, [number, number][]>;
  label: string;
}

/** Top-down plan of the intersection: lane bands, vehicles as oriented footprints, 3 s trails, live conflicts. */
export default function PlanView({ data, conflicts, selected, onSelect, occlusion, label }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const view = useRef({ s: 1, ox: 0, oy: 0, vertical: false });
  const [[x0, y0], [x1, y1]] = data.bbox as [[number, number], [number, number]];

  const draw = (t: number) => {
    const c = ref.current;
    if (!c) return;
    const ctx = fitCanvas(c);
    const W = c.clientWidth, H = c.clientHeight;
    // Corridor (+y) runs left→right on wide canvases and bottom→top on tall (phone) canvases.
    const vertical = H > W * 1.1;
    const s = vertical ? Math.min(W / (x1 - x0 + 8), H / (y1 - y0 + 8)) : Math.min(W / (y1 - y0 + 8), H / (x1 - x0 + 8));
    const ox = vertical ? (W - (x1 - x0) * s) / 2 - x0 * s : (W - (y1 - y0) * s) / 2 - y0 * s;
    const oy = vertical ? (H - (y1 - y0) * s) / 2 + y1 * s : (H - (x1 - x0) * s) / 2 + x1 * s;
    view.current = { s, ox, oy, vertical };
    const DIR: Record<string, string> = { NB: CHART.nb, SB: CHART.sb, EB: CHART.eb, WB: CHART.wb };
    const P = (x: number, y: number): [number, number] => (vertical ? [ox + x * s, oy - y * s] : [ox + y * s, oy - x * s]);

    ctx.clearRect(0, 0, W, H);
    // metre graticule every 10 m
    ctx.strokeStyle = CHART.graticule; ctx.lineWidth = 1;
    ctx.beginPath();
    const seg = (a: [number, number], b: [number, number]) => { ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); };
    for (let g = Math.ceil(y0 / 10) * 10; g <= y1; g += 10) seg(P(x0 - 4, g), P(x1 + 4, g));
    for (let g = Math.ceil(x0 / 10) * 10; g <= x1; g += 10) seg(P(g, y0 - 4), P(g, y1 + 4));
    ctx.stroke();

    // lane bands (10th–90th percentile of observed lateral position)
    for (const l of data.lanes_geom) {
      if (!l.p10 || !l.p90) continue;
      ctx.beginPath();
      l.p10.forEach(([x, y], i) => { const [a, b] = P(x, y); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); });
      [...l.p90].reverse().forEach(([x, y]) => { const [a, b] = P(x, y); ctx.lineTo(a, b); });
      ctx.closePath();
      ctx.fillStyle = 'rgba(230,231,227,0.04)'; ctx.fill();
      ctx.setLineDash([6, 6]); ctx.strokeStyle = CHART.rule;
      ctx.beginPath();
      l.centre.forEach(([x, y], i) => { const [a, b] = P(x, y); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); });
      ctx.stroke(); ctx.setLineDash([]);
    }
    // stop-bar reference at intersection centre
    ctx.strokeStyle = CHART.axis; ctx.lineWidth = 1.25;
    const [cx, cy] = P(0, 0);
    ctx.beginPath(); ctx.moveTo(cx - 6, cy); ctx.lineTo(cx + 6, cy); ctx.moveTo(cx, cy - 6); ctx.lineTo(cx, cy + 6); ctx.stroke();

    const active = conflicts.filter((k) => t >= (k.t0 ?? k.t - 0.6) - 0.4 && t <= (k.t1 ?? k.t + 0.6) + 0.8);
    const hot = new Set(active.flatMap((k) => [String(k.a), String(k.b)]));

    for (const tr of data.tracks) {
      const id = String(tr.id);
      const p = poseAt(tr, t, data.hz);
      if (!p) continue;
      const sel = selected === id;
      const gaps = occlusion?.get(id);
      const hidden = gaps?.some(([g0, g1]) => t >= g0 && t <= g1);
      // trail: last 3 s
      ctx.beginPath();
      const i1 = Math.round((t - tr.pts[0][0]) * data.hz), i0 = Math.max(0, i1 - 30);
      for (let i = i0; i <= i1 && i < tr.pts.length; i++) { const [a, b] = P(tr.pts[i][1], tr.pts[i][2]); i === i0 ? ctx.moveTo(a, b) : ctx.lineTo(a, b); }
      ctx.strokeStyle = sel ? CHART.accent : 'rgba(200,201,196,0.22)'; ctx.lineWidth = sel ? 2 : 1; ctx.stroke();
      // footprint
      const [a, b] = P(p.x, p.y);
      ctx.save(); ctx.translate(a, b); ctx.rotate(vertical ? -p.h : Math.atan2(-Math.cos(p.h), Math.sin(p.h)));
      const L = tr.len_m * s, Wd = Math.max(tr.w_m * s, 3);
      ctx.globalAlpha = hidden ? 0.25 : 1;
      ctx.fillStyle = hot.has(id) ? CHART.caution : sel ? CHART.accent : DIR[tr.dir ?? 'NB'] ?? CHART.ink2;
      ctx.fillRect(-L / 2, -Wd / 2, L, Wd);
      if (hidden) { ctx.strokeStyle = CHART.ink; ctx.setLineDash([2, 2]); ctx.strokeRect(-L / 2, -Wd / 2, L, Wd); ctx.setLineDash([]); }
      ctx.restore(); ctx.globalAlpha = 1;
      if (sel) {
        ctx.font = '500 12px Switzer, system-ui, sans-serif'; ctx.fillStyle = CHART.ink;
        ctx.fillText(`#${id} · ${(p.v * 2.236936).toFixed(1)} mph`, a + 10, b - 10);
      }
    }
    // conflict markers: severity-coloured ring at midpoint of the two road users
    for (const k of active) {
      const A = data.tracks.find((r) => String(r.id) === String(k.a));
      const B = data.tracks.find((r) => String(r.id) === String(k.b));
      const pa = A && poseAt(A, Math.min(t, k.t), data.hz), pb = B && poseAt(B, Math.min(t, k.t), data.hz);
      if (!pa || !pb) continue;
      const [a, b] = P((pa.x + pb.x) / 2, (pa.y + pb.y) / 2);
      const age = Math.max(0, t - k.t);
      ctx.beginPath(); ctx.arc(a, b, 10 + age * 14, 0, Math.PI * 2);
      ctx.globalAlpha = Math.max(0, 0.9 - age); ctx.strokeStyle = conflictColor(k.severity); ctx.lineWidth = 2; ctx.stroke(); ctx.globalAlpha = 1;
    }
    // scale bar
    ctx.fillStyle = CHART.axis; ctx.fillRect(12, H - 18, 9.144 * s, 2);
    ctx.font = '12px Switzer, system-ui, sans-serif'; ctx.fillText('30 ft', 12, H - 24);
  };

  useClockFrame(draw, [data, conflicts, selected, occlusion]);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  useEffect(() => {
    const ro = new ResizeObserver(() => drawRef.current(Number(ref.current?.dataset.t ?? 0)));
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const pick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const { s, ox, oy, vertical } = view.current;
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    const x = vertical ? (cx - ox) / s : (oy - cy) / s;
    const y = vertical ? (oy - cy) / s : (cx - ox) / s;
    const t = Number(e.currentTarget.dataset.t ?? 0);
    let best: TrackT | null = null, bd = 4;
    for (const tr of data.tracks) {
      const p = poseAt(tr, t, data.hz);
      if (!p) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) { bd = d; best = tr; }
    }
    onSelect(best ? String(best.id) : null);
  };

  useClockFrame((t) => { if (ref.current) ref.current.dataset.t = String(t); }, []);

  return <canvas ref={ref} className="plan-canvas" onClick={pick} role="img" aria-label={label} />;
}
