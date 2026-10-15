import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInjector, createUserMessage, INJECT_SECTION, PLUGIN_NAME, type InjectConfig } from '../src/host/injector.ts';

let self = '';
beforeEach(() => {
  self = mkdtempSync(join(tmpdir(), 'butler-inject-'));
  mkdirSync(join(self, 'build'));
  writeFileSync(join(self, 'build', 'context.md'), '# Butler context\n\n主人叫阿明。\n');
});
afterEach(() => rmSync(self, { recursive: true, force: true }));

const base: InjectConfig = { enabled: true, workspaces: [], excludePresets: ['butler'], includeSubagents: false, maxChars: 8000 };
const createMessage = (input: any) => Object.freeze({ ...input, role: 'user', id: `m-${Math.random()}` });

/** Fake session whose derived surface grows with every entered decision. */
function fakeAgent(header: Record<string, unknown>) {
  const surface: any[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }];
  return { session: { header: { id: 's-1', cwd: '/w', agentPreset: 'standard', ...header }, deriveMessages: () => surface }, surface };
}
async function step(handler: any, agent: any, decision: any = { kind: 'enter', messages: [] }) {
  const out = await handler({ agent: { session: agent.session }, messages: [], turn: 1, step: 1, signal: new AbortController().signal }, async () => decision);
  if (out.kind === 'enter') agent.surface.push(...out.messages);
  return out;
}

test('injects context.md once per session as a plugin snapshot message', async () => {
  const handler = createInjector({ selfRoot: self, config: base, createMessage });
  const agent = fakeAgent({});
  const first = await step(handler, agent);
  expect(first.messages).toHaveLength(1);
  const msg = first.messages[0];
  expect(msg.content[0].text).toContain('主人叫阿明');
  expect(msg.source).toEqual({ kind: `plugin:${PLUGIN_NAME}`, form: 'snapshot', sections: [{ name: INJECT_SECTION, text: msg.content[0].text }] });
  const second = await step(handler, agent);
  expect(second.messages).toHaveLength(0);
});

test('re-injects after compaction removed the snapshot from the visible surface', async () => {
  const handler = createInjector({ selfRoot: self, config: base, createMessage });
  const agent = fakeAgent({});
  await step(handler, agent);
  agent.surface.splice(1); // compaction dropped it
  expect((await step(handler, agent)).messages).toHaveLength(1);
});

test('skips disabled, excluded preset, subagent, workspace mismatch, reject and missing context', async () => {
  const cases: Array<[Partial<InjectConfig>, Record<string, unknown>]> = [
    [{ enabled: false }, {}],
    [{}, { agentPreset: 'butler' }],
    [{}, { origin: 'subagent' }],
    [{ workspaces: ['/elsewhere'] }, {}],
  ];
  for (const [patch, header] of cases) {
    const handler = createInjector({ selfRoot: self, config: { ...base, ...patch }, createMessage });
    expect((await step(handler, fakeAgent(header))).messages).toHaveLength(0);
  }
  const handler = createInjector({ selfRoot: self, config: base, createMessage });
  expect(await step(handler, fakeAgent({}), { kind: 'reject' })).toEqual({ kind: 'reject' });
  rmSync(join(self, 'build', 'context.md'));
  const warnings: string[] = [];
  const quiet = createInjector({ selfRoot: self, config: base, createMessage, warn: (m) => warnings.push(m) });
  expect((await step(quiet, fakeAgent({}))).messages).toHaveLength(0);
  expect(warnings.join('')).toContain('context.md');
});

test('keeps upstream messages, bounds the text and never throws into the agent loop', async () => {
  writeFileSync(join(self, 'build', 'context.md'), 'x'.repeat(20_000));
  const handler = createInjector({ selfRoot: self, config: { ...base, maxChars: 1000 }, createMessage });
  const upstream = { role: 'user', content: [{ type: 'text', text: 'other plugin' }], source: { kind: 'plugin:other', form: 'snapshot' } };
  const out = await step(handler, fakeAgent({}), { kind: 'enter', messages: [upstream] });
  expect(out.messages[0]).toBe(upstream);
  expect(out.messages[1].content[0].text.length).toBeLessThanOrEqual(1000);
  const boom = createInjector({ selfRoot: self, config: base, createMessage: () => { throw new Error('boom'); }, warn: () => undefined });
  expect((await step(boom, fakeAgent({}))).messages).toHaveLength(0);
});

test('local createUserMessage matches dsh-llm: frozen user message with a fresh id', () => {
  const input = { content: [{ type: 'text' as const, text: 'x' }], source: { kind: 'plugin:p', form: 'snapshot' } };
  const a = createUserMessage(input) as any;
  const b = createUserMessage(input) as any;
  expect(a).toMatchObject({ role: 'user', content: input.content, source: input.source });
  expect(typeof a.id).toBe('string');
  expect(a.id).not.toBe(b.id);
  expect(Object.isFrozen(a) && Object.isFrozen(a.content[0]) && Object.isFrozen(a.source)).toBe(true);
  expect(a.content).not.toBe(input.content);
});
