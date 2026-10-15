import { expect, test } from 'bun:test';
import { fromRaw } from '../src/host/config.ts';
import { createCollector, deriveTranscript, type SessionInfo } from '../src/host/collector.ts';
import type { HostedProcess, Spawner } from '../src/host/hosting.ts';
import { Readable } from 'node:stream';

function session(events: unknown[], header: Record<string, unknown> = {}): SessionInfo {
  return { header: { id: 'sess-transcript', cwd: '/repo', ...header }, snapshotEvents: () => events };
}
function event(type: string, seq: number, data: unknown, id?: string): unknown { return { type, seq, time: seq, ...(id ? { id } : {}), data }; }
function transcriptEvents(): unknown[] {
  return [
    event('turn/start', 0, { turn: 4 }),
    event('user/message', 1, { id: 'plugin', role: 'user', content: [{ type: 'text', text: 'ignore plugin' }], source: { kind: 'plugin' } }),
    event('user/message', 2, { id: 'user-real', role: 'user', content: [{ type: 'text', text: '完整用户内容，不截断' }], source: { kind: 'user' } }),
    event('assistant/message', 3, { message: { id: 'assistant-real', role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' }, content: [{ type: 'text', text: '完整助手答复' }] } }),
    event('assistant/message', 4, { id: 'reasoning', role: 'assistant', reasoning: true, content: [{ type: 'text', text: 'secret chain of thought' }] }),
    event('tool/result', 5, { message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: '必要结果 token=secret-value' }] }] } }),
    event('turn/end', 6, { turn: 4, reason: { kind: 'completed' } }),
  ];
}

test('deriveTranscript preserves complete user/assistant messages and bounded redacted tool output', () => {
  const result = deriveTranscript(session(transcriptEvents()), { type: 'turn/end', seq: 6, data: { turn: 4 } });
  expect(result).toMatchObject({ source: 'dsh', externalSessionId: 'sess-transcript', segmentId: 'dsh://sess-transcript#4', revision: 1, captureMode: 'transcript' });
  expect(result.messages).toEqual([
    { id: 'user-real', role: 'user', content: '完整用户内容，不截断', sequence: 2 },
    { id: 'assistant-real', role: 'assistant', content: '完整助手答复', sequence: 3 },
    { id: 'dsh:sess-transcript:event:5', role: 'tool', content: '必要结果 token=[REDACTED]', sequence: 5 },
  ]);
});

test('missing turn boundary and truncated text are marked partial', () => {
  expect(deriveTranscript(session([]), { type: 'turn/end', seq: 2, data: { turn: 1 } }).integrity).toBe('partial');
  const events = [event('turn/start', 0, { turn: 1 }), event('user/message', 1, { id: 'large', source: { kind: 'user' }, content: 'x'.repeat(65_000) })];
  expect(deriveTranscript(session(events), { type: 'turn/end', seq: 2, data: { turn: 1 } }).integrity).toBe('partial');
});

function mockSpawner(calls: string[][]): Spawner {
  return { spawn(spec) {
    calls.push(spec.argv);
    const output = JSON.stringify({ ok: true, data: { accepted: true } });
    return { pid: undefined, stdin: undefined, stdout: Readable.from([output]), stderr: Readable.from([]), done: new Promise<{ exitCode: number; signal: null }>(resolve => setImmediate(() => resolve({ exitCode: 0, signal: null }))), terminate() {} } as HostedProcess;
  } };
}

test('collector sends every debounced turn as one sessions.ingest pipeline envelope', async () => {
  const calls: string[][] = [];
  const collector = createCollector(fromRaw('/tmp/butler-test', { python: '/python' }), mockSpawner(calls), { debounceMs: 10 });
  const events = transcriptEvents();
  collector.onSessionEvent(session(events), events.at(-1) as any);
  collector.onSessionEvent(session(events), { type: 'turn/end', seq: 6, data: { turn: 5 } });
  await collector.flush();
  expect(calls).toHaveLength(2);
  for (const argv of calls) expect(argv.at(-1)).toBe('/tmp/butler-test/faculties/journal/bin/pipeline');
  collector.dispose();
});

test('dispose claims pending turns and flush can await them', async () => {
  const calls: string[][] = [];
  const collector = createCollector(fromRaw('/tmp/butler-test', { python: '/python' }), mockSpawner(calls), { debounceMs: 1000 });
  const events = transcriptEvents();
  collector.onSessionEvent(session(events), events.at(-1) as any);
  collector.dispose();
  await collector.flush();
  expect(calls).toHaveLength(1);
});
