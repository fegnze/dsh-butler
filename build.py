"""Build the browser half into DSH's lazy-CJS bundle protocol.

DSH does not load plugin clients as ESM. Every client bundle must announce
itself to the loader:

    window.__ModuleLoader__.load({
      id: '<package name>',
      factory: (require) => { ...; return module.exports },
    })

and reach its peers through the *synchronous* `require` the loader hands the
factory — never through `import`. A plain ESM bundle does not merely fail on its
own: the server concatenates every client into one combo response, so one
unwrapped module takes down the whole roster with

    loaded without registering "@deepseek-ai/dsh-client-hmr" via __ModuleLoader__.load

which reads as an unrelated package failing. This was invisible to the contract
tests and to `bun build` — only a real boot surfaced it.

Strategy: let bun bundle our own modules (it resolves ./*.tsx and compiles JSX),
keep every DSH/react package external, then rewrite the external ESM imports
into loader `require` calls and wrap the result in the protocol envelope.

Usage: node scripts/build.mjs (selects Python; override with BUTLER_PYTHON)
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).parent
BUN = os.environ.get('BUTLER_BUN') or shutil.which('bun') or 'bun'
NODE = os.environ.get('BUTLER_NODE') or shutil.which('node') or 'node'
PACKAGE_ID = 'dsh-butler'
ENTRY = HERE / 'src/client/index.tsx'
OUT = HERE / 'dsh/client.js'
HOST_ENTRY = HERE / 'src/host/entry.ts'
HOST_OUT = HERE / 'dsh/host.js'
AGENT_ENTRY = HERE / 'src/agent/entry.ts'
AGENT_OUT = HERE / 'dsh/agent-host.js'
CONSUMER_ENTRY = HERE / 'src/agent/consumer.ts'
CONSUMER_OUT = HERE / 'dsh/consumer-host.js'

# Peers resolved through the loader's require, never bundled.
EXTERNALS = ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/*']

# A JS identifier, not `\w`. Minified bundles name things `$`, `Y`, `$0` — and
# `$` is absent from `\w`, so a `\w`-based rewrite leaves `{jsx as $}` standing
# and emits a file that no parser accepts.
IDENT = r'[A-Za-z_$][A-Za-z0-9_$]*'


def bundle() -> str:
    """Bundle our own modules with bun, leaving peers external.

    :returns: the ESM bundle source.
    :raises SystemExit: when bun fails.
    """
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / 'bundle.js'
        # `--production` selects react/jsx-runtime over react/jsx-dev-runtime.
        # The dev runtime is not in the loader's roster, so requiring it would
        # fail at boot — and only at boot.
        cmd = [BUN, 'build', str(ENTRY), '--target=browser', '--format=esm',
               '--production', f'--outfile={out}']
        for ext in EXTERNALS:
            cmd.append(f'--external={ext}')
        done = subprocess.run(cmd, capture_output=True, text=True)
        if done.returncode != 0:
            print(done.stdout + done.stderr, file=sys.stderr)
            raise SystemExit('bun build failed')
        return out.read_text()


def to_require(src: str) -> tuple[str, list[str]]:
    """Rewrite external ESM imports into loader `require` bindings.

    Handles the two forms bun emits for externals: named imports, and the
    bare side-effect import our `import type {}` markers leave behind.

    :param src: the ESM bundle.
    :returns: the rewritten body, and the peer ids it now requires.
    """
    peers: list[str] = []

    def named(match: re.Match[str]) -> str:
        """Turn `import {a, b as c} from 'x'` into destructured require."""
        spec, source = match.group(1), match.group(2)
        peers.append(source)
        # `a as b` is ESM spelling; object destructuring wants `a: b`.
        bindings = re.sub(rf'({IDENT})\s+as\s+({IDENT})', r'\1: \2', spec)
        return f'const {{{bindings}}} = require("{source}");'

    def namespace(match: re.Match[str]) -> str:
        """Turn `import * as ns from 'x'` into a plain require binding."""
        peers.append(match.group(2))
        return f'const {match.group(1)} = require("{match.group(2)}");'

    def default(match: re.Match[str]) -> str:
        """Turn `import d from 'x'` into a require with interop."""
        peers.append(match.group(2))
        return (f'const {match.group(1)} = (m => m && m.__esModule ? m.default : m)'
                f'(require("{match.group(2)}"));')

    src = re.sub(r'import\s*\{([^}]*)\}\s*from\s*["\']([^"\']+)["\'];?', named, src)
    src = re.sub(rf'import\s*\*\s*as\s+({IDENT})\s+from\s*["\']([^"\']+)["\'];?',
                 namespace, src)
    src = re.sub(rf'import\s+({IDENT})\s+from\s*["\']([^"\']+)["\'];?', default, src)
    # Bare side-effect imports are our `import type {}` contract markers; the
    # loader has no side effects to run, so they simply go away.
    src = re.sub(r'^\s*import\s*["\'][^"\']+["\'];?\s*$', '', src, flags=re.M)

    def exports_clause(match: re.Match[str]) -> str:
        """Turn `export {local as public, ...}` into module.exports assignments."""
        out = []
        for part in match.group(1).split(','):
            part = part.strip()
            if not part:
                continue
            local, _, public = part.partition(' as ')
            public = (public or local).strip()
            out.append(f'exports.{public} = {local.strip()};')
        return '\n' + '\n'.join(out) + '\n'

    # Not anchored to line starts: with --production the whole bundle is
    # minified onto a few long lines, so `export{...}` lands mid-line and an
    # `^`-anchored pattern silently misses it — leaving an ESM export inside a
    # CJS factory, which only fails once a browser parses the file.
    src = re.sub(r'\bexport\s*\{([^}]*)\};?', exports_clause, src)
    src = re.sub(r'\bexport\s+(const|let|var|function|class)\s', r'\1 ', src)

    return src, peers


HARNESS = r'''
// Evaluate the emitted bundle the way DSH's loader does: capture the factory
// off the envelope, then call it with stubbed peers. Anything that throws at
// module scope — a template literal closed early, a bad top-level reference —
// surfaces here, which is where a real boot would surface it.
const fs = require('fs'), vm = require('vm')
const file = process.argv[2]
const sandbox = {
  window: { __ModuleLoader__: { load: (m) => { sandbox.__captured = m } } },
  console, Date, Math, JSON, Map, Set, Promise, RegExp, String, Number, Array,
  Object, Error, TypeError, Symbol, setTimeout, clearTimeout, setInterval,
  clearInterval, document: undefined,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file })
const captured = sandbox.__captured
if (!captured) throw new Error('no __ModuleLoader__.load envelope')
if (captured.id !== 'dsh-butler') throw new Error('wrong loader id: ' + captured.id)
const React = {
  createElement: () => ({}), useState: (v) => [v, () => {}], useEffect: () => {},
  useMemo: (f) => f(), useCallback: (f) => f, useRef: () => ({}),
  useSyncExternalStore: () => undefined, default: {},
}
const jsx = { jsx: (t, p) => ({ t, p }), jsxs: (t, p) => ({ t, p }), Fragment: 'fragment' }
const exports_ = captured.factory((name) => {
  if (name === 'react') return React
  if (name === 'react/jsx-runtime') return jsx
  throw new Error('unexpected peer: ' + name)
})
for (const name of ['apply', 'inject']) {
  if (!(name in exports_)) throw new Error('missing export: ' + name)
}
'''


def loads(path: Path) -> None:
    """Assert the emitted file *evaluates*, not merely parses.

    A parse cannot see a template literal closed early by a stray backtick: the
    remainder becomes a tagged template and the file stays valid JavaScript. It
    fails only when something calls that tag, i.e. at module scope, at boot —
    reported to the owner as `Failed to load plugins`. So the artifact is run
    under the loader envelope with stubbed peers.

    :param path: the emitted bundle.
    :raises SystemExit: when evaluating the module throws.
    """
    with tempfile.NamedTemporaryFile('w', suffix='.cjs', delete=False) as handle:
        handle.write(HARNESS)
        harness = Path(handle.name)
    try:
        done = subprocess.run([NODE, str(harness), str(path)],
                              capture_output=True, text=True)
    finally:
        harness.unlink(missing_ok=True)
    if done.returncode != 0:
        print(done.stdout + done.stderr, file=sys.stderr)
        raise SystemExit(f'{path.name} does not evaluate — see the trace above')


def parses(path: Path) -> None:
    """Assert the emitted file is syntactically valid JavaScript.

    Every other check here is a pattern match over text, and a pattern match
    cannot tell a rewritten binding from a half-rewritten one: `{jsx as $}`
    survived the `as`-rewrite once, passed all four textual assertions, and
    only failed when a browser parsed it — as `Failed to load plugins`
    blaming an unrelated package, because the file joins a combo response.

    Parsing is the check that does not care how the text got there.

    :param path: the emitted bundle.
    :raises SystemExit: when the file does not parse.
    """
    done = subprocess.run([NODE, '--check', str(path)],
                          capture_output=True, text=True)
    if done.returncode != 0:
        print(done.stdout + done.stderr, file=sys.stderr)
        raise SystemExit(f'{path.name} is not parseable JavaScript')


def main() -> int:
    """Build, wrap, and write the client bundle."""
    body, peers = to_require(bundle())

    # Anything still spelled as a static import would be a silent ESM leak:
    # the file would look fine and break the whole combo response at boot.
    leaked = re.findall(r'^\s*import\s', body, flags=re.M)
    assert not leaked, f'{len(leaked)} ESM import(s) survived the rewrite'

    # The dev JSX runtime is not a package the loader serves; requiring it
    # would fail only once a browser actually boots the plugin.
    assert 'jsx-dev-runtime' not in body, 'dev JSX runtime leaked into the bundle'

    # Minification puts `export{...}` mid-line, where a line-anchored rewrite
    # misses it. An ESM export inside a CJS factory is a parse error at boot.
    leaked_exports = re.findall(r'\bexport\s*[{*]|\bexport\s+default\b', body)
    assert not leaked_exports, f'{len(leaked_exports)} ESM export(s) survived'

    # What the plugin is for: the loader must receive our apply/inject pair.
    for name in ('apply', 'inject'):
        assert f'exports.{name} =' in body, f'bundle does not export {name}'

    envelope = f'''// Browser half of {PACKAGE_ID}, emitted in DSH's lazy-CJS bundle protocol.
//
// Generated by build.py — do not edit. The loader hands the factory a
// synchronous `require`; ESM `import` is not available here, and an unwrapped
// module breaks the entire combo response, not just this plugin.
window.__ModuleLoader__.load({{
  id: '{PACKAGE_ID}',
  factory: (require) => {{
    var module = {{ exports: {{}} }};
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, {{ value: 'Module' }});

{body}

    return module.exports;
  }},
}});
'''
    OUT.write_text(envelope)
    parses(OUT)

    # Host half is plain ESM loaded directly by DSH, but its TypeScript host
    # graph must be bundled: DSH's JS loader does not interpret `.ts` imports.
    for entry, out in ((HOST_ENTRY, HOST_OUT), (AGENT_ENTRY, AGENT_OUT), (CONSUMER_ENTRY, CONSUMER_OUT)):
        host_cmd = [BUN, 'build', str(entry), '--target=node', '--format=esm',
                    '--external=@deepseek-ai/*', f'--outfile={out}']
        host_done = subprocess.run(host_cmd, capture_output=True, text=True)
        if host_done.returncode != 0:
            print(host_done.stdout + host_done.stderr, file=sys.stderr)
            raise SystemExit(f'{out.name} bundle failed')
        parses(out)
    # Text markers are not enough. A stylesheet template closed early by a stray
    # backtick keeps every byte of its text — it just becomes a tagged template,
    # so `parses()` above stays green and a marker search still finds the tail
    # (measured: both passed while the installed plugin died at boot with
    # "console is not a function"). The only check that sees it is *evaluating*
    # the artifact, which is what the loader does — and it must run after the
    # write, or it reports on the previous build and a broken tree can never be
    # rebuilt out of.
    loads(OUT)

    unique = sorted(set(peers))
    print(f'wrote {OUT.relative_to(HERE)}  {OUT.stat().st_size} bytes')
    print(f'peers via require: {", ".join(unique) if unique else "(none)"}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
