import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pythonCandidates } from '../scripts/build.mjs';

test('build Python override is authoritative, including paths with spaces', () => {
  expect(pythonCandidates({ BUTLER_PYTHON: '/custom env/bin/python' })).toEqual(['/custom env/bin/python']);
});

test('build finds nearest checkout ancestor venv, independent of caller cwd', () => {
  const root = mkdtempSync(join(tmpdir(), 'butler-build-'));
  try {
    const checkout = join(root, 'plugins', 'butler');
    mkdirSync(checkout, { recursive: true });
    const outer = join(root, '.venv', 'bin', 'python');
    mkdirSync(join(root, '.venv', 'bin'), { recursive: true });
    writeFileSync(outer, '');
    expect(pythonCandidates({}, checkout, 'darwin')).toEqual([outer]);
    const inner = join(checkout, '.venv', 'bin', 'python');
    mkdirSync(join(checkout, '.venv', 'bin'), { recursive: true });
    writeFileSync(inner, '');
    expect(pythonCandidates({}, checkout, 'linux')).toEqual([inner]);
    const windows = join(checkout, '.venv', 'Scripts', 'python.exe');
    mkdirSync(join(checkout, '.venv', 'Scripts'), { recursive: true });
    writeFileSync(windows, '');
    expect(pythonCandidates({}, checkout, 'win32')).toEqual([windows]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('external checkout without a venv offers system Python candidates', () => {
  // The filesystem root cannot inherit this workspace virtual environment.
  expect(pythonCandidates({}, '/', 'linux')).toEqual(['python3', 'python']);
});
