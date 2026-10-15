import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));

// Search from the checkout, not cwd, so workspace installs keep their venv.
// An explicit override or an existing venv is authoritative: never silently
// fall back if it is broken. Only external checkouts need PATH discovery.
export function pythonCandidates(env = process.env, start = root, platform = process.platform) {
  if (env.BUTLER_PYTHON) return [env.BUTLER_PYTHON];
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    const python = join(dir, '.venv', ...(platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
    if (existsSync(python)) return [python];
    if (dirname(dir) === dir) break;
  }
  return ['python3', 'python'];
}

export function build() {
  for (const python of pythonCandidates()) {
    const probe = spawnSync(python, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) continue;
    const result = spawnSync(python, [join(root, 'build.py')], { cwd: root, stdio: 'inherit' });
    if (result.error) console.error(`Cannot run build: ${result.error.message}`);
    return result.status ?? 1;
  }
  console.error('Python 3.10+ is required. Set BUTLER_PYTHON to a working interpreter executable.');
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = build();
}
