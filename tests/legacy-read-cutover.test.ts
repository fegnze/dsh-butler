import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('legacy card reader switches exclusively to migrated Wiki and old compiler stops', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'butler-read-cutover-')));
  try {
    const code = `
import os,sys,json,subprocess,hashlib
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from _pipeline_cards import Cards
root=Path(sys.argv[2]);bin=Path(sys.argv[1]);env={**os.environ,'BUTLER_SELF_ROOT':str(root)}
(root/'persona').mkdir();(root/'persona/profile.md').write_text('OLD PRIVATE PROFILE')
def run(name,*args):return subprocess.run([sys.executable,str(bin/name),*args],env=env,capture_output=True,text=True)
assert run('card','profile').stdout=='OLD PRIVATE PROFILE'
(root/'etc').mkdir();(root/'etc/knowledge-store.json').write_text(json.dumps({'version':1,'active':'wiki'}))
for kind,source,body in [('profile','persona/profile.md','NEW PROFILE'),('knowledge','knowledge/fact.md','NEW FACT')]:
    ident='legacy-'+hashlib.sha256((kind+':'+source).encode()).hexdigest()[:24]
    m={'id':ident,'kind':kind,'status':'active','revision':1,'title':kind,'scope':'local','summary':body,'source':source,'links':[]};m['contentHash']=Cards._hash(body,m)
    path=root/'wiki'/kind/(ident+'.md');path.parent.mkdir(parents=True,exist_ok=True);path.write_text(Cards._dump(m,body))
assert run('card','profile').stdout.strip()=='NEW PROFILE'
assert run('card','knowledge/fact').stdout=='NEW FACT'
assert 'OLD PRIVATE PROFILE' not in run('card','all').stdout
assert run('build-context').returncode!=0
assert not (root/'build/context.md').exists()
(root/'etc/knowledge-store.json').write_text('{bad')
assert run('card','profile').returncode!=0
assert run('build-context').returncode!=0
`;
    const result = Bun.spawnSync(['/Users/ghost/MySpace/.venv/bin/python', '-c', code, join(import.meta.dir, '../skeleton/faculties/journal/bin'), root]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
