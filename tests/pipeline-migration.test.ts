import { test, expect, describe, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const PY = "/Users/ghost/MySpace/.venv/bin/python";
const MOD = join(import.meta.dir, '../skeleton/faculties/journal/bin');
const fixtures: string[] = [];
afterEach(async () => {
  for (const container of fixtures.splice(0)) {
    if (!container.startsWith(await realpath(tmpdir()) + '/') || !container.split('/').at(-1)?.startsWith('migration-')) throw new Error('unexpected fixture path');
    await rm(container, { recursive: true, force: true });
  }
});
function call(root: string, action: string, args: Record<string, unknown> = {}) {
  const code = `import json,sys; from _pipeline_migration import Migration; print(json.dumps(Migration(sys.argv[1]).handle(sys.argv[2],json.loads(sys.argv[3]))))`;
  const r = spawnSync(PY, ["-c", code, root, action, JSON.stringify(args)], { env: { ...process.env, PYTHONPATH: MOD }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return JSON.parse(r.stdout);
}
async function fixture() {
  const container = await realpath(await mkdtemp(join(tmpdir(), "migration-")));
  fixtures.push(container);
  const root = join(container, "self");
  await mkdir(root, { recursive: true });
  await mkdir(join(container, "faculties", "journal", "bin"), { recursive: true });
  for (const name of ['_legacy_guard.py','memory','proposals','migrate-rules']) {
    await writeFile(join(container, 'faculties/journal/bin', name), await readFile(join(MOD, name)));
  }
  await writeFile(join(root, "rules.md"), ""); // unrelated file must not be imported
  await mkdir(join(root, "rules"), { recursive: true });
  await Bun.write(join(root, "rules", "policy.md"), "---\ntitle: Policy\napprovedAt: 7\ncustom: kept\n---\nkeep this body\n");
  await mkdir(join(root, "knowledge"), { recursive: true });
  await mkdir(join(root, "persona"), { recursive: true });
  await Bun.write(join(root, "knowledge", "fact.md"), "fact body");
  await Bun.write(join(root, "persona", "profile.md"), "profile body\n");
  return root;
}

describe("Migration", () => {
  test('empty activation preserves pending drafts and imports no formal cards', async () => {
    const root = await fixture(); const plan = call(root, 'migration.plan');
    const args = { confirmed: true, planHash: plan.planHash };
    call(root, 'migration.stage-review', args);
    const path = join(root, 'candidates', plan.sources[0].id + '.md');
    const before = await readFile(path, 'utf8');
    expect(() => call(root, 'migration.activate-empty', { planHash: plan.planHash })).toThrow();
    expect(call(root, 'migration.activate-empty', args).formalCards).toBe(0);
    expect(call(root, 'migration.activate-empty', args).unchanged).toBe(true);
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(await readdir(root)).not.toContain('wiki');
    expect(JSON.parse(await readFile(join(root, 'etc/knowledge-store.json'), 'utf8')).active).toBe('wiki');
  });
  test('stage-review preserves old files and creates only pending drafts idempotently', async () => {
    const root = await fixture();
    const before = await readFile(join(root, 'rules/policy.md'), 'utf8');
    const plan = call(root, 'migration.plan');
    expect(() => call(root, 'migration.stage-review', { planHash: plan.planHash })).toThrow();
    const args = { planHash: plan.planHash, confirmed: true };
    expect(call(root, 'migration.stage-review', args).created).toBe(3);
    expect(call(root, 'migration.stage-review', args).skipped).toBe(3);
    expect(await readFile(join(root, 'rules/policy.md'), 'utf8')).toBe(before);
    expect(await readdir(root)).not.toContain('wiki');
    expect(await readdir(root)).not.toContain('etc');
    const candidate = await readFile(join(root, 'candidates', plan.sources[0].id + '.md'), 'utf8');
    expect(candidate).toContain('"status":"pending"');
    expect(candidate).toContain('legacySourceHash');
  });
  test("plan is read-only and source changes invalidate it", async () => {
    const root = await fixture();
    const before = [...await readdir(root)]; const plan = call(root, "migration.plan");
    expect(plan.readOnly).toBe(true); expect(plan.sources).toHaveLength(3); expect([...await readdir(root)]).toEqual(before);
    await Bun.write(join(root, "knowledge", "fact.md"), "changed");
    expect(() => call(root, "migration.apply", { confirmed: true, planHash: plan.planHash })).toThrow();
  });
  test("requires confirmation, preserves metadata/body hash, switches marker, and is idempotent", async () => {
    const root = await fixture(); const plan = call(root, "migration.plan");
    expect(() => call(root, "migration.apply", { planHash: plan.planHash })).toThrow();
    const out = call(root, "migration.apply", { confirmed: true, planHash: plan.planHash }); expect(out.marker.active).toBe("wiki");
    const card = JSON.parse(JSON.stringify(call(root, "migration.rollback-plan", { planHash: plan.planHash })));
    expect(card.wikiDiff.length).toBe(3);
    const id = "legacy-" + createHash("sha256").update("rule:rules/policy.md").digest("hex").slice(0, 24);
    const migrated = await readFile(join(root, "wiki", "rule", id + ".md"), "utf8");
    expect(migrated).toContain('"approvedAt":7');
    expect(migrated).toContain('"custom":"kept"');
    expect(await readFile(join(root, "etc", "knowledge-store.json"), "utf8")).toContain('"active":"wiki"');
    expect(call(root, "migration.apply", { confirmed: true, planHash: plan.planHash })).toEqual(out);
  });
  test("rollback-plan is read-only and reports hashes", async () => {
    const root = await fixture(); const plan = call(root, "migration.plan");
    call(root, "migration.apply", { confirmed: true, planHash: plan.planHash });
    const before = await readFile(join(root, "etc", "knowledge-store.json"), "utf8");
    const rb = call(root, "migration.rollback-plan"); expect(rb.readOnly).toBe(true); expect(rb.wikiDiff.every((x: any) => x.currentHash && x.migrationHash)).toBe(true);
    expect(await readFile(join(root, "etc", "knowledge-store.json"), "utf8")).toBe(before);
  });
  test("rejects unsafe hashes, corrupt markers, and symlink sources", async () => {
    const root = await fixture();
    expect(() => call(root, "migration.apply", { confirmed: true, planHash: "../etc" })).toThrow();
    await mkdir(join(root, "etc"), { recursive: true });
    await writeFile(join(root, "etc", "knowledge-store.json"), JSON.stringify({ version: 9, active: "wiki" }));
    expect(() => call(root, "migration.plan")).toThrow();
    const root2 = await fixture();
    await symlink(join(root2, "knowledge", "fact.md"), join(root2, "knowledge", "link.md"));
    expect(() => call(root2, "migration.plan")).toThrow();
  });
  test("resumes a write-ahead migration after injected crash", async () => {
    const root = await fixture(); const plan = call(root, "migration.plan");
    const crashed = spawnSync(PY, ["-c", `import json,sys; from _pipeline_migration import Migration; print(Migration(sys.argv[1]).handle('migration.apply',json.loads(sys.argv[2])))`, root, JSON.stringify({ confirmed: true, planHash: plan.planHash })], { env: { ...process.env, PYTHONPATH: MOD, PIPELINE_MIGRATION_FAIL_AFTER: "2" }, encoding: "utf8" });
    expect(crashed.status).not.toBe(0);
    expect(call(root, "migration.apply", { confirmed: true, planHash: plan.planHash }).marker.active).toBe("wiki");
  });
});
