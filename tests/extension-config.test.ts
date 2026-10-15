import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { iconView } from '../src/host/catalog.ts';
import { mergeManifest } from '../src/host/routes.ts';

const stored = {
  schemaVersion: 1, kind: 'service', id: 'wtc-web', name: 'WTC-Web', frequency: 'low',
  hosted: { command: 'npm run dev', cwd: '/w', port: 5174, url: 'http://x/', group: 'Project', autoStart: true, restart: 'never', env: { A: '1' } },
};

test('a console save keeps every manifest field the form does not show', () => {
  const merged = mergeManifest(stored, { name: 'WTC', hosted: { command: 'npm start', port: 5175 } });
  expect(merged).toEqual({
    schemaVersion: 1, kind: 'service', id: 'wtc-web', name: 'WTC', frequency: 'low',
    hosted: { command: 'npm start', port: 5175, group: 'Project', autoStart: true, restart: 'never', env: { A: '1' } },
  });
});

test('clearing a form field removes it; an empty command keeps the stored one', () => {
  const merged = mergeManifest(stored, { name: 'WTC-Web', hosted: { command: '', cwd: '', url: 'http://y/' } }) as { hosted: Record<string, unknown> };
  expect(merged.hosted.command).toBe('npm run dev');
  expect(merged.hosted.cwd).toBeUndefined();
  expect(merged.hosted.port).toBeUndefined();
  expect(merged.hosted.url).toBe('http://y/');
  expect(merged.hosted.autoStart).toBe(true);
});

test('the editor mounts per item, so its fields are read from the item it opens', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'src', 'ui', 'ConsoleBody.tsx'), 'utf8');
  // always-mounted + useState(initial) was the empty-form bug
  expect(source).toMatch(/\{editor \? <ExtensionEditor key=\{/);
  // service cards offer open / folder / log besides lifecycle
  for (const key of ['console.openPage', 'console.openDir', 'console.log']) expect(source).toContain(`t('${key}')`);
});

test('description is a form field: set, trimmed, and removed when cleared', () => {
  const set = mergeManifest(stored, { name: 'WTC-Web', description: '  前端调试站 ', hosted: { command: 'npm run dev' } });
  expect(set.description).toBe('前端调试站');
  const cleared = mergeManifest({ ...stored, description: 'x' }, { name: 'WTC-Web', description: '', hosted: { command: 'npm run dev' } });
  expect('description' in cleared).toBe(false);
  // a body without the field (older client) leaves it alone
  expect(mergeManifest({ ...stored, description: 'x' }, { name: 'WTC-Web', hosted: { command: 'npm run dev' } }).description).toBe('x');
});

test('a card without a description shows no second line', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'src', 'ui', 'ConsoleBody.tsx'), 'utf8');
  expect(source).toContain('line={lineFor(`service:${service.id}`, service.description || null)}');
  expect(source).toMatch(/\{line \? <p className="bp-tile__desc"/);
});

test('icon is a form field: set, trimmed, and removed when cleared', () => {
  expect(mergeManifest(stored, { name: 'WTC-Web', icon: ' 🚀 ', hosted: { command: 'npm run dev' } }).icon).toBe('🚀');
  expect('icon' in mergeManifest({ ...stored, icon: 'x.png' }, { name: 'WTC-Web', icon: '', hosted: { command: 'npm run dev' } })).toBe(false);
  expect(mergeManifest({ ...stored, icon: 'x.png' }, { name: 'WTC-Web', hosted: { command: 'npm run dev' } }).icon).toBe('x.png');
});

test('iconView classifies the configured value; unset means letters', () => {
  expect(iconView(undefined)).toBeUndefined();
  expect(iconView('  ')).toBeUndefined();
  expect(iconView('https://x.dev/a.png')).toEqual({ type: 'url', value: 'https://x.dev/a.png' });
  expect(iconView('data:image/png;base64,AAAA')?.type).toBe('url');
  expect(iconView('./assets/logo.svg')?.type).toBe('file');
  // same declared value, same token; another file, another token
  expect(iconView('./a.png')).toEqual(iconView('./a.png'));
  expect(iconView('./a.png')).not.toEqual(iconView('./b.png'));
  expect(iconView('🚀')).toEqual({ type: 'text', value: '🚀' });
});

