import { afterAll, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromRaw } from '../src/host/config.ts';
import { createCollector, deriveObservation, type SessionInfo } from '../src/host/collector.ts';
import { createNodeSpawner } from './node-spawner.ts';

const PYTHON = '/Users/ghost/MySpace/.venv/bin/python';
const SKELETON = join(import.meta.dir, '..', 'skeleton');
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function instance(): string {
  const root = mkdtempSync(join(tmpdir(), 'butler-collector-'));
  roots.push(root);
  cpSync(SKELETON, root, { recursive: true });
  return root;
}

/** Real DSH SessionEvent union shapes (dsh-session types.d.ts). */
function turnEvents(turn: number, seq0: number, prompt: string, extra: unknown[] = []): unknown[] {
  let seq = seq0;
  const ev = (type: string, data: unknown) => ({ type, seq: seq++, time: 1_700_000_000_000 + seq, data });
  return [
    ev('turn/start', { turn }),
    ev('step/start', { turn, step: 1 }),
    // agent.inject() context may precede the human prompt in the same step.
    ev('user/message', { id: `p${turn}`, role: 'user', content: [{ type: 'text', text: 'PLUGIN CONTEXT' }], source: { kind: 'plugin', plugin: 'x', form: 'snapshot', sections: [] } }),
    ev('user/message', { id: `m${turn}`, role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }),
    ...extra.map((item) => { const { type, data } = item as { type: string; data: unknown }; return ev(type, data); }),
    ev('step/end', { turn, step: 1 }),
    ev('turn/end', { turn, reason: { kind: 'completed' } }),
  ];
}

function session(events: unknown[], header: Record<string, unknown> = {}): SessionInfo {
  return { header: { id: 'sess-1', cwd: '/repo', ...header }, snapshotEvents: () => events };
}
const last = (events: unknown[]) => events[events.length - 1] as { type: string; seq: number; data: unknown };
function pipelineSpawner(calls: string[] = []) {
  return {
    spawn(spec: any) {
      if (spec.argv.at(-1)?.endsWith('/pipeline')) {
        calls.push(typeof spec.stdin === 'object' ? spec.stdin.data : '');
        return { pid: undefined, stdin: undefined, stdout: Readable.from([JSON.stringify({ ok: true, data: { accepted: true } })]), stderr: Readable.from([]), done: new Promise<{ exitCode: number; signal: null }>(resolve => setImmediate(() => resolve({ exitCode: 0, signal: null }))), terminate() {} };
      }
      return createNodeSpawner().spawn(spec);
    },
  };
}

test('derives only the ending turn from the real DSH event log', () => {
  const t1 = turnEvents(1, 0, '第一回合不该出现', [{ type: 'tool/call', data: { turn: 1, step: 1, callId: 'c0', name: 'bash', arguments: '{}' } }]);
  const t2 = turnEvents(2, t1.length, '修复登录页并提交', [
    { type: 'tool/call', data: { turn: 2, step: 1, callId: 'c1', name: 'edit', arguments: JSON.stringify({ file_path: '/repo/src/a.ts' }) } },
    { type: 'tool/call', data: { turn: 2, step: 1, callId: 'c2', name: 'bash', arguments: '{"command":"git commit"}' } },
    { type: 'tool/result', data: { turn: 2, step: 1, message: { id: 'r2', role: 'user', source: { kind: 'tool', callId: 'c2' }, content: [{ type: 'tool-result', toolCallId: 'c2', isError: false, content: [{ type: 'text', text: '[main 4b2d04f] fix login\n 1 file changed' }] }] } } },
  ]);
  const all = [...t1, ...t2];
  const obs = deriveObservation(session(all), last(all));
  expect(obs).toMatchObject({
    source: 'dsh', type: 'session', text: '修复登录页并提交', ref: 'dsh://sess-1#2', workspace: '/repo', sessionId: 'sess-1', turn: 2,
    filesTouched: ['/repo/src/a.ts'], toolsUsed: ['edit', 'bash'], gitCommits: ['4b2d04f'], failed: false, tags: ['workspace:/repo'],
  });
});

test('marks failure from tool isError and turn error reason', () => {
  const failedTool = turnEvents(1, 0, 'x', [
    { type: 'tool/result', data: { turn: 1, step: 1, message: { content: [{ type: 'tool-result', isError: true, content: [] }] }, error: { name: 'E', code: 'X' } } },
  ]);
  expect(deriveObservation(session(failedTool), last(failedTool)).failed).toBe(true);
  const ok = turnEvents(1, 0, 'y');
  const errorEnd = { type: 'turn/end', seq: 99, data: { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } } };
  expect(deriveObservation(session(ok), errorEnd).failed).toBe(true);
});

