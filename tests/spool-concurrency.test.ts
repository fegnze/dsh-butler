import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PYTHON = '/Users/ghost/MySpace/.venv/bin/python';
const INTAKE = join(import.meta.dir, '../skeleton/faculties/journal/bin/intake');
const RUN = join(import.meta.dir, '../skeleton/faculties/journal/bin/run');

async function execute(argv: string[], env: Record<string, string>) {
  const child = Bun.spawn(argv, { env, stdout: 'ignore', stderr: 'ignore' });
  return child.exited;
}

test('journal spool keeps every record across 100 concurrent intake/run rounds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'butler-spool-'));
  const selfRoot = join(root, 'self');
  const env = { ...process.env, BUTLER_SELF_ROOT: selfRoot } as Record<string, string>;
  try {
    for (let round = 0; round < 100; round += 1) {
      const intake = execute([PYTHON, INTAKE, '--source', 'concurrency', `round-${round}`], env);
      const run = execute([PYTHON, RUN], env);
      const secondRun = execute([PYTHON, RUN], env);
      const [intakeCode, runCode, secondRunCode] = await Promise.all([intake, run, secondRun]);
      expect(intakeCode).toBe(0);
      expect(runCode).toBe(0);
      expect(secondRunCode).toBe(0);
    }
    expect(await execute([PYTHON, RUN], env)).toBe(0);

    const journalPath = join(selfRoot, 'journal', 'JOURNAL.jsonl');
    const records = readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { text: string });
    const texts = records.filter((record) => record.text.startsWith('round-')).map((record) => record.text);
    expect(texts).toHaveLength(100);
    expect(new Set(texts).size).toBe(100);
    expect(texts.sort()).toEqual(Array.from({ length: 100 }, (_, index) => `round-${index}`).sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