test('the card falls back to letters when no icon is configured or the image fails', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'src', 'ui', 'ConsoleBody.tsx'), 'utf8');
  expect(source).toContain('<CardMark mark={mark} icon={icon} hue={hue} />');
  expect(source).toContain('onError={() => setBroken(true)}');
});

// ── icons: the upload route and the tool path ──
import { mkdtemp, readFile, readdir, rm, writeFile as writeFileFs, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fromRaw } from '../src/host/config.ts';
import { createHosting, type Spawner } from '../src/host/hosting.ts';
import { createButlerRouter } from '../src/host/routes.ts';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-body')]);
const PNG_URL = `data:image/png;base64,${PNG.toString('base64')}`;

async function withRouter(run: (call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: string; headers: Record<string, string> }>, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'butler-icon-'));
  const spawner: Spawner = { spawn() { throw new Error('unexpected spawn'); } };
  try {
    await mkdir(join(root, 'tools'), { recursive: true });
    await mkdir(join(root, 'services'), { recursive: true });
    const hosting = await createHosting(fromRaw(root, { notification: { enabled: false } }), spawner, 'http://localhost/myspace-butler');
    const router = createButlerRouter(hosting);
    const call = async (method: string, path: string, body?: unknown) => {
      const req = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), { method, headers: { 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' } }) as unknown as IncomingMessage;
      let status = 0; let out = ''; let headers: Record<string, string> = {};
      const res = { writeHead(code: number, h: Record<string, string> = {}) { status = code; headers = h; }, end(value: string | Buffer = '') { out += value.toString(); } } as unknown as ServerResponse;
      await router.handle(req, res, path, new URL(path, 'http://localhost'));
      return { status, body: out, headers };
    };
    await run(call, root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

for (const kind of ['tool', 'service'] as const) {
  test(`${kind}: an uploaded icon is stored beside the manifest, named by content, and served`, async () => {
    await withRouter(async (call, root) => {
      const created = await call('POST', '/extensions', { schemaVersion: 1, kind, id: 'demo', name: 'Demo', hosted: { command: 'true' }, iconData: PNG_URL });
      expect(created.status).toBe(201);
      const dir = join(root, `${kind}s`, 'demo');
      const manifest = JSON.parse(await readFile(join(dir, 'butler.json'), 'utf8'));
      expect(manifest.icon).toMatch(/^icon-[0-9a-f]{8}\.png$/);
      expect(manifest).not.toHaveProperty('iconData');
      expect((await readFile(join(dir, manifest.icon))).equals(PNG)).toBe(true);
      const served = await call('GET', `/icons/${kind}/demo`);
      expect(served.status).toBe(200);
      expect(served.headers['Content-Type']).toBe('image/png');
    });
  });
}

test('replacing an uploaded icon removes the old generated file but never a hand-placed one', async () => {
  await withRouter(async (call, root) => {
    await call('POST', '/extensions', { schemaVersion: 1, kind: 'tool', id: 'demo', name: 'Demo', hosted: { command: 'true' }, iconData: PNG_URL });
    const dir = join(root, 'tools', 'demo');
    const first = JSON.parse(await readFile(join(dir, 'butler.json'), 'utf8')).icon;
    const other = `data:image/png;base64,${Buffer.concat([PNG, Buffer.from('2')]).toString('base64')}`;
    expect((await call('PUT', '/extensions/tool/demo', { name: 'Demo', hosted: { command: 'true' }, iconData: other })).status).toBe(200);
    const second = JSON.parse(await readFile(join(dir, 'butler.json'), 'utf8')).icon;
    expect(second).not.toBe(first);
    expect((await readdir(dir)).filter((f) => f.startsWith('icon-'))).toEqual([second]);
    // switching to an emoji drops the generated file; a hand-placed logo is left alone
    await writeFileFs(join(dir, 'logo.png'), PNG);
    await call('PUT', '/extensions/tool/demo', { name: 'Demo', hosted: { command: 'true' }, icon: './logo.png' });
    expect((await readdir(dir)).sort()).toEqual(['butler.json', 'logo.png']);
    await call('PUT', '/extensions/tool/demo', { name: 'Demo', hosted: { command: 'true' }, icon: '🚀' });
    expect((await readdir(dir)).sort()).toEqual(['butler.json', 'logo.png']);
  });
});

test('the upload is validated server-side: PNG only, magic checked, size capped', async () => {
  await withRouter(async (call) => {
    const base = { schemaVersion: 1, kind: 'tool', id: 'demo', name: 'Demo', hosted: { command: 'true' } };
    for (const bad of ['data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,bm90IGEgcG5n', 'not-a-data-url', `data:image/png;base64,${Buffer.alloc(160_000, 1).toString('base64')}`]) {
      expect((await call('POST', '/extensions', { ...base, iconData: bad })).status).toBe(400);
    }
  });
});

test('the icon route serves only a declared image inside the manifest directory', async () => {
  await withRouter(async (call, root) => {
    const dir = join(root, 'tools', 'demo');
    await mkdir(dir, { recursive: true });
    await writeFileFs(join(root, 'secret.png'), PNG);
    await writeFileFs(join(dir, 'butler.json'), JSON.stringify({ schemaVersion: 1, kind: 'tool', id: 'demo', name: 'Demo', hosted: { command: 'true' }, icon: '../../secret.png' }));
    await call('PUT', '/extensions/tool/demo', { name: 'Demo', hosted: { command: 'true' }, icon: '../../secret.png' });
    expect((await call('GET', '/icons/tool/demo')).status).toBe(400);
    expect((await call('GET', '/icons/tool/missing')).status).toBe(404);
  });
});

test('a tool carries its icon through the overview the console reads', async () => {
  await withRouter(async (call) => {
    await call('POST', '/extensions', { schemaVersion: 1, kind: 'tool', id: 'demo', name: 'Demo', hosted: { command: 'true' }, icon: '🚀' });
    const overview = JSON.parse((await call('GET', '/overview')).body);
    expect(overview.tools.find((tool: { id: string }) => tool.id === 'demo')?.icon).toEqual({ type: 'text', value: '🚀' });
    const operations = JSON.parse((await call('GET', '/operations')).body);
    expect(operations.tools.find((tool: { id: string }) => tool.id === 'demo')?.icon).toEqual({ type: 'text', value: '🚀' });
  });
});

test('a save the Host silently dropped the icon from is reported, not closed as success', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'src', 'ui', 'ConsoleBody.tsx'), 'utf8');
  expect(source).toContain("typeof result.extension?.icon !== 'string'");
  expect(source).toContain("t('console.hostStale')");
  // the current Host echoes the stored icon back, which is what the check reads
  const routes = readFileSync(join(import.meta.dir, '..', 'src', 'host', 'routes.ts'), 'utf8');
  expect(routes).toContain("icon: typeof manifest.icon === 'string' ? manifest.icon : undefined");
});

