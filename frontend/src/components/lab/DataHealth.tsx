import type { Health } from '../../lib/lab/metrics';
import { JUMP_MPS } from '../../lib/lab/metrics';
import type { Quality } from '../../lib/lab/quality';
import { Icon } from '../Icon';
import MetricInfo from '../MetricInfo';
import Info from '../Info';
import { CONFIDENCE_SPEC } from '../../lib/lab/specs';

/** One-line data-quality verdict for the site's trajectory file, computed in the browser from the served JSON. */
export default function DataHealth({ h, repaired, hz, quality, classes = [] }: { h: Health; repaired: { n: number; of: number } | null; hz: number; quality: Quality | null; classes?: { cls: string; n: number }[] }) {
  const peds = classes.find((c) => c.cls === 'pedestrian')?.n ?? 0, bikes = classes.find((c) => c.cls === 'bicycle')?.n ?? 0;
  const ok = h.completeness >= 99.5 && h.longestGapS < 0.5;
  const ghosts = quality?.byId.size ?? 0, idSwitch = quality ? new Set(quality.windows.filter((w) => w.reason === 'id_switch').map((w) => w.id)).size : 0;
  return (
    <section className="dh panel" aria-label="Data health">
      <div className="dh-k">
        <span className="status" data-s={ok ? 'ok' : 'warn'}><Icon name={ok ? 'ok' : 'warning'} size={14} /> Data health</span>
        <Info label="About data health" title="Data health">
          <p>Computed in the browser from the served trajectory file: {h.samples.toLocaleString()} of {h.expected.toLocaleString()} samples expected at {hz} Hz, {h.gaps} gaps longer than 1.5 frames.</p>
          <p>Position jumps: steps whose position-implied speed differs from the reported speed by more than {(JUMP_MPS * 3.281).toFixed(1)} ft/s ({h.jumpSamples} steps), i.e. ID switches or position errors.</p>
          <p>Duplicates: tracks whose oriented footprint overlaps another vehicle's for ≥ 1 s (Coifman &amp; Li 2017, Punzo et al. 2011). The track that jumped onto the other is an ID switch ({idSwitch}); otherwise the later-starting detection is the duplicate. {quality ? `${quality.windows.length} windows, ${quality.hiddenS.toFixed(0)} s of track time` : ''} are faded out of every view while they overlap; nothing is removed from the data, and conflicts between a duplicate and its host are flagged in the table and excluded from the critical count.</p>
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
        <div title={quality ? `${ghosts} tracks faded out while they duplicate another vehicle (${idSwitch} ID switches); ${quality.hiddenS.toFixed(0)} s of track time in total` : ''}>
          <dt>Duplicates</dt><dd className="measure">{quality ? ghosts : '—'}<small>/ {h.tracks}</small></dd>
        </div>
        <div>
          <dt>High confidence <MetricInfo spec={CONFIDENCE_SPEC} /></dt><dd className="measure">{h.highConfidence.toFixed(0)}<small>%</small></dd>
        </div>
        {classes.length > 0 && (
          <div title={classes.map((c) => `${c.n} ${c.cls}`).join(', ')}>
            <dt><Icon name="pedestrian" size={12} /> Pedestrians</dt><dd className="measure">{peds}<small>{bikes ? `+ ${bikes} bikes` : `/ ${h.tracks}`}</small></dd>
          </div>
        )}
        <div title="Tracks the repair benchmark below cut with simulated occlusion gaps and rebuilt (Kalman CA + RTS)">
          <dt>Repaired</dt><dd className="measure">{repaired ? repaired.n : '—'}<small>{repaired ? `/ ${repaired.of}` : ''}</small></dd>
        </div>
      </dl>
    </section>
  );
}
