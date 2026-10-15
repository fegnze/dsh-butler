import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInjector, type InjectConfig } from '../src/host/injector.ts';

let self = '';
beforeEach(() => { self = mkdtempSync(join(tmpdir(), 'butler-wiki-')); mkdirSync(join(self, 'build')); writeFileSync(join(self, 'build', 'context.md'), 'legacy'); });
afterEach(() => rmSync(self, { recursive: true, force: true }));
const config: InjectConfig = { enabled: true, workspaces: [], excludePresets: [], includeSubagents: true, maxChars: 400 };
const createMessage = (input: any) => ({ ...input, role: 'user', id: Math.random().toString() });
function agent(surface: any[] = []) { return { session: { header: { cwd: '/w', agentPreset: 'standard' }, deriveMessages: () => surface }, surface }; }
async function step(handler: any, a: any) { const out = await handler({ agent: { session: a.session } }, async () => ({ kind: 'enter', messages: [] })); if (out.kind === 'enter') a.surface.push(...out.messages); return out; }
function loader(text = 'wiki cards', revision = 'r1') { return async () => ({ text, revision }); }

test('injects Wiki text and revision once', async () => {
  const a = agent(); const out = await step(createInjector({ selfRoot: self, config, createMessage, loadWikiContext: loader() }), a);
  expect(out.messages[0].content[0].text).toContain('wiki cards');
  expect(out.messages[0].source.sections).toEqual(expect.arrayContaining([{ name: 'butler-context:r1', text: '[butler-context-revision:r1]' }]));
  expect((await step(createInjector({ selfRoot: self, config, createMessage, loadWikiContext: loader() }), a)).messages).toHaveLength(0);
});

test('updates when revision changes and says prior snapshot is superseded', async () => {
  const a = agent(); const handler = createInjector({ selfRoot: self, config, createMessage, loadWikiContext: loader('old', 'r1') }); await step(handler, a);
  const out = await step(createInjector({ selfRoot: self, config, createMessage, loadWikiContext: loader('new', 'r2') }), a);
  expect(out.messages[0].content[0].text).toContain('以下替代此前Butler知识快照');
  expect(a.surface).toHaveLength(2);
});

test('legacy snapshot is retained and replaced by Wiki without claiming deletion', async () => {
  const a = agent([{ source: { kind: 'plugin:myspace-butler-panel', form: 'snapshot', sections: [{ name: 'butler-context', text: 'legacy' }] } }]);
  const out = await step(createInjector({ selfRoot: self, config, createMessage, loadWikiContext: loader('wiki', 'r1') }), a);
  expect(out.messages[0].content[0].text).toContain('以下替代此前Butler知识快照');
  expect(a.surface).toHaveLength(2);
});

test('compaction loss causes Wiki re-injection', async () => {
  const a = agent(); const opts = { selfRoot: self, config, createMessage, loadWikiContext: loader() }; await step(createInjector(opts), a); a.surface.length = 0;
  expect((await step(createInjector(opts), a)).messages).toHaveLength(1);
});

test('Wiki load errors and empty data do not inject', async () => {
  const a = agent(); const warnings: string[] = [];
  const failed = createInjector({ selfRoot: self, config, createMessage, warn: (x) => warnings.push(x), loadWikiContext: async () => { throw new Error('offline'); } });
  expect((await step(failed, a)).messages).toHaveLength(0); expect(warnings.join()).toContain('offline');
  expect((await step(createInjector({ selfRoot: self, config, createMessage, loadWikiContext: loader('', 'r1') }), a)).messages).toHaveLength(0);
});

test('Wiki text obeys maxChars and normal filters', async () => {
  const bounded = { ...config, maxChars: 30 }; const a = agent(); const out = await step(createInjector({ selfRoot: self, config: bounded, createMessage, loadWikiContext: loader('x'.repeat(100), 'r1') }), a);
  expect(out.messages[0].content[0].text.length).toBeLessThanOrEqual(30);
  const excluded = agent(); expect((await step(createInjector({ selfRoot: self, config: { ...config, excludePresets: ['standard'] }, createMessage, loadWikiContext: loader() }), excluded)).messages).toHaveLength(0);
});
