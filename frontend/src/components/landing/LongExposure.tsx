import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConflictT, IntersectionT, TrackT } from '../../lib/traj';
import { reducedMotion } from '../../lib/motion';
import { Icon } from '../Icon';
import { useDocTheme, type DocTheme } from './useDocTheme';

/**
 * A long exposure made from data: every NGSIM trajectory at Peachtree St & 10th St drawn as the light its
 * vehicle would leave on a sensor held open over the intersection. Lamps facing the camera burn white,
 * lamps facing away burn red (from each vehicle's instantaneous heading), and every SSAM conflict flares
 * amber at its own time and place. Replayed at 4×, looping; one canvas, paused when hidden or off screen.
 */

const RATE = 4; // replay speed
const WARM = 14; // seconds of trajectory pre-exposed so the first frame is already a photograph
const HALF_LIFE = 2.8; // s (real time) for a trail to fade to half
const LAMP = 0.78; // m, half the lamp spacing
const DPR_CAP = 1.5;

type Ink = { head: string; tail: string; glow: boolean; amber: string; flag: string; label: string; alpha: number };
const INK: Record<DocTheme, Ink> = {
  dark: { head: '255,243,224', tail: '255,62,46', glow: true, amber: '238,174,58', flag: '150,152,147', label: '230,231,227', alpha: 0.42 },
  light: { head: '28,29,27', tail: '178,24,14', glow: false, amber: '176,112,0', flag: '120,122,117', label: '24,25,24', alpha: 0.85 },
};

interface Cam { x: number; y: number; z: number; dx: number; dy: number; cp: number; sp: number; s: number; ox: number; oy: number }

function camera(bbox: number[][], sample: [number, number][], W: number, H: number, top: number, bottom: number): Cam {
  const [[x0, y0], [x1, y1]] = bbox as [[number, number], [number, number]];
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const narrow = W / H < 1.1;
  // An oblique view from the east kerb: Peachtree St runs across the frame, 10th St recedes into it.
  const o = (window as any).__lx ?? {};
  const yaw = (o.yaw ?? (narrow ? -26 : -32)) * (Math.PI / 180);
  const dist = o.dist ?? (narrow ? 105 : 95), h = o.h ?? (narrow ? 62 : 55);
  const dx = Math.sin(yaw), dy = Math.cos(yaw);
  const p = Math.atan2(h, dist);
  const c: Cam = { x: cx - dx * dist, y: cy - dy * dist, z: h, dx, dy, cp: Math.cos(p), sp: Math.sin(p), s: 1, ox: 0, oy: 0 };
  // frame the light the vehicles actually leave (2nd–98th percentile of sampled positions), not the bounding box
  const xs: number[] = [], ys: number[] = [];
  for (const [x, y] of sample) { const q = norm(c, x, y); if (q) { xs.push(q[0]); ys.push(q[1]); } }
  xs.sort((m, n) => m - n); ys.sort((m, n) => m - n);
  const pc = (v: number[], k: number) => v[Math.min(v.length - 1, Math.max(0, Math.round(k * (v.length - 1))))];
  const a = pc(xs, 0.01), e = pc(xs, 0.99), b = pc(ys, 0.015), f = pc(ys, 0.985);
  const ih = Math.max(40, H - top - bottom);
  c.s = Math.min(ih / (f - b), (W * (o.over ?? (narrow ? 1.6 : 1.5))) / (e - a));
  c.ox = W / 2 - (c.s * (a + e)) / 2;
  c.oy = top + ih / 2 - (c.s * (b + f)) / 2;
  return c;
}