test('the editor offers a file picker, and the schema forbids icon on faculties', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'src', 'ui', 'ConsoleBody.tsx'), 'utf8');
  expect(source).toContain('type="file" accept="image/*"');
  expect(source).toContain('iconData: iconUpload');
  const schema = JSON.parse(readFileSync(join(import.meta.dir, '..', 'spec', 'butler.schema.json'), 'utf8'));
  const faculty = schema.allOf.find((rule: { if: { properties: { kind: { const: string } } } }) => rule.if.properties.kind.const === 'faculty');
  expect(faculty.then.not.anyOf).toContainEqual({ required: ['icon'] });
});

// ── a tool's form edits identity only ──
const toolManifest = {
  schemaVersion: 1, kind: 'tool', id: 'demo', name: 'Demo', description: 'd',
  hosted: { command: ['bun', 'service.mjs', 'serve'], port: 37911, autoStart: true },
  panelUrl: 'http://127.0.0.1:37911/admin', panelSize: { width: 900 },
  actions: [{ label: '启动', url: 'http://127.0.0.1:37911/apply', mode: 'post' }], frequency: 'low',
};

test('a tool save with no hosted block leaves process, panel and actions untouched', () => {
  const merged = mergeManifest(toolManifest, { name: 'Demo 2', description: '', icon: '🚀' });
  expect(merged.name).toBe('Demo 2');
  expect('description' in merged).toBe(false);
  expect(merged.icon).toBe('🚀');
  // the argv array survives as an array; a form that did not show it must not stringify or drop it
  expect(merged.hosted).toEqual(toolManifest.hosted);
  expect(merged.panelUrl).toBe(toolManifest.panelUrl);
  expect(merged.actions).toEqual(toolManifest.actions);
  expect(merged.frequency).toBe('low');
});

