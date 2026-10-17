import type { MetricSpec } from '../../components/MetricInfo';

/** Methodology of the derived track-confidence indicator (HUD and data-health strip). */
export const CONFIDENCE_SPEC: MetricSpec = {
  name: 'Track confidence',
  provenance: 'derived',
  formula: <>c = clamp(1 − RMS(‖Δp‖/Δt − v̄) / 1.5 m/s, 0, 1) × 0.5 if |a| &gt; 14.8 ft/s² × 0.6 if a frame gap, over ±0.5 s</>,
  threshold: 'High ≥ 80 %, medium ≥ 50 %, low below',
  source: 'Served NGSIM track (Savitzky–Golay smoothed positions, speed and acceleration)',
  note: 'Kinematic consistency: speed implied by successive positions against the reported speed. Clean tracks score ~0.03 m/s; ID switches and position jumps score metres per second. A data-quality indicator, not a detector score; NGSIM carries no per-sample confidence.',
};
