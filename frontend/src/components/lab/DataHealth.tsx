import type { Health } from '../../lib/lab/metrics';
import { JUMP_MPS } from '../../lib/lab/metrics';
import { Icon } from '../Icon';
import MetricInfo from '../MetricInfo';
import Info from '../Info';
import { CONFIDENCE_SPEC } from '../../lib/lab/specs';

/** One-line data-quality verdict for the site's trajectory file, computed in the browser from the served JSON. */
export default function DataHealth({ h, repaired, hz }: { h: Health; repaired: { n: number; of: number } | null; hz: number }) {
  const ok = h.completeness >= 99.5 && h.longestGapS < 0.5;
  return (
    <section className="dh panel" aria-label="Data health">
      <div className="dh-k">
        <span className="status" data-s={ok ? 'ok' : 'warn'}><Icon name={ok ? 'ok' : 'warning'} size={14} /> Data health</span>
        <Info label="About data health" title="Data health">
          <p>Computed in the browser from the served trajectory file: {h.samples.toLocaleString()} of {h.expected.toLocaleString()} samples expected at {hz} Hz, {h.gaps} gaps longer than 1.5 frames.</p>
          <p>Position jumps: steps whose position-implied speed differs from the reported speed by more than {(JUMP_MPS * 3.281).toFixed(1)} ft/s ({h.jumpSamples} steps), i.e. ID switches or position errors.</p>
          <p>Repaired: tracks the repair benchmark cut with simulated occlusion gaps and rebuilt (Kalman CA + RTS).</p>
        </Info>
      </div>
      <dl className="dh-items">
        <div title={`${h.samples.toLocaleString()} of ${h.expected.toLocaleString()} samples expected at ${hz} Hz between each track's first and last frame`}>
          <dt>Complete</dt><dd className="measure">{h.completeness.toFixed(1)}<small>%</small></dd>
        </div>
        <div title={`${h.gaps} gaps longer than 1.5 frames`}>
          <dt>Longest gap</dt><dd className="measure">{h.longestGapS.toFixed(1)}<small>s</small></dd>
        </div>
        <div title={`Tracks with at least one step whose position-implied speed differs from the reported speed by more than ${(JUMP_MPS * 3.281).toFixed(1)} ft/s (${h.jumpSamples} steps): ID switches or position jumps`}>
          <dt>Jumps</dt><dd className="measure">{h.jumpTracks}<small>/ {h.tracks}</small></dd>
        </div>
        <div>
          <dt>High confidence <MetricInfo spec={CONFIDENCE_SPEC} /></dt><dd className="measure">{h.highConfidence.toFixed(0)}<small>%</small></dd>
        </div>
        <div title="Tracks the repair benchmark below cut with simulated occlusion gaps and rebuilt (Kalman CA + RTS)">
          <dt>Repaired</dt><dd className="measure">{repaired ? repaired.n : '—'}<small>{repaired ? `/ ${repaired.of}` : ''}</small></dd>
        </div>
      </dl>
    </section>
  );
}
