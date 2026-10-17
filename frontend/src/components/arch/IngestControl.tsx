import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../Icon';
import Info from '../Info';
import { nf } from '../../lib/format';
import type { PlatformRun, PlatformStatus } from '../../lib/types';
import {
  IngestRefusal, POLL_MS, TIMEOUT_MS, findTriggeredRun, getIngestState, minutesUntil, outcomeOf, startIngest,
} from './ingest';

type UI =
  | { k: 'checking' }
  | { k: 'unavailable'; message: string }
  | { k: 'ready' }
  | { k: 'cooldown'; until: string }
  | { k: 'starting' }
  | { k: 'running'; requestedAt: string; nextAllowed: string; t0: number; run?: PlatformRun; pollError?: string }
  | { k: 'succeeded'; run: PlatformRun; until: string }
  | { k: 'failed'; message: string; run?: PlatformRun; until?: string };

const utc = (iso?: string) => (iso ? `${iso.replace(/.*T(\d{2}:\d{2}:\d{2}).*/, '$1')} UTC` : '');
const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
const inMinutes = (iso: string, now: number) => {
  const m = minutesUntil(iso, now);
  return m <= 1 ? 'in under a minute' : `in ${m} min`;
};

/**
 * Run ingest: POST /api/v1/ops/ingest invokes the ingest Lambda asynchronously; the control then polls
 * /platform/status every 3 s until the run record for this request says succeeded or failed (3 min limit).
 * Success is only ever shown from a run record whose status is "succeeded".
 */
