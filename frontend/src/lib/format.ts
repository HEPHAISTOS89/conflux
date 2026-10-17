export const nf = (v: number | null | undefined, d = 0) =>
  v == null || Number.isNaN(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

export const SEV_LABEL: Record<string, string> = { K: 'K · Fatal', A: 'A · Suspected serious', B: 'B · Suspected minor', C: 'C · Possible', O: 'O · No injury' };
export const SEV_COLOR: Record<string, string> = { K: 'var(--sev-k)', A: 'var(--sev-a)', B: 'var(--sev-b)', C: 'var(--sev-c)', O: 'var(--sev-o)' };
/** KABCO hex values, matching --sev-k..o in base.css (for map paint and canvas, which cannot read CSS vars). */
export const SEV_HEX: Record<string, string> = { K: '#ff5a4f', A: '#f08159', B: '#e9a35f', C: '#d9c66f', O: '#7c817c' };

/** Sequential ramp for "excess expected crashes" (EB) on the dark basemap: dim grey below zero, sand → red above. */
export const EB_STOPS: [number, string][] = [[-0.3, '#3a3b39'], [0, '#4a4c48'], [0.1, '#d9c66f'], [0.4, '#e9a35f'], [0.8, '#f08159'], [1.5, '#ff5a4f']];

/** Chart and canvas palette for the charcoal ground (canvas and map paint cannot read CSS vars). */
export const CHART = {
  graticule: '#2a2b29',
  rule: '#353634',
  axis: '#9a9b96',
  ink: '#e6e7e3',
  ink2: '#c8c9c4',
  nb: '#e6e7e3',
  sb: '#8fb3c9',
  eb: '#d9c66f',
  wb: '#9fc4a8',
  accent: '#8fa68e',
  caution: '#e0a83a',
  critical: '#f08159',
  serious: '#e9a35f',
  moderate: '#d9c66f',
  ground: '#121312',
  areaFill: '#4a4c48',
  truckFill: '#7d7356',
  midday: '#b6c48a',
  pm: '#d99aa5',
} as const;

/** Severity colour for a surrogate-safety conflict: red for critical, amber otherwise. */
export const conflictColor = (sev?: string | null) => (sev === 'critical' ? CHART.critical : CHART.caution);

export function bboxOf(coords: number[][]): [[number, number], [number, number]] {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [x, y] of coords) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
  return [[a, b], [c, d]];
}