/** Perspective projection to normalised image coordinates; null behind the camera. */
function norm(c: Cam, x: number, y: number): [number, number, number] | null {
  const vx = x - c.x, vy = y - c.y, vz = -c.z;
  const Z = vx * c.dx * c.cp + vy * c.dy * c.cp - vz * c.sp;
  if (Z < 2) return null;
  const X = vx * c.dy - vy * c.dx;
  const Y = vx * c.dx * c.sp + vy * c.dy * c.sp + vz * c.cp;
  return [X / Z, -Y / Z, Z];
}
const proj = (c: Cam, x: number, y: number) => {
  const q = norm(c, x, y);
  return q ? [c.ox + c.s * q[0], c.oy + c.s * q[1], q[2]] as const : null;
};

interface Lamp { x: number; y: number; h: number; v: number }
/** Interpolated position, heading and speed of a track at time t (10 Hz samples). */
function lampAt(tr: TrackT & { _hh?: number }, t: number): Lamp | null {
  const p = tr.pts;
  if (t < p[0][0] || t > p[p.length - 1][0]) return null;
  const f = (t - p[0][0]) * 10, i = Math.min(p.length - 1, Math.floor(f)), j = Math.min(p.length - 1, i + 1), u = f - i;
  const lo = p[Math.max(0, i - 4)], hi = p[Math.min(p.length - 1, i + 4)];
  const ddx = hi[1] - lo[1], ddy = hi[2] - lo[2];
  const h = Math.hypot(ddx, ddy) > 0.3 ? Math.atan2(ddy, ddx) : tr._hh ?? Math.PI / 2;
  tr._hh = h;
  return { x: p[i][1] + (p[j][1] - p[i][1]) * u, y: p[i][2] + (p[j][2] - p[i][2]) * u, h, v: p[i][3] };
}

export interface ExposureStats { t: number; inFrame: number; conflicts: number; critical: number }

