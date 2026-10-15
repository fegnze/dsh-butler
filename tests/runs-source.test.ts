import { expect, test } from 'bun:test';
import { applyDrop, applyRun, edgeState, startedSince, visibleRuns } from '../src/ui/runs-source.ts';

// The console's workflow section is an observation area for SDK runner
// events (RunStore → /runs + /runs/stream). These are its pure reducers.
const run = (runId: string, status: string, at: number, extra: Record<string, unknown> = {}) => ({
  runId, workflow: 'w', title: `t-${runId}`, source: 'cli', status, startedAt: at, endedAt: status === 'running' ? undefined : at + 1,
  currentIndex: 0, steps: [{ name: 's1', status: status === 'running' ? 'running' : 'success' }], ...extra,
});

test('a run event upserts by runId; running first (newest start), then finished (newest end)', () => {
  let runs = new Map();
  runs = applyRun(runs, run('a', 'success', 10));
  runs = applyRun(runs, run('b', 'running', 5));
  runs = applyRun(runs, run('c', 'error', 20));
  runs = applyRun(runs, run('d', 'running', 8));
  expect(visibleRuns(runs, new Set()).map((r) => r.runId)).toEqual(['d', 'b', 'c', 'a']);
  runs = applyRun(runs, run('b', 'success', 30));
  expect(runs.size).toBe(4);
  expect(visibleRuns(runs, new Set()).map((r) => r.runId)).toEqual(['d', 'b', 'c', 'a']);
  expect(runs.get('b').status).toBe('success');
});

test('drop removes ids; dismissed runs are hidden; malformed events are ignored', () => {
  let runs = applyRun(new Map(), run('a', 'error', 1));
  runs = applyRun(runs, run('b', 'success', 2));
  expect(visibleRuns(runs, new Set(['a'])).map((r) => r.runId)).toEqual(['b']);
  runs = applyDrop(runs, { ids: ['b', 'zzz'] });
  expect([...runs.keys()]).toEqual(['a']);
  for (const bad of [null, {}, { runId: '' }, { runId: 'x', steps: 'no' }, 'str']) {
    expect(applyRun(runs, bad as never)).toBe(runs);
  }
  expect(applyDrop(runs, { ids: 'nope' } as never)).toBe(runs);
});

test('startedSince reports only runs that began after the baseline was taken', () => {
  const seen = new Set(['a']);
  const runs = [run('a', 'running', 1), run('b', 'running', 2), run('c', 'success', 3)];
  // c finished before we ever saw it (replayed history): not a trigger
  expect(startedSince(seen, runs)).toEqual(['b']);
  expect(startedSince(null, runs)).toEqual([]);
});

test('edgeState: the connector into a step mirrors where the flow is', () => {
  const steps = (...st: string[]) => st.map((status, i) => ({ name: `s${i}`, status }));
  const r = (status: string, s: { name: string; status: string }[]) => ({ status, steps: s });
  // into a running step → flowing; done → solid; untouched → idle
  expect(edgeState(r('running', steps('success', 'running', 'pending')), 1)).toBe('flowing');
  expect(edgeState(r('running', steps('success', 'running', 'pending')), 2)).toBe('idle');
  expect(edgeState(r('success', steps('success', 'success')), 1)).toBe('done');
  expect(edgeState(r('error', steps('success', 'error', 'skipped')), 1)).toBe('error');
  expect(edgeState(r('error', steps('success', 'error', 'skipped')), 2)).toBe('idle');
  // start edge (index 0) and end edge (index = steps.length)
  expect(edgeState(r('running', steps('running')), 0)).toBe('flowing');
  expect(edgeState(r('running', steps('running')), 1)).toBe('idle');
  expect(edgeState(r('success', steps('success')), 1)).toBe('done');
  expect(edgeState(r('error', steps('error')), 1)).toBe('error');
});
