import { expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { Supervisor } from '../src/host/supervisor.ts';

test('tool SSE replays bounded output, streams live data and closes on shutdown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'butler-log-'));
  const stdout = new PassThrough();
  let finish!: (value: { exitCode: number; signal: null }) => void;
  const done = new Promise<{ exitCode: number; signal: null }>(resolve => { finish = resolve; });
  const manager = new Supervisor({ spawn: () => ({ pid: undefined, stdout, stderr: undefined, done, terminate: () => { finish({ exitCode: 0, signal: null }); } }) }, root);
  try {
    manager.register({ id: 'fixture', name: 'Fixture', command: ['fixture'], autoStart: false });
    manager.start('fixture');
    stdout.write(Array.from({ length: 220 }, (_, i) => `line-${i}`).join('\n'));
    const data: string[] = [];
    let closed = false;
    const response = Object.assign(new EventEmitter(), { write(value: string) { data.push(value); return true; }, end() { closed = true; response.emit('close'); } });
    manager.subscribeLog('fixture', response as unknown as ServerResponse);
    expect(data.length).toBe(200);
    expect(data[0]).toContain('line-20');
    stdout.write('live');
    expect(data.at(-1)).toContain('live');
    manager.shutdown();
    expect(closed).toBe(true);
    await done;
  } finally {
    manager.shutdown();
    await done;
    // The file streams flush asynchronously after the process outcome.
    await Bun.sleep(50);
    await rm(root, { recursive: true, force: true });
  }
});
