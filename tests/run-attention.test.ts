import { expect, test } from 'bun:test';
import { attentionItems, routeFor, takeFresh } from '../src/ui/run-attention.ts';

// Run attention routes a new run (or a step awaiting the owner) to where the
// owner already is, instead of raising the window. These are its pure parts.
const run = (runId: string, status: string, startedAt: number, steps: { name: string; status: string; confirm?: { token: string } }[] = [{ name: 's', status: 'running' }]) =>
  ({ runId, title: `t-${runId}`, status, startedAt, steps });

test('only runs started after the baseline count; replayed history does not', () => {
  const items = attentionItems([run('old', 'running', 5), run('new', 'running', 20), run('done', 'success', 30)], 10);
  expect(items.map((i) => i.key)).toEqual(['start:new']);
});

test('an awaiting step always counts, keyed by its confirm token', () => {
  const items = attentionItems([run('a', 'running', 1, [{ name: 'ok', status: 'success' }, { name: '审批', status: 'awaiting', confirm: { token: 'k1' } }])], 10);
  expect(items).toEqual([{ key: 'await:a:1:k1', reason: 'await', runId: 'a', title: 't-a', step: '审批' }]);
});

test('takeFresh fires each item once and prefers an awaiting step over a start', () => {
  const seen = new Set<string>();
  const items = attentionItems([
    run('a', 'running', 20),
    run('b', 'running', 21, [{ name: 'x', status: 'awaiting', confirm: { token: 't' } }]),
  ], 10);
  expect(takeFresh(seen, items)?.reason).toBe('await');
  expect(takeFresh(seen, items)).toBeNull();
  const later = attentionItems([run('c', 'running', 40)], 10);
  expect(takeFresh(seen, later)?.runId).toBe('c');
});

test('routeFor: workbench in place, conversation gets the right tab, other pages a nudge', () => {
  expect(routeFor('butler-console-page', 'butler-console-page')).toBe('workbench');
  expect(routeFor(null, 'butler-console-page')).toBe('rightbar');
  expect(routeFor('butler', 'butler-console-page')).toBe('nudge');
});
