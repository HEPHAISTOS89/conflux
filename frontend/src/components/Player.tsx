import { useState } from 'react';
import { conflictColor } from '../lib/format';
import { selectConflict, useClock, useClockFrame, useSelection, type ConflictT } from '../lib/traj';
import { Icon } from './Icon';

/** Transport controls bound to the page clock; conflicts appear as severity ticks on the scrubber. */
export default function Player({ label = 'Replay', conflicts }: { label?: string; conflicts?: ConflictT[] }) {
  const c = useClock();
  const sel = useSelection();
  const [t, setT] = useState(c.now());
  useClockFrame((v) => setT(Math.round(v * 10) / 10), []);
  return (
    <div className="player" role="group" aria-label={`${label} controls`}>
      <button className="btn player-go" onClick={c.toggle} aria-pressed={c.playing} title="Play / pause (Space)">
        <span className="player-ic" key={c.playing ? 'pause' : 'play'}><Icon name={c.playing ? 'pause' : 'play'} size={16} /></span> {c.playing ? 'Pause' : 'Play'}
      </button>
      <div className="player-track">
        <input
          type="range" min={0} max={c.duration} step={0.1} value={t}
          onChange={(e) => c.setT(Number(e.target.value))}
          aria-label="Time in replay window (seconds)"
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
      <span className="num player-t">{t.toFixed(1)} / {c.duration.toFixed(0)} s</span>
      <div className="seg" role="group" aria-label="Playback rate">
        {[0.5, 1, 2, 4].map((r) => (
          <button key={r} aria-pressed={c.rate === r} onClick={() => c.setRate(r)}>{r}×</button>
        ))}
      </div>
    </div>
  );
}
