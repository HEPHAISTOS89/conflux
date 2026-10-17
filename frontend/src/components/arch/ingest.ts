import type { PlatformRun, PlatformStatus } from '../../lib/types';
import { API_BASE } from '../../lib/api';

/** Client side of POST /api/v1/ops/ingest: the request, its refusals, and matching the run record it produced. */

export interface IngestState {
  available: boolean; code: 'ready' | 'cooldown' | 'aws_only' | string; message: string;
  retry_after_s: number; next_allowed_at: string | null; cooldown_s: number;
}
export interface IngestAccepted { status: 'accepted'; function: string; requested_at: string; next_allowed_at: string; timeout_s: number }
export class IngestRefusal extends Error {
  constructor(public status: number, public code: string, message: string, public retryAfterS: number | null) { super(message); }
}

const url = (p: string) => `${API_BASE}/api/v1${p}`;

async function refusal(r: Response): Promise<IngestRefusal> {
  let code = `http_${r.status}`, msg = `${r.status} ${r.statusText}`.trim();
  try {
    const b = await r.json();
    const d = b?.detail;
    if (d && typeof d === 'object') { code = d.code ?? code; msg = d.message ?? msg; } else if (typeof d === 'string') msg = d;
  } catch { /* non-JSON body (e.g. a gateway error page) */ }
  const ra = Number(r.headers.get('Retry-After'));
  return new IngestRefusal(r.status, code, msg, Number.isFinite(ra) && ra > 0 ? ra : null);
}

export async function getStatus(signal?: AbortSignal): Promise<PlatformStatus> {
  const r = await fetch(url('/platform/status'), { cache: 'no-store', headers: { Accept: 'application/json' }, signal });
  if (!r.ok) throw await refusal(r);
  return r.json();
}
export async function getIngestState(signal?: AbortSignal): Promise<IngestState> {
  const r = await fetch(url('/ops/ingest'), { cache: 'no-store', headers: { Accept: 'application/json' }, signal });
  if (!r.ok) throw await refusal(r);
  return r.json();
}
/** No body: the server refuses one. */
export async function startIngest(): Promise<IngestAccepted> {
  const r = await fetch(url('/ops/ingest'), { method: 'POST', cache: 'no-store', headers: { Accept: 'application/json' } });
  if (r.status !== 202) throw await refusal(r);
  return r.json();
}

export const POLL_MS = 3000, TIMEOUT_MS = 180_000;

/**
 * The run record this trigger produced: a manual run carrying our requested_at, else (records written before
 * the trigger field existed) an ingest record that was not there when we clicked.
 */
export function findTriggeredRun(runs: PlatformRun[], baseline: ReadonlySet<string>, requestedAt: string): PlatformRun | undefined {
  const ingest = runs.filter((r) => r.detail?.job === 'ingest');
  return ingest.find((r) => r.detail?.trigger === 'manual' && r.detail?.requested_at === requestedAt)
    ?? ingest.find((r) => !baseline.has(r.key) && r.detail?.trigger == null);
}
export type RunOutcome = 'running' | 'succeeded' | 'failed';
export const outcomeOf = (r: PlatformRun | undefined): RunOutcome | null => {
  const s = r?.detail?.status;
  return s === 'running' || s === 'succeeded' || s === 'failed' ? s : null;
};
/** Whole minutes until `iso`, never below 1 while it is in the future. */
export const minutesUntil = (iso: string | null | undefined, now = Date.now()) => {
  const ms = iso ? Date.parse(iso) - now : NaN;
  return Number.isFinite(ms) && ms > 0 ? Math.max(1, Math.ceil(ms / 60000)) : 0;
};