export default function IngestControl({ data, refresh }: { data?: PlatformStatus; refresh: () => Promise<PlatformStatus> }) {
  const [ui, setUi] = useState<UI>({ k: 'checking' });
  const [now, setNow] = useState(() => Date.now());
  const busy = useRef(false);
  const dataRef = useRef(data); dataRef.current = data;

  const check = useCallback(async () => {
    try {
      const s = await getIngestState();
      if (s.code === 'aws_only') setUi({ k: 'unavailable', message: s.message });
      else if (!s.available && s.next_allowed_at) setUi({ k: 'cooldown', until: s.next_allowed_at });
      else setUi({ k: 'ready' });
    } catch (e) {
      if (e instanceof IngestRefusal && e.status === 404) { setUi({ k: 'unavailable', message: 'The on-demand ingest endpoint is not deployed on this API yet; the weekly EventBridge run is unaffected.' }); return; }
      setUi({ k: 'failed', message: `Could not read the ingest state: ${(e as Error).message}` });
    }
  }, []);
  useEffect(() => { check(); }, [check]);

  // Clock: every second while running (elapsed), every 15 s while cooling down (minutes left).
  const ticking = ui.k === 'running' || ui.k === 'cooldown' || ((ui.k === 'succeeded' || ui.k === 'failed') && 'until' in ui && !!ui.until);
  useEffect(() => {
    if (!ticking) return;
    const id = window.setInterval(() => setNow(Date.now()), ui.k === 'running' ? 1000 : 15000);
    return () => clearInterval(id);
  }, [ticking, ui.k]);
  // Cooldown elapsed: ask the server again rather than assume.
  useEffect(() => {
    if ((ui.k === 'cooldown' || ui.k === 'succeeded') && minutesUntil(ui.until, now) === 0) check();
  }, [ui, now, check]);

  // Poll for the run record while running.
  useEffect(() => {
    if (ui.k !== 'running') return;
    const { requestedAt, nextAllowed: until, t0 } = ui;
    const baseline = new Set((dataRef.current?.runs ?? []).map((r) => r.key));
    let alive = true, timer = 0;
    const poll = async () => {
      let st: PlatformStatus | undefined;
      try { st = await refresh(); } catch (e) {
        if (alive) setUi((u) => (u.k === 'running' ? { ...u, pollError: (e as Error).message } : u));
      }
      if (!alive) return;
      const run = st ? findTriggeredRun(st.runs, baseline, requestedAt) : undefined;
      const out = outcomeOf(run);
      if (out === 'succeeded' && run) { busy.current = false; setUi({ k: 'succeeded', run, until }); return; }
      if (out === 'failed' && run) {
        busy.current = false;
        const d = run.detail ?? {};
        setUi({ k: 'failed', run, message: `${d.error ?? 'Error'}${d.message ? `: ${d.message}` : ''}` });
        // The server decides when a retry is allowed (5 min after a failed run, for Lambda's own retries).
        getIngestState().then((s) => {
          if (!s.available && s.next_allowed_at) setUi((u) => (u.k === 'failed' ? { ...u, until: s.next_allowed_at! } : u));
        }).catch(() => {});
        return;
      }
      if (Date.now() - t0 > TIMEOUT_MS) {
        busy.current = false;
        setUi({ k: 'failed', run, until, message: run
          ? 'The run is still marked running after 3 minutes. The run table keeps updating; check CloudWatch logs for roadscope-ingest.'
          : 'No run record appeared within 3 minutes. The Lambda accepted the request but did not report back.' });
        return;
      }
      setUi((u) => (u.k === 'running' ? { ...u, run, pollError: st ? undefined : u.pollError } : u));
      timer = window.setTimeout(poll, POLL_MS);
    };
    timer = window.setTimeout(poll, POLL_MS);
    return () => { alive = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.k === 'running' ? ui.requestedAt : null]);

  const run = async () => {
    if (busy.current) return; // no duplicate submissions, even on a double click
    busy.current = true;
    setUi({ k: 'starting' });
    try {
      const r = await startIngest();
      setUi({ k: 'running', requestedAt: r.requested_at, nextAllowed: r.next_allowed_at, t0: Date.now() });
    } catch (e) {
      busy.current = false;
      if (e instanceof IngestRefusal) {
        if (e.code === 'aws_only') { setUi({ k: 'unavailable', message: e.message }); return; }
        if (e.status === 429) { setUi({ k: 'cooldown', until: new Date(Date.now() + (e.retryAfterS ?? 60) * 1000).toISOString() }); return; }
      }
      setUi({ k: 'failed', message: (e as Error).message });
    }
  };

  const k = ui.k;
  const isBusy = k === 'starting' || k === 'running';
  const blocked = k === 'checking' || k === 'unavailable' || k === 'cooldown' || k === 'succeeded' || (k === 'failed' && !!ui.until && minutesUntil(ui.until) > 0);
  const reason = k === 'unavailable' ? 'Not available on this deployment'
    : (k === 'cooldown' || k === 'succeeded' || k === 'failed') && 'until' in ui && ui.until ? `Next run allowed ${inMinutes(ui.until, Date.now())}`
    : k === 'checking' ? 'Checking whether a run is allowed' : undefined;
  const label = k === 'starting' ? 'Starting…' : k === 'running' ? 'Running…' : k === 'failed' && !blocked ? 'Retry' : 'Run ingest';

  const until = (k === 'cooldown' || k === 'succeeded' || k === 'failed') && 'until' in ui && ui.until ? minutesUntil(ui.until, now) : null;
  const next = until != null && (k !== 'failed' || blocked) ? <span className="pf-ops-next" title={`Next run allowed ${inMinutes((ui as { until: string }).until, now)}`}><Icon name="clock" size={14} /><span className="measure">{until <= 1 ? '< 1' : until} min</span></span> : null;

  return (
    <section className="pf-ops" aria-labelledby="pf-ops-h" data-k={k}>
      <div className="pf-ops-t">
        <h2 id="pf-ops-h">Ingest on demand</h2>
        <Info label="About Run ingest" title="Ingest on demand">
          <p>Starts <span className="measure">roadscope-ingest</span> on AWS Lambda now, the same job EventBridge runs every Monday. Asynchronous: the control polls the run record every 3 s and only reports success from a record marked succeeded. One manual run per 30 minutes.</p>
          {k === 'unavailable' && <p>{ui.message}</p>}
        </Info>
      </div>
      <div className="pf-ops-act">
        <button type="button" className="btn" onClick={blocked ? undefined : run} aria-busy={isBusy || undefined} disabled={isBusy}
          aria-disabled={blocked || undefined} title={reason}>
          <Icon name={isBusy ? 'spinner' : k === 'failed' && !blocked ? 'reset' : 'upload'} size={16} />{label}
        </button>
        <p className="pf-ops-msg" role="status" aria-live="polite" key={k}>
          {k === 'checking' && <>Checking…</>}
          {k === 'unavailable' && <><span className="pf-ops-dot" data-s="idle" /><span title={ui.message}><b>Unavailable</b> here</span></>}
          {k === 'ready' && <><span className="pf-ops-dot" data-s="ok" /><span>Ready</span></>}
          {k === 'cooldown' && <><span className="pf-ops-dot" data-s="warn" /><span>Cooling down</span>{next}</>}
          {k === 'starting' && <><Icon name="spinner" size={16} /><span>Sending…</span></>}
          {k === 'running' && <><Icon name="spinner" size={16} /><span>
            {ui.run ? <>Run <span className="measure">{ui.run.detail?.run_id}</span></> : <>Invoked <span className="measure">{utc(ui.requestedAt)}</span></>}
            {' · '}<span className="measure">{clock(now - ui.t0)}</span>{ui.pollError ? ` · status check failed (${ui.pollError}), retrying` : ''}
          </span></>}
          {k === 'succeeded' && <><Icon name="ok" size={16} weight="fill" /><span title={`Run ${ui.run.detail?.run_id ?? ''}. Figures, runs and freshness below are refreshed.`}>
            <b>Succeeded</b> · {typeof ui.run.detail?.records === 'number' ? <><span className="measure">{nf(ui.run.detail.records)}</span> records</> : 'data rewritten'}
            {typeof ui.run.detail?.seconds === 'number' ? <> · <span className="measure">{nf(ui.run.detail.seconds, 1)} s</span></> : null}
          </span>{next}</>}
          {k === 'failed' && <><Icon name="fail" size={16} weight="fill" /><span>
            <b>Failed.</b> {ui.message}{ui.run?.detail?.run_id ? <> (run <span className="measure">{ui.run.detail.run_id}</span>)</> : null}
          </span>{next}</>}
        </p>
      </div>
    </section>
  );
}
