#!/usr/bin/env python
"""One-shot macOS desktop acceptance; never a service or replacement server.

Run from a terminal outside DSH, since quitting the App terminates its jobs:
  /path/to/python accept-desktop.py --execute --report /absolute/path/report.json
The explicit --execute flag permits two App quit/reopen cycles and workload
stop/start tests. A report is persisted after every step; failures reopen App.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request

APP = '/Applications/DeepSeek Harness.app'
BASE = 'http://127.0.0.1:19387/myspace-butler'


def api(path, method='GET'):
    request = urllib.request.Request(BASE + path, method=method)
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)


def processes():
    rows = {}
    for line in subprocess.check_output(['ps', '-axo', 'pid=,ppid=,command='], text=True).splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) == 3:
            rows[int(parts[0])] = (int(parts[1]), parts[2])
    return rows


def descendants(rows, pid):
    result = set()
    frontier = {pid}
    while frontier:
        frontier = {child for child, (parent, _) in rows.items() if parent in frontier and child not in result}
        result.update(frontier)
    return result


def wait_for(fn, timeout=90):
    end = time.monotonic() + timeout
    last = None
    while time.monotonic() < end:
        try:
            value = fn()
            if value:
                return value
            last = 'predicate returned false'
        except Exception as error:
            last = str(error)
        time.sleep(1)
    raise RuntimeError(f'condition timed out ({timeout}s): {last}')


def snapshot(prefix='/api'):
    overview = api(prefix + '/overview')
    services = api(prefix + '/services')
    return {'host': overview['host'], 'tools': overview['tools'], 'services': services}


def running(state):
    return all(t['running'] for t in state['tools']) and all(s['state'] == 'running' for s in state['services'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--start-delay', type=int, default=0, help='Allow the initiating DSH turn to finish before quitting')
    parser.add_argument('--controls-only', action='store_true', help='Test the 12 controls without quitting the App; not full lifecycle acceptance')
    args = parser.parse_args()
    if not args.execute:
        parser.error('--execute is required for disruptive acceptance')
    report_path = args.report.expanduser().resolve()
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report = {'startedAt': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'steps': [], 'passed': False}

    def record(name, **facts):
        report['steps'].append({'step': name, 'at': time.time(), **facts})
        temp = report_path.with_suffix('.tmp')
        temp.write_text(json.dumps(report, ensure_ascii=False, indent=2))
        os.replace(temp, report_path)
        print(name, flush=True)

    def reopen():
        subprocess.run(['/usr/bin/open', '-a', APP], check=True)
        return wait_for(lambda: snapshot(), 120)

    def cycle(name, state):
        host = state['host']['pid']
        before = processes()
        app_ids = [pid for pid, (_, command) in before.items() if command == APP + '/Contents/MacOS/DeepSeek Harness']
        assert len(app_ids) == 1, f'expected one App main process, got {app_ids}'
        assert before[host][0] == app_ids[0], 'Host is not owned by desktop App'
        owned = descendants(before, host)
        record(name + ':before', hostPid=host, appPid=app_ids[0], managedDescendants=sorted(owned))
        subprocess.run(['/usr/bin/osascript', '-e', 'tell application "DeepSeek Harness" to quit'], check=True, timeout=30)
        wait_for(lambda: app_ids[0] not in processes(), 45)
        # Compare PID and command to avoid falsely accusing a reused PID.
        def residuals():
            now = processes()
            return [pid for pid in owned | {host} if pid in now and now[pid][1] == before[pid][1]]
        wait_for(lambda: not residuals(), 30)
        record(name + ':exited', residualPids=residuals())
        restored = reopen()
        wait_for(lambda: running(snapshot()), 120)
        restored = snapshot()
        assert restored['host']['pid'] != host
        expected = {(kind, item['id']) for kind in ['tools', 'services'] for item in state[kind]}
        actual = {(kind, item['id']) for kind in ['tools', 'services'] for item in restored[kind]}
        assert actual == expected
        record(name + ':restored', state=restored)
        return restored

    try:
        if args.start_delay:
            record('waiting-for-initiating-turn', seconds=args.start_delay)
            time.sleep(args.start_delay)
        initial = snapshot('')  # Existing release may lack the new /api alias.
        assert len(initial['tools']) + len(initial['services']) == 12
        record('baseline', state=initial)
        current = initial if args.controls_only else cycle('load-new-host', initial)
        for kind in ['tools', 'services']:
            for item in current[kind]:
                ident = item['id']
                api(f'/api/{kind}/{ident}/stop', 'POST')
                def stopped():
                    match = next(x for x in snapshot()[kind] if x['id'] == ident)
                    return not match['running'] if kind == 'tools' else match['state'] == 'stopped'
                try:
                    wait_for(stopped, 30)
                finally:
                    api(f'/api/{kind}/{ident}/start', 'POST')
                wait_for(lambda: running(snapshot()), 120)
                record('stop-start', kind=kind, id=ident, passed=True)
        if not args.controls_only:
            cycle('accept-lifecycle', snapshot())
        report['scope'] = 'controls-only' if args.controls_only else 'full-lifecycle'
        output = subprocess.check_output(['launchctl', 'list'], text=True)
        assert not any('com.ghost.butler' in line or 'com.ghost.dsh-web' in line for line in output.splitlines())
        report['passed'] = True
        record('complete')
        return 0
    except Exception as error:
        record('failed', error=repr(error))
        try:
            reopen()
            record('recovery-opened')
        except Exception as recovery:
            record('recovery-failed', error=repr(recovery))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
