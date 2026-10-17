import { EDGES, NODE, type Live, type NodeState } from './model';

/**
 * Outage simulation, as pure functions so it can be unit-tested. Nothing here touches AWS: it answers
 * "if this component failed, what would the rest of the stack do?" from the dependency graph in ./model,
 * the alarm definitions in infra/cdk and the live traffic rate. The clock is compressed: one real second
 * is SIM_MIN_PER_S simulated minutes.
 */

export type Target = 'ingest' | 'api' | 's3' | 'ec2';
export const TARGETS: { value: Target; label: string }[] = [
  { value: 'ingest', label: 'Lambda · ingest' }, { value: 'api', label: 'Lambda · API' },
  { value: 's3', label: 'S3 data lake' }, { value: 'ec2', label: 'EC2 batch worker' },
];
export const SIM_MIN_PER_S = 5;

export interface SimState { target: Target | null; phase: 'off' | 'down' | 'restoring'; t: number; backlog: number; peak: number }
export const SIM_OFF: SimState = { target: null, phase: 'off', t: 0, backlog: 0, peak: 0 };
export type SimAction =
  | { type: 'start'; target: Target }
  | { type: 'tick'; minutes: number; reqPerMin: number }
  | { type: 'restore' }
  | { type: 'reset' };

/** Lambda async invocation: first attempt, retry after 1 min, second retry 2 min later, then the DLQ. */
export const INGEST_ATTEMPTS_AT = [0, 1, 3];
export const ingestAttempts = (t: number) => INGEST_ATTEMPTS_AT.filter((a) => t >= a).length;

/** Work waiting at time t of an outage (what the counter shows). */
export function accrued(target: Target, t: number, reqPerMin: number): number {
  if (target === 'ingest') return ingestAttempts(t); // failed invocations of the run (≤ 3, then 1 message in the DLQ)
  if (target === 'ec2') return 1; // the job that could not run
  return Math.floor(reqPerMin * t); // API or S3: requests answered with an error
}

export function simReduce(s: SimState, a: SimAction): SimState {
  switch (a.type) {
    case 'start': return { target: a.target, phase: 'down', t: 0, backlog: accrued(a.target, 0, 0), peak: 0 };
    case 'reset': return SIM_OFF;
    case 'restore': return s.phase === 'down' ? { ...s, phase: 'restoring', peak: Math.max(s.backlog, 1) } : s;
    case 'tick': {
      if (!s.target || s.phase === 'off') return s;
      if (s.phase === 'down') {
        const t = s.t + a.minutes;
        return { ...s, t, backlog: accrued(s.target, t, a.reqPerMin) };
      }
      // restoring: the backlog drains in about four ticks, then every indicator returns to live
      const backlog = Math.max(0, s.backlog - Math.max(1, Math.ceil(s.peak / 4)));
      return backlog === 0 ? SIM_OFF : { ...s, backlog };
    }
  }
}

// ---------- dependency graph ----------
const DATA_EDGES = EDGES.filter((e) => e.flow !== 'metrics' && e.status !== 'planned');
/** Every component that reads, directly or not, from `id` (data and API edges, not metrics). */
export function downstream(id: string): string[] {
  const seen = new Set<string>(), stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of DATA_EDGES) if (e.from === cur && !seen.has(e.to) && e.to !== id) { seen.add(e.to); stack.push(e.to); }
  }
  return [...seen];
}
/** Compute stages that write into a store: they cannot finish while it is down. */
export const writers = (id: string) => DATA_EDGES.filter((e) => e.to === id && ['ingest', 'ec2'].includes(e.from)).map((e) => e.from);

export interface Impact { state: NodeState; chip: string; note: string }
export interface Alarm { name: string; rule: string; state: 'ALARM' | 'OK' | 'PENDING'; why: string }
export interface ScenarioView {
  target: Target; title: string; failed: string; phase: SimState['phase']; t: number;
  impacts: Record<string, Impact>; alarms: Alarm[];
  queue: { label: string; value: number; unit: string; draining: boolean };
  readouts: { up: number; of: number; lastIngestH: number | null; p95: number | null };
  consequences: string[];
}

const fmtMin = (m: number) => (m < 60 ? `${Math.round(m)} min` : `${(m / 60).toFixed(m < 600 ? 1 : 0)} h`);