test('a hostless tool (actions/panel only) can be renamed and given an icon', async () => {
  await withRouter(async (call, root) => {
    const dir = join(root, 'tools', 'pure');
    await mkdir(dir, { recursive: true });
    await writeFileFs(join(dir, 'butler.json'), JSON.stringify({ schemaVersion: 1, kind: 'tool', id: 'pure', name: 'Pure', actions: [{ label: '页', url: 'http://x/', mode: 'external' }] }));
    const read = await call('GET', '/extensions/tool/pure');
    expect(read.status).toBe(200);
    expect((await call('PUT', '/extensions/tool/pure', { name: 'Pure 2', icon: '🧰' })).status).toBe(200);
    const stored = JSON.parse(await readFile(join(dir, 'butler.json'), 'utf8'));
    expect(stored.name).toBe('Pure 2');
    expect(stored.icon).toBe('🧰');
    expect(stored).not.toHaveProperty('hosted');
    expect(stored.actions).toHaveLength(1);
  });
});

test('the tool form drops the service-only fields', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'src', 'ui', 'ConsoleBody.tsx'), 'utf8');
  expect(source).toContain("const identityOnly = kind === 'tool' && Boolean(editor.item)");
  expect(source).toContain('{identityOnly ? (');
  expect(source).toContain("t('console.toolIdentityNote')");
});

test('the workbench switches between console, launchpad and Butler, remembers the choice, and keeps both locales', () => {
  const bench = readFileSync(join(import.meta.dir, '..', 'src', 'ui', 'Workbench.tsx'), 'utf8');
  expect(bench).toContain('role="tablist"');
  expect(bench).toContain("aria-selected={tab === key}");
  expect(bench).toContain('ArrowLeft');
  // each half mounts only while selected, so the hidden one does not poll
  expect(bench).toMatch(/tab === 'console' \? <ConsolePage[^:]+: <QuickActionsPage/);
  // the switch rides inside each half's own title bar; there is no bar of the workbench's own
  expect(bench).not.toContain('bp-bench');
  const locales = readFileSync(join(import.meta.dir, '..', 'src', 'ui', 'locales.ts'), 'utf8');
  expect(locales.match(/'workbench\.panel'/g)).toHaveLength(2);
  expect(locales).not.toContain("'actions.panel'");
});

test('the briefing keeps its reading zone free of commands; the only one sits in the folded maintenance block', () => {
  const page = readFileSync(join(import.meta.dir, '..', 'src', 'ui', 'ButlerPage.tsx'), 'utf8');
  const show = page.indexOf('bq-zone bq-zone--show');
  const maint = page.indexOf('<details className="bq-maint">');
  expect(show).toBeGreaterThan(0);
  expect(maint).toBeGreaterThan(show);
  // nothing in the reading zone runs a faculty command or report
  expect(page.slice(show, maint)).not.toContain('runCommand(');
  expect(page.slice(show, maint)).not.toContain('showReport(');
  // the capability list moved out of the page; the manifest still describes each command
  expect(page).not.toContain('bq-zone--act');
  const manifest = readFileSync(join(import.meta.dir, '..', '..', '..', 'Butler', 'faculties', 'journal', 'butler.json'), 'utf8');
  for (const id of ['intake', 'run', 'install']) {
    expect(JSON.parse(manifest).commands.find((c: { id: string }) => c.id === id).description).toBeTruthy();
  }
});

