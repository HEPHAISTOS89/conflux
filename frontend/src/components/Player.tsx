import { useState } from 'react';
import { conflictColor } from '../lib/format';
import { nextRisk, stepFrame } from '../lib/lab/metrics';
import { selectConflict, useClock, useClockFrame, useSelection, type ConflictT } from '../lib/traj';
import { Icon } from './Icon';

export const RATES = [0.25, 0.5, 1, 2, 4] as const;

/**
 * Transport controls bound to the page clock: play, 10 Hz frame steps, previous/next risk event, rate 0.25–4×.
 * Conflicts appear as severity ticks on the scrubber; a chip shows when the near-miss slow-down is acting.
 */
export default function Player({ label = 'Replay', conflicts }: { label?: string; conflicts?: ConflictT[] }) {
  const c = useClock();
  const sel = useSelection();
  const [t, setT] = useState(c.now());
  const [warp, setWarp] = useState(1);
  useClockFrame((v) => { setT(Math.round(v * 10) / 10); setWarp(Math.round(c.warpNow() * 100) / 100); }, []);
  const step = (n: number) => { c.pause(); c.setT(stepFrame(c.now(), n, c.duration)); };
  const risk = (d: 1 | -1) => { const k = conflicts && nextRisk(conflicts, sel?.conflict != null ? conflicts.find((x) => x.id === sel.conflict)?.t ?? c.now() : c.now(), d); if (k && sel) selectConflict(sel, k); };
  return (
    <div className="player" role="group" aria-label={`${label} controls`}>
      <div className="player-btns">
        {conflicts && <button className="btn ghost ic" onClick={() => risk(-1)} title="Previous risk event ( [ )" aria-label="Previous risk event"><Icon name="stepBack" size={16} /></button>}
        <button className="btn ghost ic" onClick={() => step(-1)} title="Back one frame, 0.1 s ( , )" aria-label="Back one frame"><Icon name="prev" size={16} /></button>
        <button className="btn player-go" onClick={c.toggle} aria-pressed={c.playing} title="Play / pause (Space)">
          <span className="player-ic" key={c.playing ? 'pause' : 'play'}><Icon name={c.playing ? 'pause' : 'play'} size={16} /></span> {c.playing ? 'Pause' : 'Play'}
        </button>
        <button className="btn ghost ic" onClick={() => step(1)} title="Forward one frame, 0.1 s ( . )" aria-label="Forward one frame"><Icon name="next" size={16} /></button>
        {conflicts && <button className="btn ghost ic" onClick={() => risk(1)} title="Next risk event ( ] )" aria-label="Next risk event"><Icon name="stepFwd" size={16} /></button>}
      </div>
      <div className="player-track">
        <input
          type="range" min={0} max={c.duration} step={0.1} value={t}
          onChange={(e) => c.setT(Number(e.target.value))}
          aria-label="Time in replay window (seconds)"
          aria-valuetext={`${t.toFixed(1)} seconds of ${c.duration.toFixed(0)}`}
        />
        {conflicts && sel && (
          <div className="player-ticks" aria-hidden="true">
            {conflicts.map((k) => (
              <button
                key={k.id} tabIndex={-1}
                data-on={sel.conflict === k.id || (sel.selected.has(String(k.a)) && sel.selected.has(String(k.b))) || undefined}
                style={{ left: `calc(8px + (100% - 16px) * ${k.t / c.duration})`, background: conflictColor(k.severity) }}
                title={`${k.type.replace('_', '-')} conflict at ${k.t.toFixed(1)} s · #${k.a} and #${k.b}`}
                onClick={() => selectConflict(sel, k)}
              />
            ))}
          </div>
        )}
      </div>
      <span className="measure player-t">{t.toFixed(1)} / {c.duration.toFixed(0)} s</span>
      <div className="seg player-rate" role="group" aria-label="Playback rate">
        {RATES.map((r) => (
          <button key={r} aria-pressed={c.rate === r} onClick={() => c.setRate(r)}>{r === 0.25 ? '¼' : r === 0.5 ? '½' : r}×</button>
        ))}
      </div>
      <span className="player-warp" data-on={(c.playing && warp < 0.99) || undefined} aria-live="polite" title="Playback slows to 0.35× within ±0.6 s of the selected conflict">
        {c.playing && warp < 0.99 ? <><Icon name="alert" size={14} /> near-miss <span className="measure">{(c.rate * warp).toFixed(2)}×</span></> : null}
      </span>
    </div>
  );
}
