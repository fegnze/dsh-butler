#!/usr/bin/env python3
"""Mutation check for the upstream half of contract.test.ts.

A green contract test proves nothing until a broken contract turns it red. This
mutates copies of the installed DSH artefacts the way a real upstream refactor
would, points the test at the mutated copy, and demands a failure each time.

Two disciplines learned the hard way, both preserved here:

  * mutate with Python, never `sed -i ''` — under zsh the empty suffix argument
    is swallowed and the edit silently does not happen, which reads as "the test
    missed it" when nothing was ever changed;
  * assert the text actually changed, so an anchor that drifted is reported as a
    broken mutation rather than a passing one.

Usage: python3 mutate-upstream.py
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
DSH = Path.home() / '.dsh/profiles/node_modules/@deepseek-ai'
BUN = os.environ.get('BUTLER_BUN') or shutil.which('bun') or 'bun'

# Each mutation: a label, the artefact to damage, and the edit, expressed as the
# refactor it imitates.
MUTATIONS: list[tuple[str, str, str, str]] = [
    (
        'U0 subprocess loses managed-range quiescence',
        'dsh-subprocess/lib/types/types.d.ts',
        'waitForExit(signal?: AbortSignal): Promise<boolean>;',
        'waitForLeaderExit(signal?: AbortSignal): Promise<boolean>;',
    ),
    (
        'U1 sidebar renames the panellist slot',
        'dsh-client-ui-sidebar/lib/client.js',
        'entriesOfSlot("sidebar.panellist")',
        'entriesOfSlot("sidebar.panels")',
    ),
    (
        'U2 sidebar stops reading options.order',
        'dsh-client-ui-sidebar/lib/client.js',
        'order: options.order ?? 0',
        'order: 0',
    ),
    (
        'U3 layout keys the main slot by something else',
        'dsh-client-ui-layout/lib/client.js',
        'renderSlot("main", {}, { entryKey:',
        'renderSlot("main", {}, { routeKey:',
    ),
    (
        'U4 selectPanel stops validating against main keys',
        'dsh-client-ui-layout/lib/client.js',
        'ctx.slots.entries("main").some((entry) => entry.options.key === id)',
        'true',
    ),
    (
        'U5 the tab registry loses the extension band',
        'dsh-client-ui-sidebar-right/lib/types/client/tab-registry.d.ts',
        "export type SidebarRightTabPriority = 'extension' | 'builtin' | 'fallback'",
        "export type SidebarRightTabPriority = 'builtin' | 'fallback'",
    ),
    (
        'U6 sidebarRightTabs is provided under a new name',
        'dsh-client-ui-sidebar-right/lib/client.js',
        'ctx.reflect.provide("sidebarRightTabs"',
        'ctx.reflect.provide("rightTabRegistry"',
    ),
    (
        # Anchored on `patterns`, which occurs once and only inside
        # SidebarRightTabDefinition. The obvious anchor — `readonly kind:
        # string;` — also appears in SidebarRightGuideBox *earlier* in the file,
        # so a first-match replace damages the wrong interface and the run
        # reports a false escape.
        'U7 the definition grows keepMounted (our dropped field lands)',
        'dsh-client-ui-sidebar-right/lib/types/client/tab-registry.d.ts',
        '    readonly patterns?: readonly string[];',
        '    readonly patterns?: readonly string[];\n    readonly keepMounted?: boolean;',
    ),
    (
        'U8 guide entries gain an id of their own',
        'dsh-client-ui-sidebar-right/lib/types/client/tab-registry.d.ts',
        '    readonly order: number;',
        '    readonly id: string;\n    readonly order: number;',
    ),
    (
        'U9 the keyed tab seat is renamed',
        'dsh-client-ui-sidebar-right/lib/types/client/contract/slots.d.ts',
        "'sidebar.right.pane.tab': {",
        "'sidebar.right.tab.body': {",
    ),
    (
        'U10 a shipped package takes the panellist rail',
        'dsh-client-ui-sidebar/lib/client.js',
        'ctx.effect(() => ctx.slots.subscribe("sidebar.panellist", syncPanels)',
        'ctx.slots.register({ name: "sidebar.panellist" });\n\t\t\tctx.effect(() => ctx.slots.subscribe("sidebar.panellist", syncPanels)',
    ),
    (
        'U11 the shipped files example drops its effect wrapping',
        'dsh-client-ui-sidebar-files/lib/client.js',
        'ctx.effect(() => ctx.sidebarRightTabs.register(',
        'void (ctx.sidebarRightTabs.register(',
    ),
    (
        'U12 conversation gives up the reserved main key',
        'dsh-client-ui-conversation/lib/client.js',
        'key: "conversation"',
        'key: "chat"',
    ),
    (
        # The rule that made a trailing slash fatal. If upstream ever appends
        # the separator on the registration side instead, our paths must gain
        # one back — so this must not pass silently.
        'U13 prefix matching stops appending the separator itself',
        'dsh-host-webserver/lib/index.js',
        'if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;',
        'if (!pathname.startsWith(prefix)) continue;',
    ),
    (
        # Our listing route and run route share a path and rely on this order.
        'U14 prefix routes start winning over exact ones',
        'dsh-host-webserver/lib/index.js',
        'const exact = this.exact.get(pathname);',
        'const exact = undefined;',
    ),
    (
        'U15 exact and prefix collapse into one table',
        'dsh-host-webserver/lib/index.js',
        'const table = route.kind === "exact" ? this.exact : this.prefixes;',
        'const table = this.exact;',
    ),
    (
        # We passed a `name:` the route never declared. If it ever becomes real,
        # the assertion that it does not exist should be the thing that notices.
        'U16 the route interface grows a name field',
        'dsh-host-webserver/lib/types/index.d.ts',
        '    kind: WebRouteKind;',
        '    name: string;\n    kind: WebRouteKind;',
    ),
    (
        # Upstream fixing their own selection bug should retire our rule, not
        # leave two owners of the same declaration.
        'U17 upstream makes panel rows unselectable themselves',
        'dsh-client-ui-sidebar/lib/client.js',
        'panelRow{box-sizing:border-box;',
        'panelRow{user-select:none;box-sizing:border-box;',
    ),
    (
        # Our no-select selector targets the rail's semantics. If the rail
        # stops being a nav, the selector silently matches nothing.
        'U18 the rail stops being a nav element',
        'dsh-client-ui-sidebar/lib/client.js',
        '(0, react_jsx_runtime.jsx)("nav"',
        '(0, react_jsx_runtime.jsx)("div"',
    ),
    (
        # The overlay chrome reads the palette the base stylesheet defines per
        # scheme. Renaming the dark block's anchor token is exactly the kind of
        # refactor that would turn our bar white in dark mode again.
        'U19 the dark palette block renames its first token',
        'dsh-client-ui-theme/lib/client.js',
        'body[data-ds-dark-theme]{--dsw-alias-bg-base',
        'body[data-ds-dark-theme]{--dsw-alias-bg-foundation',
    ),
]


def run_test(dsh_root: Path, project: Path = HERE) -> subprocess.CompletedProcess[str]:
    """Run the contract test against a given DSH tree.

    :param dsh_root: the @deepseek-ai scope the test should read.
    :returns: the finished process.
    """
    env = dict(os.environ, DSH_SCOPE_OVERRIDE=str(dsh_root))
    return subprocess.run(
        [BUN, 'test', 'contract.test.ts'],
        cwd=project, env=env, capture_output=True, text=True,
    )


# The same discipline pointed inwards. Upstream mutations prove the suite
# notices when DSH moves; these prove it notices when *we* regress — which is
# the likelier event, and the one a green suite is most tempting to trust.
#
# Each entry damages a file in this plugin the way a plausible "simplification"
# would: collapsing two routes into one, sending a URL where an index belongs,
# treating three action modes as one. All of them leave a console that renders
# and mostly works, which is exactly why they need a test to catch them.
LOCAL_MUTATIONS: list[tuple[str, str, str, str]] = [
    (
        'L1 the console reads only the stripped public catalogue',
        './src/ui/operations-source.ts',
        'fetch(`${base()}/overview`, { headers: { accept: \'application/json\' } }),',
        'fetch(`${base()}/operations`, { headers: { accept: \'application/json\' } }),',
    ),
    (
        'L2 tools come from the catalogue again, losing panelUrl',
        './src/ui/operations-source.ts',
        'Array.isArray(overview?.tools) ? overview.tools : []',
        'Array.isArray(raw?.tools) ? raw.tools : []',
    ),
    (
        'L3 the two reads drift into separate ticks',
        './src/ui/operations-source.ts',
        'await Promise.all([',
        'await Promise.allSettled([',
    ),
    (
        'L4 a quick action is posted by URL instead of by index',
        './src/ui/operations-source.ts',
        '/actions/${index}`,',
        '/actions/${action.url}`,',
    ),
    (
        'L5 panel and external collapse into one behaviour',
        './src/ui/ConsoleBody.tsx',
        "if (action.mode === 'external') {",
        'if (false) {',
    ),
    (
        'L6 an opened tab keeps a handle back to this page',
        './src/ui/ConsoleBody.tsx',
        "'noopener,noreferrer'",
        "''",
    ),
    (
        'L10 the embedded panel stops passing the theme through',
        './src/ui/PanelModal.tsx',
        "return url + (url.includes('?') ? '&' : '?') + 'theme=' + theme",
        'return url',
    ),
    # ── the card order and the redesign ──────────────────────────────────
    (
        'L12 a drop boundary is treated as an array index',
        './src/ui/console-layout.ts',
        'const requested = toIndex > from ? toIndex - 1 : toIndex',
        'const requested = toIndex',
    ),
    (
        'L13 a stored order becomes a filter that hides what it does not name',
        './src/ui/console-layout.ts',
        'return known.concat(rest)',
        'return known',
    ),
    (
        'L14 a reset stores an empty list instead of dropping the section',
        './src/ui/console-layout.ts',
        'if (ids.length === 0) delete order[section]',
        'if (ids.length === 0) order[section] = []',
    ),
    (
        'L15 a repeated id is kept, so the order depends on which copy wins',
        './src/ui/console-layout.ts',
        'if (kept.includes(id)) continue',
        'if (false) continue',
    ),
    (
        'L16 the two halves order different sections',
        './src/host/layout.ts',
        "export const LAYOUT_SECTIONS = ['services', 'tools', 'workflows']",
        "export const LAYOUT_SECTIONS = ['tools', 'services', 'workflows']",
    ),
    (
        'L17 the layout file is truncated in place instead of renamed',
        './src/host/layout.ts',
        "      await writeFile(temp, JSON.stringify(value), 'utf8');\n      await rename(temp, layoutFile);",
        "      await writeFile(layoutFile, JSON.stringify(value), 'utf8');",
    ),
    (
        'L18 a malformed layout is quietly read as no order',
        './src/host/layout.ts',
        "return fail(response, 500, error instanceof SyntaxError ? `layout.json is not JSON: ${error.message}` : String((error as Error)?.message ?? error));",
        "response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(EMPTY)); return;",
    ),
    (
        'L19 the layout preference stops following Butler state',
        './src/host/routes.ts',
        'createLayoutHandler(config.stateDir)',
        'createLayoutHandler(process.cwd())',
    ),
    (
        'L20 a poll landing mid-write folds the previous order back in',
        './src/ui/operations-source.ts',
        'if (writing === 0) {',
        'if (true) {',
    ),
    (
        'L21 a move is applied only after the server agrees',
        './src/ui/operations-source.ts',
        """    emit()
    return push(next, before.layout)""",
        """    const settled = push(next, before.layout)
    emit()
    return settled""",
    ),
    (
        'L22 reordering stays on while a filter projects the order',
        './src/ui/ConsoleBody.tsx',
        "const sortable = !filtering && typeof move === 'function'",
        "const sortable = typeof move === 'function'",
    ),
    (
        'L23 the grip is folded back into the clickable card body',
        './src/ui/ConsoleBody.tsx',
        'className="bp-grip"',
        'className="bp-tile__open"',
    ),
    (
        'L24 a cancelled gesture commits its move',
        './src/ui/use-drag-order.ts',
        "if (event.type === 'pointerup' && active.boundary !== active.index",
        'if (active.boundary !== active.index',
    ),
    (
        'L25 the drag marker is never cleared when the grid unmounts',
        './src/ui/use-drag-order.ts',
        'useEffect(() => end, [end])',
        'useEffect(() => {}, [])',
    ),
    (
        'L26 the identity hue stops being derived from the id',
        './src/ui/ConsoleBody.tsx',
        'return hash % HUES',
        'return 0',
    ),
    (
        'L27 the identity palette loses its dark half',
        './src/ui/panel-styles.ts',
        'body[data-ds-dark-theme] .bp-tile__mark[data-hue="${index}"] { background: ${fill(dark, 0.18)}; color: ${dark}; }',
        'body[data-ds-dark-theme] .bp-tile__mark[data-hue="${index}"] { background: ${fill(light, 0.18)}; color: ${light}; }',
    ),
    (
        # The original bug: a hardcoded light bar. Any "simplification" that
        # drops the theme tokens must go red.
        'L11 the panel surface falls back to hardcoded white',
        './src/ui/PanelModal.tsx',
        "          background: palette.surface,\n          color: palette.text,",
        "          background: '#fff',\n          color: palette.text /* mutated */,",
    ),
]


def run_local(label: str, rel: str, old: str, new: str) -> bool:
    """Damage an isolated plugin copy, never the desktop-linked working tree.

    The assertions resolve via import.meta.dir inside the copied project.

    :param label: the regression this imitates.
    :param rel: path within the plugin.
    :param old: text to replace.
    :param new: replacement text.
    :returns: whether the suite caught it.
    """
    # desktop may link this repository: never expose a mutation to the App.
    with tempfile.TemporaryDirectory(prefix='butler-mutation-') as tmp:
        project = Path(tmp) / 'plugin'
        shutil.copytree(HERE, project, ignore=shutil.ignore_patterns('node_modules', '.git', '__pycache__'))
        baseline = run_test(DSH, project)
        assert baseline.returncode == 0, f'isolated baseline failed: {baseline.stdout[-1000:]} {baseline.stderr[-1000:]}'
        target = project / rel
        original = target.read_text()
        hits = original.count(old)
        assert hits == 1, f'{label}: anchor occurs {hits}x in {rel}, expected 1'
        target.write_text(original.replace(old, new, 1))
        return run_test(DSH, project).returncode != 0


def main() -> int:
    """Mutate each upstream anchor in turn and require the suite to notice."""
    if not DSH.is_dir():
        print('no DSH install to mutate', file=sys.stderr)
        return 2

    baseline = run_test(DSH)
    if baseline.returncode != 0:
        print('baseline is already red; fix that first')
        print(baseline.stdout[-2000:])
        return 2
    print('baseline: green\n')

    escaped = 0
    for label, rel, old, new in MUTATIONS:
        with tempfile.TemporaryDirectory() as tmp:
            scope = Path(tmp) / '@deepseek-ai'
            # Copy only the packages the assertions read; a full copy is slow
            # and nothing else is consulted.
            scope.mkdir(parents=True)
            for pkg in {m[1].split('/')[0] for m in MUTATIONS}:
                shutil.copytree(DSH / pkg, scope / pkg, symlinks=True)

            target = scope / rel
            original = target.read_text()
            # Uniqueness, not mere presence. A first-match replace on an anchor
            # that occurs twice damages the wrong site and the run reports a
            # false escape — U7 did exactly that against `readonly kind:
            # string;`, which SidebarRightGuideBox carries earlier in the file.
            hits = original.count(old)
            assert hits == 1, f'{label}: anchor occurs {hits}x in {rel}, expected 1'
            mutated = original.replace(old, new, 1)
            assert mutated != original, f'{label}: anchor did not match in {rel}'
            target.write_text(mutated)

            result = run_test(scope)
            if result.returncode == 0:
                escaped += 1
                print(f'ESCAPED  {label}')
            else:
                failed = re.findall(r'\(fail\) (.+)', result.stdout)
                print(f'caught   {label}')
                for name in failed[:2]:
                    print(f'           -> {name.strip()}')

    print(f'\n{len(MUTATIONS) - escaped}/{len(MUTATIONS)} upstream mutations caught\n')

    local_escaped = 0
    for label, rel, old, new in LOCAL_MUTATIONS:
        if run_local(label, rel, old, new):
            print(f'caught   {label}')
        else:
            local_escaped += 1
            print(f'ESCAPED  {label}')

    print(f'\n{len(LOCAL_MUTATIONS) - local_escaped}/{len(LOCAL_MUTATIONS)} local mutations caught')
    return 1 if escaped or local_escaped else 0


if __name__ == '__main__':
    raise SystemExit(main())
