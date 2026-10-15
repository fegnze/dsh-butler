import { test, expect } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore } from '../src/host/runs.ts';
import { createNotificationSender } from '../src/host/hosting.ts';
import { createNodeSpawner } from './node-spawner.ts';

test('configured notification transport receives JSON on stdin without shell interpretation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'guardian-notification-test-'));
  const output = join(dir, 'payload.json');
  try {
    const code = 'const fs=require("fs");let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>fs.writeFileSync(process.argv[1],s));';
    const runs = new RunStore([process.execPath, '-e', code, output], createNotificationSender(createNodeSpawner()));
    runs.ingest({ runId: 'test', type: 'run:start', title: '扫描 $(touch never)', source: 'manual' });
    let payload;
    for (let i = 0; i < 50; i++) {
      try { payload = JSON.parse(await readFile(output, 'utf8')); break; } catch {}
      await Bun.sleep(20);
    }
    expect(payload.title).toBe('工作流 · 开始 ▶');
    expect(payload.body).toBe('扫描 $(touch never)');
    expect(payload.subtitle).toBe('来源 manual');
    expect(payload.action).toBe('open-dsh');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
