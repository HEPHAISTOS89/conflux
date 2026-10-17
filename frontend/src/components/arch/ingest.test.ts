import { describe, expect, it } from 'vitest';
import { findTriggeredRun, minutesUntil, outcomeOf } from './ingest';
import type { PlatformRun } from '../../lib/types';

const r = (key: string, detail: Record<string, unknown>): PlatformRun => ({ key, size: 1, last_modified: '', detail });

describe('matching the run record to the trigger', () => {
  const base = new Set(['old']);
  it('prefers the manual record carrying our requested_at', () => {
    const runs = [r('new-sched', { job: 'ingest', trigger: 'schedule', status: 'succeeded' }), r('mine', { job: 'ingest', trigger: 'manual', requested_at: 'T1', status: 'running' })];
    expect(findTriggeredRun(runs, base, 'T1')?.key).toBe('mine');
  });
  it('ignores old records, other jobs and someone else\'s manual run', () => {
    const runs = [r('old', { job: 'ingest', status: 'succeeded' }), r('t', { job: 'trajectories', status: 'succeeded' }),
      r('other', { job: 'ingest', trigger: 'manual', requested_at: 'T0', status: 'succeeded' })];
    expect(findTriggeredRun(runs, base, 'T1')).toBeUndefined();
  });
  it('accepts a new record from a Lambda that predates the trigger field', () => {
    expect(findTriggeredRun([r('new', { job: 'ingest', status: 'succeeded' })], base, 'T1')?.key).toBe('new');
  });
  it('outcome is only success when the record says succeeded', () => {
    expect(outcomeOf(r('a', { status: 'succeeded' }))).toBe('succeeded');
    expect(outcomeOf(r('a', { status: 'ok' }))).toBeNull();
    expect(outcomeOf(undefined)).toBeNull();
  });
  it('minutes until the cooldown ends', () => {
    const now = Date.parse('2026-10-17T12:00:00Z');
    expect(minutesUntil('2026-10-17T12:29:01Z', now)).toBe(30);
    expect(minutesUntil('2026-10-17T12:00:10Z', now)).toBe(1);
    expect(minutesUntil('2026-10-17T11:59:00Z', now)).toBe(0);
    expect(minutesUntil(null, now)).toBe(0);
  });
});