export default function LongExposure({ ix, conflicts }: { ix: IntersectionT; conflicts: ConflictT[] }) {
  const theme = useDocTheme();
  const wrap = useRef<HTMLDivElement>(null);
  const cvs = useRef<HTMLCanvasElement>(null);
  const hud = useRef<{ t: HTMLElement | null; n: HTMLElement | null; c: HTMLElement | null; k: HTMLElement | null }>({ t: null, n: null, c: null, k: null });
  const [still] = useState(reducedMotion);
  const [playing, setPlaying] = useState(() => !reducedMotion());
  const playRef = useRef(playing);
  playRef.current = playing;
  const kick = useRef<() => void>(() => {});

  const D = ix.window_s || 90;
  const events = useMemo(() => {
    const byId = new Map(ix.tracks.map((tr) => [String(tr.id), tr]));
    return conflicts.map((c) => {
      const cell = (c as ConflictT & { cell?: [number, number] }).cell;
      let x: number | null = null, y: number | null = null;
      if (cell) { x = cell[0]; y = cell[1]; }
      else {
        const a = byId.get(String(c.a)), b = byId.get(String(c.b));
        const pa = a && lampAt(a, c.t), pb = b && lampAt(b, c.t);
        if (pa && pb) { x = (pa.x + pb.x) / 2; y = (pa.y + pb.y) / 2; } else if (pa || pb) { x = (pa || pb)!.x; y = (pa || pb)!.y; }
      }
      const overlap = !!(c as ConflictT & { overlap?: boolean }).overlap;
      const label = overlap ? 'overlap flag' : c.type === 'crossing' ? `PET ${c.pet?.toFixed(2)} s` : `TTC ${c.ttc_min?.toFixed(2)} s`;
      return { c, x, y, overlap, label, crit: c.severity === 'critical' && !overlap };
    }).filter((e) => e.x != null).sort((p, q) => p.c.t - q.c.t);
  }, [ix, conflicts]);

  useEffect(() => {
    const canvas = cvs.current, box = wrap.current;
    if (!canvas || !box) return;
    const ink = INK[theme];
    const ctx = canvas.getContext('2d')!;
    const acc = document.createElement('canvas');
    const ac = acc.getContext('2d')!;
    let W = 0, H = 0, dpr = 1, cam: Cam | null = null;
    let t = still ? D : WARM, raf = 0, last = 0, debt = 0, hudAt = 0, visible = true, onscreen = true;
    let pulses: { e: (typeof events)[number]; born: number }[] = [];
    const tracks = ix.tracks;
    const sample: [number, number][] = [];
    for (const tr of tracks) for (let i = 0; i < tr.pts.length; i += 15) sample.push([tr.pts[i][1], tr.pts[i][2]]);

    const lampPair = (l: Lamp) => {
      const px = -Math.sin(l.h) * LAMP, py = Math.cos(l.h) * LAMP;
      return [[l.x + px, l.y + py], [l.x - px, l.y - py]] as const;
    };
    /** Which lamps the camera sees: +1 heading straight away (tail lights), −1 straight at it (headlights). */
    const facing = (l: Lamp) => Math.cos(l.h) * cam!.dx + Math.sin(l.h) * cam!.dy;

    /** Burn the light of every vehicle moving between t0 and t1 into the exposure. */
    const expose = (t0: number, t1: number, gain: number) => {
      if (!cam) return;
      ac.globalCompositeOperation = ink.glow ? 'lighter' : 'source-over';
      ac.lineCap = 'butt';
      for (const tr of tracks) {
        const p = tr.pts;
        if (t1 < p[0][0] || t0 > p[p.length - 1][0]) continue;
        const a = lampAt(tr, Math.max(t0, p[0][0])), b = lampAt(tr, Math.min(t1, p[p.length - 1][0]));
        if (!a || !b) continue;
        const fc = facing(b);
        const rgb = fc > 0 ? ink.tail : ink.head;
        const k = (0.32 + 0.68 * Math.abs(fc)) * gain;
        const A = lampPair(a), B = lampPair(b);
        for (let s = 0; s < 2; s++) {
          const p0 = proj(cam, A[s][0], A[s][1]), p1 = proj(cam, B[s][0], B[s][1]);
          if (!p0 || !p1) continue;
          const w = Math.max(0.8, Math.min(4, (cam.s * (ink.glow ? 0.28 : 0.4)) / p1[2]));
          if (ink.glow) {
            ac.strokeStyle = `rgba(${rgb},${(0.07 * k).toFixed(3)})`;
            ac.lineWidth = w * 4.5;
            ac.beginPath(); ac.moveTo(p0[0], p0[1]); ac.lineTo(p1[0], p1[1]); ac.stroke();
          }
          ac.strokeStyle = `rgba(${rgb},${(ink.alpha * k).toFixed(3)})`;
          ac.lineWidth = w;
          ac.beginPath(); ac.moveTo(p0[0], p0[1]); ac.lineTo(p1[0], p1[1]); ac.stroke();
        }
      }
      // conflicts burn a small mark into the exposure too, so the plate keeps where they happened
      for (const e of events) {
        if (e.c.t < t0 || e.c.t > t1) continue;
        const q = proj(cam, e.x!, e.y!);
        if (!q) continue;
        ac.globalCompositeOperation = 'source-over';
        ac.fillStyle = `rgba(${e.overlap ? ink.flag : ink.amber},${e.overlap ? 0.5 : 0.9})`;
        ac.beginPath(); ac.arc(q[0], q[1], e.crit ? 3.2 : 2.2, 0, Math.PI * 2); ac.fill();
        ac.globalCompositeOperation = ink.glow ? 'lighter' : 'source-over';
      }
    };

    /** Exponential fade, applied in steps large enough to survive 8-bit alpha. */
    const fade = (dtReal: number) => {
      debt += (dtReal * Math.LN2) / HALF_LIFE;
      if (debt < 0.035) return;
      ac.globalCompositeOperation = 'destination-out';
      ac.fillStyle = `rgba(0,0,0,${(1 - Math.exp(-debt)).toFixed(4)})`;
      ac.fillRect(0, 0, W, H);
      debt = 0;
    };

    const warm = (from: number, to: number, faded: boolean) => {
      for (let u = Math.max(0, from); u < to; u += 0.1) {
        if (faded) fade(0.1 / RATE);
        expose(u, Math.min(to, u + 0.1), faded ? 1 : 0.34);
      }
    };

    const stats = (): ExposureStats => {
      let n = 0;
      for (const tr of tracks) { const p = tr.pts; if (t >= p[0][0] && t <= p[p.length - 1][0]) n++; }
      let c = 0, k = 0;
      for (const e of events) { if (e.c.t > t) break; c++; if (e.crit) k++; }
      return { t, inFrame: n, conflicts: c, critical: k };
    };
    const paintHud = () => {
      const s = stats(), h = hud.current;
      if (h.t) h.t.textContent = s.t.toFixed(1).padStart(4, '0');
      if (h.n) h.n.textContent = String(s.inFrame);
      if (h.c) h.c.textContent = String(s.conflicts);
      if (h.k) h.k.textContent = String(s.critical);
    };

    const compose = (now: number) => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(acc, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!cam) return;
      // the lamps themselves, where every vehicle is now
      if (!still || playRef.current) {
        ctx.globalCompositeOperation = ink.glow ? 'lighter' : 'source-over';
        for (const tr of tracks) {
          const l = lampAt(tr, t);
          if (!l) continue;
          const rgb = facing(l) > 0 ? ink.tail : ink.head;
          for (const [x, y] of lampPair(l)) {
            const q = proj(cam, x, y);
            if (!q) continue;
            const r = Math.max(1, Math.min(3.2, (cam.s * 0.3) / q[2]));
            if (ink.glow) { ctx.fillStyle = `rgba(${rgb},0.16)`; ctx.beginPath(); ctx.arc(q[0], q[1], r * 3.4, 0, 7); ctx.fill(); }
            ctx.fillStyle = `rgba(${rgb},0.95)`; ctx.beginPath(); ctx.arc(q[0], q[1], r, 0, 7); ctx.fill();
          }
        }
      }
      // conflict flares
      ctx.globalCompositeOperation = 'source-over';
      ctx.font = '500 13px "JetBrains Mono Variable", ui-monospace, monospace'; // taste-skill-ignore: project rule, measurements in mono
      pulses = pulses.filter((p) => now - p.born < 2600);
      let lastCrit: (typeof pulses)[number] | null = null;
      for (const p of pulses) if (p.e.crit) lastCrit = p;
      for (const p of pulses) {
        const q = proj(cam, p.e.x!, p.e.y!);
        if (!q) continue;
        const age = (now - p.born) / 1500, k = Math.max(0, 1 - age);
        const rgb = p.e.overlap ? ink.flag : ink.amber;
        if (age < 1) {
          const r = (p.e.crit ? 10 : 6) + (p.e.crit ? 46 : 26) * (1 - Math.pow(1 - age, 3));
          ctx.strokeStyle = `rgba(${rgb},${(0.85 * k).toFixed(3)})`;
          ctx.lineWidth = p.e.crit ? 2 : 1.4;
          ctx.beginPath(); ctx.arc(q[0], q[1], r, 0, 7); ctx.stroke();
          ctx.fillStyle = `rgba(${rgb},${(0.9 * k).toFixed(3)})`;
          ctx.beginPath(); ctx.arc(q[0], q[1], p.e.crit ? 4.5 : 3, 0, 7); ctx.fill();
        }
        if (p.e.crit && p === lastCrit) {
          const la = Math.max(0, 1 - (now - p.born) / 2600);
          ctx.fillStyle = `rgba(${ink.label},${(0.92 * la).toFixed(3)})`;
          const tw = ctx.measureText(p.e.label).width;
          const lx = q[0] + 14 + tw > W - 8 ? q[0] - 14 - tw : q[0] + 14;
          ctx.fillText(p.e.label, lx, Math.max(16, q[1] - 10));
        }
      }
    };

    const resize = () => {
      const r = box.getBoundingClientRect();
      W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
      dpr = Math.min(DPR_CAP, window.devicePixelRatio || 1);
      for (const c of [canvas, acc]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
      ac.setTransform(dpr, 0, 0, dpr, 0, 0);
      const phone = W < 640;
      cam = camera(ix.bbox as number[][], sample, W, H, phone ? 48 : 30, phone ? 16 : 20);
      ac.clearRect(0, 0, W, H);
      debt = 0;
      if (still && !playRef.current) warm(0, D, false);
      else warm(t - WARM, t, true);
      compose(performance.now());
      paintHud();
    };

    const frame = (now: number) => {
      raf = 0;
      const dtReal = Math.min(0.1, (now - last) / 1000);
      last = now;
      const t0 = t;
      let t1 = t + dtReal * RATE;
      fade(dtReal);
      if (t1 >= D) {
        expose(t0, D, 1);
        t1 -= D;
        for (const e of events) if (e.c.t > t0) pulses.push({ e, born: now });
        expose(0, t1, 1);
        for (const e of events) if (e.c.t <= t1) pulses.push({ e, born: now });
      } else {
        expose(t0, t1, 1);
        for (const e of events) if (e.c.t > t0 && e.c.t <= t1) pulses.push({ e, born: now });
      }
      t = t1;
      compose(now);
      if (now - hudAt > 120) { paintHud(); hudAt = now; }
      schedule();
    };
    const schedule = () => {
      if (raf || !playRef.current || !visible || !onscreen) return;
      last = performance.now();
      raf = requestAnimationFrame((n) => { last = Math.min(last, n); frame(n); });
    };
    kick.current = () => {
      if (playRef.current) schedule();
      else { cancelAnimationFrame(raf); raf = 0; }
    };

    const ro = new ResizeObserver(() => resize());
    if (import.meta.env.DEV) window.addEventListener('lx-refit', resize);
    ro.observe(box);
    const io = new IntersectionObserver(([e]) => { onscreen = e.isIntersecting; kick.current(); }, { threshold: 0 });
    io.observe(box);
    const vis = () => { visible = !document.hidden; kick.current(); };
    document.addEventListener('visibilitychange', vis);
    resize();
    schedule();
    return () => { if (import.meta.env.DEV) window.removeEventListener('lx-refit', resize); cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); document.removeEventListener('visibilitychange', vis); };
  }, [ix, events, theme, still, D]);

  useEffect(() => { kick.current(); }, [playing]);

  const total = events.length, crit = events.filter((e) => e.crit).length;
  return (
    <div className="lx" ref={wrap} data-ui>
      <canvas ref={cvs} className="lx-canvas" role="img"
        aria-label={`Long exposure of ${ix.tracks.length} vehicle trajectories at ${ix.name}, ${D} s replayed at ${RATE}×. Light trails: headlights. Red trails: tail lights. Amber: ${total} SSAM conflicts, ${crit} critical.`} />
      <div className="lx-bar">
      <div className="lx-hud" aria-hidden="true">
        <span><small>t</small><b className="measure" ref={(el) => { hud.current.t = el; }}>00.0</b><small>/ {D} s</small></span>
        <span><small>In frame</small><b className="measure" ref={(el) => { hud.current.n = el; }}>0</b></span>
        <span><small>Conflicts</small><b className="measure" ref={(el) => { hud.current.c = el; }}>0</b></span>
        <span data-tone="crit"><small>Critical</small><b className="measure" ref={(el) => { hud.current.k = el; }}>0</b></span>
      </div>
      <button type="button" className="lx-play" onClick={() => setPlaying((p) => !p)}
        aria-label={playing ? 'Pause replay' : 'Play replay'}>
        <Icon name={playing ? 'pause' : 'play'} size={16} weight="fill" />
        <span>{playing ? 'Pause' : 'Play'}</span>
      </button>
      </div>
    </div>
  );
}
