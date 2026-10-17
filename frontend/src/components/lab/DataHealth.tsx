import type { Health } from '../../lib/lab/metrics';
import { JUMP_MPS } from '../../lib/lab/metrics';
import { Icon } from '../Icon';
import MetricInfo, { ProvChip } from '../MetricInfo';
import { CONFIDENCE_SPEC } from '../../lib/lab/specs';

/** One-line data-quality verdict for the site's trajectory file, computed in the browser from the served JSON. */
export default function DataHealth({ h, repaired, hz }: { h: Health; repaired: { n: number; of: number } | null; hz: number }) {
  const ok = h.completeness >= 99.5 && h.longestGapS < 0.5;
  return (
    <section className="dh panel" aria-label="Data health">
      <div className="dh-k">
        <span className="status" data-s={ok ? 'ok' : 'warn'}><Icon name={ok ? 'ok' : 'warning'} size={14} /> Data health</span>
        <ProvChip kind="derived" />
      </div>
      <dl className="dh-items">
        <div title={`${h.samples.toLocaleString()} of ${h.expected.toLocaleString()} samples expected at ${hz} Hz between each track's first and last frame`}>
          <dt>Frame completeness</dt><dd className="measure">{h.completeness.toFixed(1)}<small>%</small></dd>
        </div>
        <div title={`${h.gaps} gaps longer than 1.5 frames`}>
          <dt>Longest gap</dt><dd className="measure">{h.longestGapS.toFixed(1)}<small>s</small></dd>
        </div>
        <div title={`Tracks with at least one step whose position-implied speed differs from the reported speed by more than ${JUMP_MPS} m/s (${h.jumpSamples} steps): ID switches or position jumps`}>
          <dt>Position jumps</dt><dd className="measure">{h.jumpTracks}<small>of {h.tracks} tracks</small></dd>
        </div>
        <div>
          <dt>High confidence <MetricInfo spec={CONFIDENCE_SPEC} /></dt><dd className="measure">{h.highConfidence.toFixed(0)}<small>% of samples</small></dd>
        </div>
        <div title="Tracks the repair benchmark below cut with simulated occlusion gaps and rebuilt (Kalman CA + RTS)">
          <dt>Tracks repaired</dt><dd className="measure">{repaired ? repaired.n : '—'}<small>{repaired ? `of ${repaired.of} · simulated gaps` : ''}</small></dd>
        </div>
      </dl>
    </section>
  );
}
