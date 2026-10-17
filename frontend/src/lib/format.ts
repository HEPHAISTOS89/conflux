export const nf = (v: number | null | undefined, d = 0) =>
  v == null || Number.isNaN(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

export const SEV_LABEL: Record<string, string> = { K: 'K · Fatal', A: 'A · Suspected serious', B: 'B · Suspected minor', C: 'C · Possible', O: 'O · No injury' };
export const SEV_COLOR: Record<string, string> = { K: 'var(--sev-k)', A: 'var(--sev-a)', B: 'var(--sev-b)', C: 'var(--sev-c)', O: 'var(--sev-o)' };
export const SEV_HEX: Record<string, string> = { K: '#6e120d', A: '#b3261e', B: '#d4612a', C: '#d9a038', O: '#98a1a7' };

/** Sequential ramp for "excess expected crashes" (EB): grey below zero, amber → red above. */
export const EB_STOPS: [number, string][] = [[-0.5, '#b8bfb6'], [0, '#c9cfc6'], [0.5, '#d9a038'], [1.5, '#d4612a'], [3, '#b3261e'], [4.5, '#6e120d']];

export function bboxOf(coords: number[][]): [[number, number], [number, number]] {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [x, y] of coords) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
  return [[a, b], [c, d]];
}