/** What the stack looks like `t` simulated minutes into an outage of `target`, given the live state. */
export function scenarioView(s: SimState, live: Live, reqPerMin: number | null): ScenarioView | null {
  if (!s.target || s.phase === 'off') return null;
  const target = s.target, t = s.t, rate = reqPerMin ?? 0;
  const rateTxt = reqPerMin == null ? 'unknown request rate (local mode)' : `${reqPerMin < 0.1 ? reqPerMin.toFixed(2) : reqPerMin.toFixed(1)} req/min (7-day CloudWatch average)`;
  const impacts: Record<string, Impact> = {};
  const set = (id: string, state: NodeState, chip: string, note: string) => { impacts[id] = { state, chip, note }; };
  const age = live.readouts.lastIngestH;
  const alarms: Alarm[] = [];
  const consequences: string[] = [];
  const errs5 = rate * 5;

  if (target === 'ingest') {
    const n = ingestAttempts(t), dlq = t >= 3;
    set('ingest', 'down', dlq ? 'Failed 3 of 3 · in DLQ' : `Failed attempt ${n} of 3`, 'Every invocation raises; Lambda retries the async event twice, then sends it to the SQS dead-letter queue.');
    set('s3', 'warn', `No refresh · +${fmtMin(t)}`, 'Keeps the last good curated/ objects; nothing new is written. A failed run record is still written.');
    set('api', 'warn', 'Serving last good data', 'Answers normally from curated/, which is getting older.');
    set('apigw', 'warn', 'Passing stale data', 'No errors to callers; the data behind them ages.');
    set('vercel', 'warn', `Data age ${age != null ? fmtMin(age * 60 + t) : '+' + fmtMin(t)}`, 'Pages load; the Last ingest figure and source dates show the age.');
    set('bedrock', 'warn', 'Answers from old data', 'The analyst reads the same aging curated files.');
    alarms.push({ name: 'roadscope-ingest-errors', rule: 'Ingest Errors ≥ 1 in 5 min', state: 'ALARM', why: 'The first failed attempt counts as a Lambda error.' });
    alarms.push({ name: 'roadscope-ingest-dlq', rule: 'DLQ visible messages ≥ 1', state: dlq ? 'ALARM' : 'PENDING', why: dlq ? 'All three attempts failed; the event is in the DLQ.' : `Fires after the last retry (T+3 min).` });
    consequences.push('Weekly refresh of TxDOT crash, AADT and roadway layers stops.', 'Screening, SPF and corridor pages keep serving the previous build.', 'Recovery: fix, then redrive the DLQ message or start a run.');
  } else if (target === 'ec2') {
    set('ec2', 'down', 'Job failed · stopped', 'The monthly job does not finish, so no new trajectories or conflicts are synced.');
    set('s3', 'warn', 'Trajectories not rebuilt', 'NGSIM trajectories, conflicts and repair outputs keep their last build.');
    set('api', 'warn', 'Serving last build', 'Intersection endpoints answer from the previous build.');
    set('apigw', 'warn', 'Passing old trajectories', 'No errors to callers.');
    set('bedrock', 'warn', 'Conflict answers from old build', 'The analyst’s intersection tools read the same previous build.');
    set('vercel', 'warn', 'Intersection lab: old build', 'Crash screening is unaffected; the Intersection lab shows the previous build.');
    alarms.push({ name: 'roadscope-worker-idle', rule: 'Worker CPU < 5 % for 1 h → stop', state: 'OK', why: 'This alarm only stops an idle worker. No alarm covers a missed job: the gap shows in the run history.' });
    consequences.push('Trajectory, conflict (TTC, PET) and repair outputs stop updating.', 'Crash screening, SPF and corridor pages are unaffected.', 'Recovery: start the instance; the job re-runs on boot.');
  } else if (target === 'api') {
    const failed = Math.floor(rate * t);
    set('api', 'down', `Erroring · ${failed} failed`, 'Every invocation crashes or times out (e.g. a bad deploy).');
    set('apigw', 'warn', '5xx to every caller', 'Returns 500/503 for each request it forwards.');
    set('vercel', 'warn', 'Shell only · data fails', 'The app shell is static on Vercel and still loads; every data view shows its error and Retry.');
    set('bedrock', 'warn', 'Ask unavailable', 'The analyst runs inside the API Lambda, so Ask stops answering.');
    const fire = t >= 5 && errs5 >= 5;
    alarms.push({ name: 'roadscope-api-errors', rule: 'API Errors ≥ 5 in 5 min', state: fire ? 'ALARM' : t < 5 ? 'PENDING' : 'OK',
      why: fire ? 'Five-minute error count crossed the threshold.' : t < 5 ? 'First 5-minute period still open.'
        : reqPerMin == null ? 'Request rate unknown in local mode; on AWS the 7-day average decides whether 5 errors arrive in 5 minutes.'
        : `At ${rateTxt} a 5-minute period sees ${errs5.toFixed(errs5 < 1 ? 2 : 1)} errors, below the threshold: a low-traffic outage stays unalarmed.` });
    consequences.push('Every data page shows an error; the app shell still loads from Vercel.', 'Ask is unavailable (its analyst runs in the API Lambda).', 'Ingest and the worker keep writing to S3 unaffected.');
  } else {
    const failed = Math.floor(rate * t);
    set('s3', 'down', `Unreachable · ${failed} failed reads`, 'GetObject and PutObject fail for every prefix.');
    set('api', 'warn', 'HTTP 500 on every read', 'Turns each S3 error into an HTTP 500; the function itself does not crash.');
    set('apigw', 'warn', '5xx to callers', 'Forwards the 500s.');
    set('vercel', 'warn', 'Data views show errors', 'Every data view shows its error and Retry.');
    set('bedrock', 'warn', 'Ask tools fail', 'The analyst cannot read curated files.');
    for (const w of writers('s3')) set(w, 'warn', w === 'ingest' ? 'Next run cannot write' : 'Job sync would fail', 'Its next run fails at the write and records the failure.');
    alarms.push({ name: 'roadscope-api-errors', rule: 'API Errors ≥ 5 in 5 min', state: 'OK', why: 'Handled HTTP 500s are not Lambda errors, so this alarm stays OK. The dashboard’s HTTP API 5xx graph shows the outage.' });
    alarms.push({ name: 'roadscope-ingest-errors', rule: 'Ingest Errors ≥ 1 in 5 min', state: 'OK', why: 'Fires only when the next scheduled run tries to write.' });
    consequences.push('Every data view errors; nothing is lost (bucket is versioned).', 'Ingest and worker runs fail at their write.', 'Gap found: no alarm fires on handled 5xx.');
  }
  const firing = alarms.filter((a) => a.state === 'ALARM').length;
  set('cw', firing ? 'down' : 'warn', firing ? `ALARM · ${alarms.filter((a) => a.state === 'ALARM').map((a) => a.name.replace('roadscope-', '')).join(', ')}` : 'No alarm firing',
    firing ? 'An alarm is in ALARM state.' : 'Metrics change, but no alarm threshold is crossed.');

  const q = target === 'ingest' ? { label: t >= 3 ? 'Messages in DLQ' : 'Failed attempts', value: t >= 3 ? 1 : s.backlog, unit: t >= 3 ? 'msg' : 'of 3' }
    : target === 'ec2' ? { label: 'Missed worker jobs', value: s.backlog, unit: 'job' }
    : { label: 'Failed requests', value: s.backlog, unit: 'req' };
  if (s.phase === 'restoring') {
    // Recovery drains the queue: DLQ redrive, the job re-run, clients retrying.
    q.label = target === 'ingest' ? 'Redriving from DLQ' : target === 'ec2' ? 'Re-running job' : 'Clients retrying';
    q.value = s.backlog;
  }

  if (s.phase === 'restoring') {
    for (const id of Object.keys(impacts)) {
      impacts[id] = id === target
        ? { state: 'ok', chip: `Restored · ${q.label.toLowerCase()} ${s.backlog}`, note: 'Service restored; queued work is being processed.' }
        : id === 'cw' ? { state: 'ok', chip: 'Alarms returning to OK', note: 'No new errors; alarms clear at their next evaluation.' }
        : { state: 'warn', chip: 'Catching up', note: 'Recovers as the backlog drains.' };
    }
    for (const a of alarms) if (a.state !== 'OK') { a.state = 'OK'; a.why = 'Errors stopped; the alarm returns to OK at the next evaluation.'; }
  }

  const ids = Object.keys(live.nodes).filter((id) => NODE[id]?.lane === 'live' && !['cf', 'bedrock'].includes(id));
  const stateOf = (id: string) => impacts[id]?.state ?? live.nodes[id]?.state;
  const up = ids.filter((id) => ['ok', 'idle'].includes(stateOf(id) ?? '')).length;
  return {
    target, title: NODE[target].title, failed: target, phase: s.phase, t, impacts, alarms, consequences,
    queue: { ...q, draining: s.phase === 'restoring' },
    readouts: { up, of: ids.length, lastIngestH: age != null ? age + t / 60 : null, p95: target === 'api' ? null : live.readouts.p95 },
  };
}
