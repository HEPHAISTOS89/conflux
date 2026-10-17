import { useClock } from '../lib/traj';
import { Icon } from './Icon';

/** Transport controls bound to the page clock. */
export default function Player({ label = 'Replay' }: { label?: string }) {
  const c = useClock();
  return (
    <div className="player" role="group" aria-label={`${label} controls`}>
      <button className="btn" onClick={c.toggle} aria-pressed={c.playing}>
        <Icon name={c.playing ? 'pause' : 'play'} size={16} /> {c.playing ? 'Pause' : 'Play'}
      </button>
      <input
        type="range" min={0} max={c.duration} step={0.1} value={c.t}
        onChange={(e) => c.setT(Number(e.target.value))}
        aria-label="Time in replay window (seconds)"
      />
      <span className="num player-t">{c.t.toFixed(1)} / {c.duration.toFixed(0)} s</span>
      <div className="seg" role="group" aria-label="Playback rate">
        {[0.5, 1, 2, 4].map((r) => (
          <button key={r} aria-pressed={c.rate === r} onClick={() => c.setRate(r)}>{r}×</button>
        ))}
      </div>
    </div>
  );
}
