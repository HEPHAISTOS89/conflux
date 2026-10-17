import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../Icon';
import MetricInfo, { type MetricSpec } from '../MetricInfo';
import { CONFIDENCE_SPEC } from '../../lib/lab/specs';
import { bearingDeg, bearingLabel, confidence, kinAt, M_TO_FT, MPS_TO_MPH, petPair, sampleIndex, ttcCV, type Confidence, type Kin } from '../../lib/lab/metrics';
import { useClock, useClockFrame, useSelection, type ConflictT, type IntersectionT, type TrackT } from '../../lib/traj';

const LIVE_TTC: MetricSpec = {
  name: 'Live TTC',
  provenance: 'derived',
  formula: 'Earliest time two-circle footprints (radius w/2, centres ±(L − w)/2) touch if both keep their current velocity vectors',
  threshold: 'Shown up to 10 s; SSAM screens TTC ≤ 1.5 s',
  citation: 'Hayward (1972); FHWA SSAM, Gettman et al. (2008) FHWA-HRT-08-051',
  note: 'Instantaneous constant-velocity TTC for any pair. The conflict table reports the screened minimum TTC from the gap/closing-speed rule.',
};
const PAIR_PET: MetricSpec = {
  name: 'Pair PET',
  provenance: 'derived',
  formula: 'Screened: t(second vehicle front enters the shared swept-footprint zone) − t(first vehicle rear leaves it), as in the conflict table. Otherwise ≈ the same over a 1.5 m zone at the closest path point',
  threshold: 'SSAM screens PET ≤ 5.0 s; negative = both inside at once',
  citation: 'Allen, Shin & Cooper (1978) TRR 667; FHWA SSAM (2008)',
  note: 'A pair with a screened crossing event shows that event\'s PET; any other pair shows the closest-approach approximation, marked ≈. Paths that run together (heading difference < 20°) are a following situation, where PET does not apply.',
};

interface Row { id: string; tr: TrackT; k: Kin | null; c: Confidence | null }