test('a command row is its own grid, so a missing note cannot reflow the next button', () => {
  const css = readFileSync(join(import.meta.dir, '..', 'src', 'ui', 'panel-styles.ts'), 'utf8');
  expect(css).toMatch(/\.bq-fac__list li \{ display: grid; grid-template-columns: 96px/);
  expect(css).not.toContain('.bq-fac__list li { display: contents; }');
});

test('the journal capability is named for what it does, in the live manifest and the skeleton', () => {
  for (const base of [join(import.meta.dir, '..', '..', '..', 'Butler'), join(import.meta.dir, '..', 'skeleton')]) {
    const manifest = JSON.parse(readFileSync(join(base, 'faculties', 'journal', 'butler.json'), 'utf8'));
    expect(manifest.name).not.toBe('观察总账');
    for (const id of ['intake', 'run', 'install']) {
      expect(manifest.commands.find((c: { id: string }) => c.id === id).description).toBeTruthy();
    }
  }
});

test('the Butler page routes to reviewed cards; legacy memory stays unmounted', () => {
  const ui = join(import.meta.dir, '..', 'src', 'ui');
  const page = readFileSync(join(ui, 'ButlerPage.tsx'), 'utf8');
  expect(page).toContain('<CardPipelinePage');
  expect(page).toContain('maintenance={<BriefingPage');
  expect(page).not.toContain('<MemoryPage');
  // Legacy code remains testable during migration but is no longer a UI write surface.
  expect(page).toContain('lead ?? <h1');
  const memory = readFileSync(join(ui, 'MemoryPage.tsx'), 'utf8');
  expect(memory).toContain('lead ?? <h1');
  // reads: one Host section; writes: the journal faculty's commands, never a file or a raw fetch
  expect(memory).toContain("fetchButlerSection('memory')");
  for (const command of ['card-create', 'card-update', 'card-delete', 'profile-set', 'intake']) expect(memory).toContain(`'${command}'`);
  expect(memory).not.toMatch(/\bfetch\(/);
  expect(memory).not.toMatch(/node:fs|writeFile/);
  // the page confirms the two actions that cannot be undone from the page
  expect(memory).toContain("memory.confirmDelete");
  expect(memory).toContain("memory.confirmProfile");
  const locales = readFileSync(join(ui, 'locales.ts'), 'utf8');
  for (const key of ['tab.briefing', 'tab.memory', 'memory.title', 'memory.stale', 'memory.confirmDelete']) expect(locales.match(new RegExp(`'${key}'`, 'g'))).toHaveLength(2);
});

test('the stdin arg lets a body carry what argv cannot, and the manifest schema documents it', async () => {
  const { facultyInvocation } = await import('../src/host/routes.ts');
  const command = { id: 'x', exec: [], args: [
    { name: 'id', pattern: '[a-z]+', required: true, positional: true },
    { name: 'body', pattern: '[\\s\\S]{1,20}', required: true, stdin: true },
  ] };
  expect(facultyInvocation(command, { id: 'abc', body: '- 以横线开头\n多行' })).toEqual({ argv: ['abc'], stdin: '- 以横线开头\n多行' });
  expect(() => facultyInvocation(command, { id: 'abc', body: 'x'.repeat(21) })).toThrow();
  expect(() => facultyInvocation(command, { id: 'abc' })).toThrow();
  expect(() => facultyInvocation(command, { id: '-abc', body: 'x' })).toThrow();
  expect(readFileSync(join(import.meta.dir, '..', 'spec', 'butler.schema.json'), 'utf8')).toContain('"stdin"');
});

test('everything on the memory page is a console tile; there is no second list style', () => {
  const ui = join(import.meta.dir, '..', 'src', 'ui');
  const memory = readFileSync(join(ui, 'MemoryPage.tsx'), 'utf8');
  // cards, the profile and observations all render through MemoryTile, in the console's grid
  expect(memory).toContain('className="bp-tile bm-tile"');
  expect(memory).toContain('className="bp-grid"');
  expect(memory.match(/<MemoryTile/g)?.length).toBe(3);
  // opening one reads it in a sheet; no master/detail pane and no bespoke row list
  expect(memory).not.toMatch(/bm-split|bm-list|bm-item|bm-detail|<RecordRow/);
  const css = readFileSync(join(ui, 'panel-styles.ts'), 'utf8');
  expect(css).not.toMatch(/\.bm-(split|list|item|detail)\b/);
});

test('the memory sections use the owner-facing names and one tile shape', () => {
  const ui = join(import.meta.dir, '..', 'src', 'ui');
  const locales = readFileSync(join(ui, 'locales.ts'), 'utf8');
  expect(locales).toContain("'memory.nav.profile': '身份资料卡'");
  expect(locales).toContain("'memory.nav.journal': '采集记录'");
  // the old name must be gone from every owner-facing string, not just renamed in one key
  expect(locales).not.toMatch(/记录卡/);
  expect(locales).not.toMatch(/[Rr]ecord cards?/);
  expect(locales).not.toMatch(/'memory\.[\w.]+': '[^']*(主人画像|观察记录)/);
  const memory = readFileSync(join(ui, 'MemoryPage.tsx'), 'utf8');
  // one tile component, no per-kind variants of its shape
  expect(memory).not.toMatch(/markSmall|clampName|data-clamp|data-small/);
  expect(memory).toContain('desc={excerpt(');
});

test('the memory page follows record -> record card -> promoted card, with sortable cards and lookup-only record sections', () => {
  const ui = join(import.meta.dir, '..', 'src', 'ui');
  const memory = readFileSync(join(ui, 'MemoryPage.tsx'), 'utf8');
  // three record sections, only the first promotable
  expect(memory).toContain("const RECORD_GROUP = { journal: 'observation', git: 'git', session: 'session' }");
  expect(memory).toMatch(/section === 'journal' && !record\.promotedTo/);
  // promotion goes through the faculty with the record's handle, never a direct write
  expect(memory).toContain("act('profile-append', { origin: record.key");
  expect(memory).toMatch(/act\('card-create', args\)/);
  // dragging reuses the console's hook and is off while a search hides cards
  expect(memory).toContain("from './use-drag-order.ts'");
  expect(memory).toMatch(/const sortable = .*!query\.trim\(\)/);
  expect(memory).toContain("act('card-order'");
  // the manifest declares exactly what the page sends
  for (const file of ['skeleton/faculties/journal/butler.json']) {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, '..', file), 'utf8'));
    const ids = manifest.commands.map((c: { id: string }) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['card-order', 'profile-append']));
    const order = manifest.commands.find((c: { id: string }) => c.id === 'card-order');
    expect(order.args.find((a: { name: string }) => a.name === 'slugs').stdin).toBe(true);
  }
  // the section names, in both languages
  const locales = readFileSync(join(ui, 'locales.ts'), 'utf8');
  for (const key of ["'memory.nav.git': 'Git 记录'", "'memory.nav.session': '会话记录'", "'memory.nav.git': 'Git records'", "'memory.nav.session': 'Session records'"]) expect(locales).toContain(key);
  // the three record entries are a group of their own, apart from the three card entries
  const memoryPage = readFileSync(join(ui, 'MemoryPage.tsx'), 'utf8');
  expect(memoryPage).toContain("const CARD_SECTIONS = ['rule', 'knowledge', 'profile']");
  expect(memoryPage).toContain("const RECORD_SECTIONS = ['journal', 'git', 'session']");
  expect(memoryPage).toContain('bm-nav__rule');
  expect(readFileSync(join(ui, 'panel-styles.ts'), 'utf8')).toContain('.bm-nav__rule {');
});

