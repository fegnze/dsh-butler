import { spawn as nodeSpawn } from 'node:child_process';
import type { Spawner, HostedOutcome } from '../src/host/hosting.ts';

/** Plain Node spawner for tests only. */
export function createNodeSpawner(): Spawner {
  return {
    spawn(spec) {
      const [program, ...args] = spec.argv;
      const stdin = spec.stdin ?? 'ignore';
      let child: ReturnType<typeof nodeSpawn>;
      try {
        child = nodeSpawn(program!, args, {
          cwd: spec.cwd,
          env: { ...process.env, ...spec.env },
          stdio: [stdin === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        });
      } catch (error) {
        return { pid: undefined, stdout: undefined, stderr: undefined, done: Promise.resolve({ exitCode: null, signal: null, error: error as Error }), terminate() {} };
      }
      child.stdin?.on('error', () => undefined); // EPIPE is reflected in the child's outcome.
      if (typeof stdin === 'object' && child.stdin) child.stdin.end(stdin.data);
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const done = new Promise<HostedOutcome>((resolve) => {
        const finish = (outcome: HostedOutcome) => {
          if (settled) return;
          settled = true;
          if (killTimer) clearTimeout(killTimer);
          resolve(outcome);
        };
        child.once('error', (error) => finish({ exitCode: null, signal: null, error }));
        // close waits for stdout/stderr to drain, matching DSH's managed-range
        // outcome rather than reporting before buffered diagnostics are read.
        child.once('close', (exitCode, signal) => finish({ exitCode, signal }));
      });
      let terminated = false;
      const signalGroup = (signal: NodeJS.Signals) => {
        if (!child.pid) return;
        try { process.kill(-child.pid, signal); }
        catch { try { child.kill(signal); } catch { /* already gone */ } }
      };
      return {
        pid: child.pid,
        stdin: child.stdin ?? undefined,
        stdout: child.stdout ?? undefined,
        stderr: child.stderr ?? undefined,
        done,
        terminate() {
          if (terminated) return;
          terminated = true;
          signalGroup('SIGTERM');
          killTimer = setTimeout(() => { if (!settled) signalGroup('SIGKILL'); }, spec.graceMs);
          killTimer.unref();
        },
      };
    },
  };
}
