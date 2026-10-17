import { describe, expect, it } from 'vitest';
import { deriveLive, EDGES } from './model';
import { SIM_OFF, accrued, downstream, scenarioView, simReduce, writers, type SimState, type Target } from './scenario';
import type { PlatformStatus } from '../../lib/types';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const status: PlatformStatus = {
  on_aws: true, data_source: 's3://b/curated/', errors: [],
  manifest: { generated_at: '2026-10-17T08:00:30Z', sources: [{ id: 'aadt', records: 5785, fetched_at: '2026-10-17T08:00:29Z' }] } as any,
  runs: [{ key: 'curated/runs/1.json', size: 1, last_modified: '2026-10-17T08:00:37Z', detail: { run_id: '20261017T080026Z', job: 'ingest', status: 'succeeded', finished_at: '2026-10-17T08:00:36Z', seconds: 9.9 } }],
  metrics: { window_days: 7, start: '', end: '', functions: { api: { name: 'roadscope-api', invocations: { total: 312, daily: [] }, errors: { total: 0, daily: [] }, duration_p95_ms: { max_daily: 760, daily: [] } } } },
};
const live = deriveLive(status, NOW);
const run = (target: Target, seconds: number, reqPerMin = 10) => {
  let s = simReduce(SIM_OFF, { type: 'start', target });
  for (let i = 0; i < seconds; i++) s = simReduce(s, { type: 'tick', minutes: 5, reqPerMin });
  return s;
};

describe('dependency graph', () => {
  it('follows data edges downstream, not metrics', () => {
    expect(new Set(downstream('s3'))).toEqual(new Set(['api', 'apigw', 'vercel', 'bedrock', 'cf']));
    expect(downstream('ingest')).toContain('vercel');
    expect(downstream('api')).not.toContain('cw');
    expect(new Set(writers('s3'))).toEqual(new Set(['ingest', 'ec2']));
  });
  it('every deployed downstream component of the failed one shows a consequence', () => {
    for (const t of ['ingest', 'api', 's3', 'ec2'] as Target[]) {
      const v = scenarioView(run(t, 2), live, 1)!;
      for (const id of downstream(t).filter((x) => x !== 'cf')) expect(v.impacts[id], `${t} → ${id}`).toBeDefined();
      expect(v.impacts[t].state).toBe('down');
    }
  });
  it('edge ids are unique', () => { expect(new Set(EDGES.map((e) => e.id)).size).toBe(EDGES.length); });
});

describe('reducer', () => {
  it('starts, accrues, restores, drains and resets completely', () => {
    let s = run('api', 6, 10);
    expect(s).toMatchObject({ target: 'api', phase: 'down', t: 30, backlog: 300 });
    s = simReduce(s, { type: 'restore' });
    expect(s.phase).toBe('restoring');
    const seen: number[] = [];
    for (let i = 0; i < 10 && s.phase !== 'off'; i++) { s = simReduce(s, { type: 'tick', minutes: 5, reqPerMin: 10 }); seen.push(s.backlog); }
    expect(s).toEqual(SIM_OFF);
    expect(seen.length).toBeLessThanOrEqual(4);
    expect(scenarioView(s, live, 1)).toBeNull();
  });
  it('a new target re-runs the scenario from T+0', () => {
    const s = simReduce(run('api', 4), { type: 'start', target: 's3' });
    expect(s).toMatchObject({ target: 's3', phase: 'down', t: 0, backlog: 0 });
  });
  it('reset from any phase is complete', () => {
    expect(simReduce(run('ingest', 3), { type: 'reset' })).toEqual(SIM_OFF);
    expect(simReduce(simReduce(run('ec2', 3), { type: 'restore' }), { type: 'reset' })).toEqual(SIM_OFF);
  });
  it('ticks and restore do nothing when off', () => {
    expect(simReduce(SIM_OFF, { type: 'tick', minutes: 5, reqPerMin: 1 })).toBe(SIM_OFF);
    expect(simReduce(SIM_OFF, { type: 'restore' })).toBe(SIM_OFF);
  });
  it('ingest follows the async retry schedule (0, 1, 3 min) into the DLQ', () => {
    expect([0, 0.5, 1, 2, 3, 30].map((t) => accrued('ingest', t, 0))).toEqual([1, 1, 2, 2, 3, 3]);
  });
});

describe('scenario view', () => {
  const view = (t: Target, sec: number, rate: number | null = 10) => scenarioView(run(t, sec, rate ?? 0) as SimState, live, rate)!;
  it('ingest outage: errors alarm at once, DLQ alarm after the last retry, data age grows', () => {
    const v0 = scenarioView(simReduce(SIM_OFF, { type: 'start', target: 'ingest' }), live, 1)!;
    expect(v0.alarms.find((a) => a.name === 'roadscope-ingest-dlq')!.state).toBe('PENDING');
    const v = view('ingest', 2);
    expect(v.alarms.map((a) => a.state)).toEqual(['ALARM', 'ALARM']);
    expect(v.queue).toMatchObject({ label: 'Messages in DLQ', value: 1 });
    expect(v.readouts.lastIngestH! - live.readouts.lastIngestH!).toBeCloseTo(10 / 60);
    expect(v.impacts.cw.state).toBe('down');
  });
  it('API outage: stages up drops, p95 has no value, alarm depends on real traffic', () => {
    const busy = view('api', 2, 10);
    expect(busy.readouts.up).toBeLessThan(live.readouts.up);
    expect(busy.readouts.p95).toBeNull();
    expect(busy.alarms[0].state).toBe('ALARM');
    expect(busy.impacts.vercel.chip).toMatch(/Shell/);
    expect(busy.impacts.bedrock.chip).toMatch(/Ask unavailable/);
    const quiet = view('api', 2, 312 / (7 * 1440));
    expect(quiet.alarms[0].state).toBe('OK');
    expect(quiet.alarms[0].why).toMatch(/unalarmed/);
  });
  it('S3 outage: handled 500s do not trip the API alarm, writers fail', () => {
    const v = view('s3', 3);
    expect(v.alarms.find((a) => a.name === 'roadscope-api-errors')!.state).toBe('OK');
    expect(v.impacts.ingest.state).toBe('warn');
    expect(v.impacts.ec2.state).toBe('warn');
    expect(v.queue.value).toBe(150);
  });
  it('EC2 outage: one missed job, no alarm covers it', () => {
    const v = view('ec2', 3);
    expect(v.queue).toMatchObject({ value: 1, label: 'Missed worker jobs' });
    expect(v.alarms.every((a) => a.state === 'OK')).toBe(true);
    expect(v.impacts.cw.chip).toBe('No alarm firing');
  });
  it('restoring: the failed component is back, alarms clear, queue drains', () => {
    const s = simReduce(run('api', 3), { type: 'restore' });
    const v = scenarioView(s, live, 10)!;
    expect(v.impacts.api.state).toBe('ok');
    expect(v.alarms.every((a) => a.state === 'OK')).toBe(true);
    expect(v.queue.draining).toBe(true);
  });
  it('local mode never invents a request rate', () => {
    const v = view('api', 3, null);
    expect(v.queue.value).toBe(0);
    expect(v.alarms[0].why).toMatch(/unknown in local mode/);
  });
});