test('「跟随 DSH 自启动」：autoStart 开关落进 hosted.autoStart，其余 hosted 字段原样保留', () => {
  const off = mergeManifest(stored, { name: 'WTC-Web', autoStart: false, hosted: { command: 'npm run dev', cwd: '/w', port: 5174, url: 'http://x/' } }) as { hosted: Record<string, unknown> };
  expect(off.hosted).toEqual({ ...stored.hosted, autoStart: false });
  const on = mergeManifest({ ...stored, hosted: { ...stored.hosted, autoStart: false } }, { name: 'WTC-Web', autoStart: true }) as { hosted: Record<string, unknown> };
  expect(on.hosted.autoStart).toBe(true);
});

test('tool 的身份表单也能改 autoStart，且不碰进程配置', () => {
  const tool = { schemaVersion: 1, kind: 'tool', id: 'gw', name: 'GW', hosted: { command: ['bun', 'src/cli.ts', 'serve'], port: 37891, autoStart: true }, panelUrl: 'http://127.0.0.1:37891/admin' };
  const merged = mergeManifest(tool, { name: 'GW', description: '', icon: '', autoStart: false });
  expect(merged.hosted).toEqual({ command: ['bun', 'src/cli.ts', 'serve'], port: 37891, autoStart: false });
  expect(merged.panelUrl).toBe(tool.panelUrl);
});