test('missing snapshotEvents is an error, not a silent empty observation', () => {
  expect(() => deriveObservation({ header: { id: 's' } }, { type: 'turn/end', seq: 1, data: { turn: 1 } })).toThrow('snapshotEvents');
});

test('debounce collapses rapid turn/end into one real intake record', async () => {
  const root = instance();
  const config = fromRaw(root, { python: PYTHON });
  const errors: string[] = [];
  const calls: string[] = [];
  const collector = createCollector(config, pipelineSpawner(calls), { debounceMs: 30, onError: (m) => errors.push(m) });
  const t1 = turnEvents(1, 0, '先做 A');
  const t2 = turnEvents(2, t1.length, '再做 B', [{ type: 'tool/call', data: { turn: 2, step: 1, callId: 'c', name: 'write', arguments: JSON.stringify({ file_path: 'b.md' }) } }]);
  const all = [...t1, ...t2];
  const s = session(all);
  collector.onSessionEvent(s, last(t1));
  collector.onSessionEvent(s, last(all));
  await collector.flush();
  expect(errors).toEqual([]);
  expect(calls).toHaveLength(2);
  const envelopes = calls.map((text) => JSON.parse(text));
  expect(envelopes.map((value) => value.args.externalSessionId)).toEqual(['sess-1', 'sess-1']);
  expect(envelopes.map((value) => value.args.segmentId).sort()).toEqual(['dsh://sess-1#1', 'dsh://sess-1#2']);
  expect(envelopes.find((value) => value.args.segmentId.endsWith('#2')).args.messages[0].content).toBe('再做 B');
  collector.dispose();
});

test('excludes butler preset, non-matching workspace, and non turn/end events', async () => {
  const root = instance();
  const errors: string[] = [];
  const calls: string[] = [];
  const collector = createCollector(fromRaw(root, { python: PYTHON }), pipelineSpawner(calls), { debounceMs: 0, workspaces: ['/only'], onError: (m) => errors.push(m) });
  const events = turnEvents(1, 0, 'ignore');
  collector.onSessionEvent(session(events, { cwd: '/only', agentPreset: 'butler' }), last(events));
  collector.onSessionEvent(session(events, { cwd: '/elsewhere' }), last(events));
  collector.onSessionEvent(session(events, { cwd: '/only' }), events[2] as never);
  collector.onSessionEvent(session(events, { cwd: '/only', origin: 'subagent' }), last(events));
  await collector.flush();
  expect(calls).toHaveLength(0);
  const optedCalls: string[] = [];
  const opted = createCollector(fromRaw(root, { python: PYTHON }), pipelineSpawner(optedCalls), { debounceMs: 0, includeSubagents: true });
  opted.onSessionEvent(session(events, { cwd: '/only', origin: 'subagent' }), last(events));
  await opted.flush();
  expect(optedCalls).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('intake failure and broken snapshot are reported, never thrown', async () => {
  const root = instance();
  const errors: string[] = [];
  const collector = createCollector(fromRaw(root, { python: '/nonexistent/python' }), createNodeSpawner(), { debounceMs: 0, onError: (m) => errors.push(m) });
  const events = turnEvents(1, 0, 'x');
  collector.onSessionEvent(session(events), last(events));
  collector.onSessionEvent({ header: { id: 'broken' }, snapshotEvents: () => { throw new Error('log closed'); } }, last(events));
  await collector.flush();
  expect(errors.some((m) => m.includes('pipeline') && m.includes('dsh://sess-1#1'))).toBe(true);
  expect(errors.some((m) => m.includes('broken') && m.includes('log closed'))).toBe(true);
});

test('concurrent sessions write every record without loss', async () => {
  const root = instance();
  const errors: string[] = [];
  const calls: string[] = [];
  const collector = createCollector(fromRaw(root, { python: PYTHON }), pipelineSpawner(calls), { debounceMs: 0, onError: (m) => errors.push(m) });
  for (let index = 0; index < 20; index += 1) {
    const events = turnEvents(1, 0, `会话 ${index}`);
    collector.onSessionEvent(session(events, { id: `s-${index}` }), last(events));
  }
  await collector.flush();
  expect(errors).toEqual([]);
  expect(calls).toHaveLength(20);
  const envelopes = calls.map((text) => JSON.parse(text));
  expect(new Set(envelopes.map((value) => value.args.externalSessionId)).size).toBe(20);
});