/** Heads-up readout for the selection: kinematics of up to two road users, live TTC and pair PET. */
export default function Hud({ data, conflicts }: { data: IntersectionT; conflicts?: ConflictT[] }) {
  const sel = useSelection();
  const trs = useMemo(() => [...(sel?.selected ?? [])].map((id) => data.tracks.find((t) => String(t.id) === id)).filter((t): t is TrackT => !!t).slice(0, 2), [sel?.selected, data]);
  const [rows, setRows] = useState<Row[]>([]);
  const [ttc, setTtc] = useState<number | null>(null);
  const [t, setT] = useState(0);
  const lastKey = useRef('');
  const pet = useMemo(() => (trs.length === 2 ? petPair(trs[0], trs[1]) : null), [trs]);
  // the screened PET of this pair (backend swept-footprint method) wins over the closest-approach approximation
  const screened = useMemo(() => {
    if (trs.length !== 2) return null;
    const a = String(trs[0].id), b = String(trs[1].id);
    return conflicts?.filter((k) => k.pet != null && ((String(k.a) === a && String(k.b) === b) || (String(k.a) === b && String(k.b) === a))).sort((x, y) => x.pet! - y.pet!)[0] ?? null;
  }, [trs, conflicts]);
  const focusT = useMemo(() => {
    if (trs.length !== 2) return null;
    const a = String(trs[0].id), b = String(trs[1].id);
    const c = conflicts?.filter((k) => (String(k.a) === a && String(k.b) === b) || (String(k.a) === b && String(k.b) === a)).sort((x, y) => (x.ttc_min ?? 9) - (y.ttc_min ?? 9))[0];
    return c ? c.t : null;
  }, [trs, conflicts]);
  const [win, setWin] = useState<[number, number] | null>(null);
  const profile = useMemo(() => (trs.length === 2 && win ? ttcProfile(trs[0], trs[1], win, data.hz) : null), [trs, win, data.hz]);
  const clock = useClock();
  const tick = (tv: number) => {
    const next = trs.map((tr) => {
      const k = kinAt(tr, tv, data.hz), i = sampleIndex(tr, tv, data.hz);
      return { id: String(tr.id), tr, k, c: i == null ? null : confidence(tr.pts, i, data.hz) };
    });
    const key = next.map((r) => r.k ? `${(r.k.v * MPS_TO_MPH).toFixed(1)}|${Math.round(bearingDeg(r.k.h))}|${(r.k.a * M_TO_FT).toFixed(1)}|${r.c?.score.toFixed(2)}` : '-').join('/') + Math.round(tv * 10);
    if (key === lastKey.current) return;
    lastKey.current = key;
    setRows(next); setT(tv);
    if (trs.length === 2) {
      const c = focusT ?? tv;
      setWin((w) => (w && tv >= w[0] && tv <= w[1] && (focusT == null || (focusT >= w[0] && focusT <= w[1])) ? w : [Math.max(0, c - 6), c + 6]));
    }
    const [a, b] = next;
    setTtc(a?.k && b?.k ? ttcCV({ ...a.k, len: a.tr.len_m, w: a.tr.w_m }, { ...b.k, len: b.tr.len_m, w: b.tr.w_m }) : null);
  };
  const tickRef = useRef(tick); tickRef.current = tick;
  // fill the readout at once when the selection changes, before the next animation frame
  useEffect(() => { lastKey.current = ''; tickRef.current(clock.now()); }, [trs, data, clock]);
  useClockFrame((tv) => tickRef.current(tv), [trs, data]);

  if (!trs.length) return null;
  return (
    <div className="hud" role="group" aria-label="Selected road user readout">
      {rows.map((r, i) => (
        <div className="hud-veh" key={r.id} data-primary={i === 0 || undefined}>
          <div className="hud-id">
            <Icon name={r.tr.cls === 'truck' ? 'truck' : 'vehicle'} size={16} />
            <b className="measure">#{r.id}</b>
            <span className="sr-only">{r.tr.cls === 'truck' ? 'heavy vehicle' : 'passenger car'}</span><span className="muted">{r.tr.dir} {r.tr.move}</span>
          </div>
          {r.k ? (
            <dl className="hud-kin">
              <div><dt>Speed</dt><dd className="measure">{(r.k.v * MPS_TO_MPH).toFixed(1)}<small>mph</small></dd></div>
              <div><dt>Heading</dt><dd className="measure">{String(Math.round(bearingDeg(r.k.h)) % 360).padStart(3, '0')}°<small>{bearingLabel(bearingDeg(r.k.h))}</small></dd></div>
              <div><dt>Accel.</dt><dd className="measure">{(r.k.a * M_TO_FT >= 0 ? '+' : '−') + Math.abs(r.k.a * M_TO_FT).toFixed(1)}<small>ft/s²</small></dd></div>
              <div>
                <dt>Confidence {i === 0 && <MetricInfo spec={CONFIDENCE_SPEC} />}</dt>
                <dd className="measure" data-level={r.c?.level}>{r.c ? Math.round(r.c.score * 100) : '—'}<small>%</small></dd>
              </div>
            </dl>
          ) : <p className="muted hud-out">Not in the scene at {t.toFixed(1)} s</p>}
        </div>
      ))}
      {trs.length === 2 && (
        <dl className="hud-pair">
          <div>
            <dt>Live TTC <MetricInfo spec={LIVE_TTC} /></dt>
            <dd className="measure" data-crit={ttc != null && ttc <= 1.5 || undefined}>{ttc == null ? <span className="hud-txt">no collision course</span> : <>{ttc.toFixed(2)}<small>s</small></>}</dd>
          </div>
          <div>
            <dt>PET <MetricInfo spec={PAIR_PET} align="right" /></dt>
            <dd className="measure" data-crit={screened && screened.pet! <= 1 || undefined}>{screened
              ? <>{screened.pet!.toFixed(2)}<small>s · screened{t < screened.t ? ', ahead' : ''}</small></>
              : pet?.kind === 'crossing' && pet.pet != null
                ? <>≈{pet.pet.toFixed(1)}<small>s{pet.tEnter != null && t < pet.tEnter ? ' · ahead' : ''}</small></>
                : <span className="hud-txt">{pet?.kind === 'same_path' ? 'n/a, following' : 'paths do not cross'}</span>}</dd>
          </div>
        </dl>
      )}
      {trs.length === 2 && profile && win && <TtcTrace p={profile} win={win} t={t} />}
    </div>
  );
}

/** Constant-velocity TTC of the pair every 0.1 s over a window (null where they are not on a collision course). */
function ttcProfile(A: TrackT, B: TrackT, [t0, t1]: [number, number], hz: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (let t = t0; t <= t1 + 1e-9; t += 0.1) {
    const a = kinAt(A, t, hz), b = kinAt(B, t, hz);
    out.push(a && b ? ttcCV({ ...a, len: A.len_m, w: A.w_m }, { ...b, len: B.len_m, w: B.w_m }, 5) : null);
  }
  return out;
}

/** TTC profile sparkline: 0–5 s, SSAM 1.5 s threshold, current time cursor. */
function TtcTrace({ p, win, t }: { p: (number | null)[]; win: [number, number]; t: number }) {
  const W = 276, H = 54, Y = (v: number) => 4 + (1 - Math.min(5, v) / 5) * (H - 12), X = (i: number) => (i / Math.max(1, p.length - 1)) * W;
  let d = '', pen = false;
  p.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`; pen = true; });
  const below = p.some((v) => v != null && v <= 1.5);
  const cx = ((t - win[0]) / (win[1] - win[0])) * W;
  return (
    <figure className="hud-trace" aria-label={`Live TTC profile from ${win[0].toFixed(1)} to ${win[1].toFixed(1)} s${below ? '; drops below 1.5 s' : ''}`}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <rect x="0" y={Y(1.5)} width={W} height={H - 8 - Y(1.5)} className="tr-zone" />
        <line x1="0" x2={W} y1={Y(1.5)} y2={Y(1.5)} className="tr-thr" />
        <path d={d} className="tr-line" />
        {cx >= 0 && cx <= W && <line x1={cx} x2={cx} y1="0" y2={H - 8} className="tr-cur" />}
      </svg>
      <figcaption><span>TTC 0–5 s</span><span className="measure">{win[0].toFixed(0)}–{win[1].toFixed(0)} s</span></figcaption>
    </figure>
  );
}