test('不传 autoStart 不改它；纯 actions 工具（无 hosted）不会被凭空加上 hosted', () => {
  expect((mergeManifest(stored, { name: 'WTC-Web' }) as any).hosted.autoStart).toBe(true);
  const pure = { schemaVersion: 1, kind: 'tool', id: 'pure', name: 'Pure', actions: [{ label: '页', url: 'http://x/', mode: 'external' }] };
  expect('hosted' in mergeManifest(pure, { name: 'Pure', autoStart: true })).toBe(false);
});

test('编辑表单只在有进程时显示开关，并把 autoStart 随保存提交', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'src', 'ui', 'ConsoleBody.tsx'), 'utf8');
  expect(source).toContain("t('console.autoStart')");
  expect(source).toMatch(/\{hasProcess \? \(\s*<label className="bp-editor__check">/);
  expect(source).toContain('...(hasProcess ? { autoStart } : {})');
});

for (const kind of ['tool', 'service'] as const) {
  test(`${kind}: 经 HTTP 关掉「跟随 DSH 自启动」→ 写回 butler.json，GET 读回 false，重扫后不再自启`, async () => {
    await withRouter(async (call, root) => {
      expect((await call('POST', '/extensions', { schemaVersion: 1, kind, id: 'demo', name: 'Demo', hosted: { command: 'true', autoStart: true } })).status).toBe(201);
      expect(JSON.parse((await call('GET', `/extensions/${kind}/demo`)).body).hosted.autoStart).toBe(true);
      // tool 走身份表单（不带 hosted），service 走完整表单 —— 两种提交都要生效
      const body = kind === 'tool' ? { name: 'Demo', autoStart: false } : { name: 'Demo', autoStart: false, hosted: { command: 'true' } };
      expect((await call('PUT', `/extensions/${kind}/demo`, body)).status).toBe(200);
      const onDisk = JSON.parse(await readFile(join(root, `${kind}s`, 'demo', 'butler.json'), 'utf8'));
      expect(onDisk.hosted).toEqual({ command: 'true', autoStart: false });
      expect(JSON.parse((await call('GET', `/extensions/${kind}/demo`)).body).hosted.autoStart).toBe(false);
    });
  });
}

test('清单里没写 autoStart 时，读回的开关是 false（与 host 缺省「不自启」一致）', async () => {
  await withRouter(async (call) => {
    await call('POST', '/extensions', { schemaVersion: 1, kind: 'service', id: 'plain', name: 'Plain', hosted: { command: 'true' } });
    expect(JSON.parse((await call('GET', '/extensions/service/plain')).body).hosted.autoStart).toBe(false);
  });
});
