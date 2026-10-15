import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The bundle patch is the only place the `butler` preset is declared. Parse it
// with a schema that tolerates the `!!js` tag and check the capability surface.
const raw = readFileSync(join(import.meta.dir, '..', 'cordis.patch.yml'), 'utf8');
const doc = Bun.YAML.parse(raw.replace(/!!js\s+/g, '')) as Array<{ insert?: Array<Record<string, any>> }>;
const rows = doc.flatMap((step) => step.insert ?? []);
const preset = rows.find((row) => row.name === '@deepseek-ai/dsh-agent-preset' && row.config?.id === 'butler');

test('consumer tools mount at root without modifying ordinary presets', () => {
  expect(rows.filter(row => row.name === 'dsh-butler/consumer')).toEqual([
    { id: 'butler-consumer', name: 'dsh-butler/consumer' },
  ]);
});

test('butler preset is declared with a restricted plugin set', () => {
  expect(preset).toBeDefined();
  const names = (preset!.config.plugins as Array<{ name: string }>).map((p) => p.name);
  expect(names).toContain('dsh-butler/agent');
  expect(names).toContain('@deepseek-ai/dsh-persona');
  expect(names).toContain('@deepseek-ai/dsh-tool-fs-search');
  for (const banned of ['dsh-tool-bash', 'dsh-tool-bash-persistent', 'dsh-tool-pwsh', 'dsh-tool-fs', 'dsh-tool-web', 'dsh-tool-subagent', 'dsh-tool-workflow', 'dsh-tool-str-replace-editor', 'dsh-tool-cordis', 'dsh-terminal']) {
    expect(names).not.toContain(`@deepseek-ai/${banned}`);
  }
  expect(names.every((n) => n !== 'cordis:group')).toBe(true);
});

test('persona states the suggest-only contract and the panel row stays first', () => {
  const persona = preset!.config.plugins.find((p: { name: string }) => p.name === '@deepseek-ai/dsh-persona');
  expect(persona.config.prefix).toContain('butler_candidate');
  expect(persona.config.prefix).toMatch(/不能写卡|不能.*替主人决定/);
  // the flows it teaches must be tools that still exist
  for (const gone of ['butler_propose', 'butler_proposals', 'butler_report_gather', 'butler_report_write', '日报']) expect(persona.config.prefix).not.toContain(gone);
  expect(preset!.config.description).not.toMatch(/提案|汇报/);
  expect(rows[0]).toMatchObject({ id: 'butler-panel', name: 'dsh-butler' });
});
