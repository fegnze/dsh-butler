import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const python = '/Users/ghost/MySpace/.venv/bin/python'
const moduleDir = join(import.meta.dir, '../skeleton/faculties/journal/bin')
const pipeline = join(moduleDir, 'pipeline')

/** Real faculty code against a throwaway self root and validity root. */
function scenario(code: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeline-validity-')))
  const self = join(root, 'self'); const docs = join(root, 'docs')
  mkdirSync(self); mkdirSync(docs)
  try {
    const p = spawnSync(python, ['-c', PRELUDE + code], {
      env: { ...process.env, CARD_ROOT: self, DOCS: docs, MODULE_DIR: moduleDir, PIPELINE: pipeline, BUTLER_VALIDITY_ROOT: docs },
      encoding: 'utf8',
    })
    expect(p.status, p.stderr).toBe(0)
    return JSON.parse(p.stdout)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

const PRELUDE = `
import json, os, subprocess, sys
from pathlib import Path
sys.path.insert(0, os.environ['MODULE_DIR'])
from _pipeline_cards import Cards, CardError
root=Path(os.environ['CARD_ROOT']); docs=Path(os.environ['DOCS'])
(root/'runs').mkdir(); (root/'etc').mkdir(); (root/'etc/knowledge-store.json').write_text(json.dumps({'version':1,'active':'wiki'}))
def new_run(rid):
    (root/'runs'/(rid+'.json')).write_text(json.dumps({'runToken':'tok','inputHash':'ih','status':'running','leaseUntil':9999999999,'sourceIds':['s'],'generatedCandidates':[]}))
new_run('r')
c=Cards(root, lambda sid: {'messages':[{'id':'m','content':'quoted evidence CherryStudio'}]})
base={'runId':'r','runToken':'tok','inputHash':'ih','kind':'knowledge','operation':'create','title':'Rule source','summary':'Where the rule lives','rationale':'fixture','body':'Rules live in AGENTS.md.','evidence':[{'sourceId':'s','messageIds':['m'],'quote':'quoted evidence CherryStudio'}]}
def submit(**kw): return c.handle('candidates.submit',{**base,**kw})
def decide(x,ok,key): return c.handle('candidates.approve' if ok else 'candidates.reject',{'id':x['id'],'actor':'human-ui','revision':x['revision'],'contentHash':x['contentHash'],'idempotencyKey':key})
def unavailable(ident):
    try: c.handle('cards.read',{'id':ident}); return False
    except CardError as e: return e.code=='card_unavailable'
def ids(**kw): return [x['id'] for x in c.handle('cards.search',{'query':'',**kw})['items']]
`

describe('formal card validity', () => {
  test('failing checks suspend a card for every consumer, passing checks restore it; refresh is idempotent', () => {
    const result = scenario(`
(docs/'AGENTS.md').write_text('# Rules\\nAGENTS.md is the only rule source.\\n')
card=decide(submit(checks=[{'type':'quote','path':'AGENTS.md','text':'AGENTS.md is the  only rule source.'}]),True,'a')['card']
cid=card['id']
assert ids()==[cid] and c.handle('cards.read',{'id':cid})['validity']['state']=='valid'
first=(root/'validity'/(cid+'.json')).read_bytes()
assert c.handle('validity.refresh',{})['changed']==0 and (root/'validity'/(cid+'.json')).read_bytes()==first
(docs/'AGENTS.md').write_text('# Rules\\nRules moved elsewhere.\\n')
assert ids()==[] and unavailable(cid)
owner=c.handle('cards.read',{'id':cid,'includeInactive':True})
assert owner['usable'] is False and owner['validity']['reasons'][0]['code']=='check_failed'
assert [x['id'] for x in c.handle('cards.search',{'query':'','includeInactive':True})['items']]==[cid]
suspended=(root/'validity'/(cid+'.json')).read_bytes()
assert c.handle('validity.refresh',{})['changed']==0 and (root/'validity'/(cid+'.json')).read_bytes()==suspended
(docs/'AGENTS.md').write_text('AGENTS.md is the only rule source.')
assert ids()==[cid] and c.handle('cards.read',{'id':cid})['usable'] is True
hist=json.loads((root/'validity'/(cid+'.json')).read_text())['history']
# the card file itself never changed: no re-injection churn
assert c.handle('cards.read',{'id':cid})['contentHash']==card['contentHash']
print(json.dumps({'states':[h['state'] for h in hist]}))
`)
    expect(result).toEqual({ states: ['valid', 'suspended', 'valid'] })
  })

  test('archived cards are withheld from consumer read; search ignores evidence and metadata', () => {
    const result = scenario(`
x=decide(submit(body='Plain body.'),True,'a')['card']
assert ids()==[x['id']]
assert c.handle('cards.search',{'query':'CherryStudio'})['items']==[]  # evidence quote only
assert c.handle('cards.search',{'query':'decisionId'})['items']==[]   # frontmatter keys only
assert len(c.handle('cards.search',{'query':'where the rule'})['items'])==1
z=decide(submit(operation='archive',targetId=x['id'],baseRevision=1),True,'z')['card']
assert z['status']=='archived' and ids()==[] and unavailable(x['id'])
assert c.handle('cards.read',{'id':x['id'],'includeInactive':True})['status']=='archived'
print(json.dumps({'ok':True}))
`)
    expect(result).toEqual({ ok: true })
  })

  test('scope is visibility; free text becomes appliesTo for new and already approved cards', () => {
    const result = scenario(`
x=decide(submit(scope='MySpace / Butler 插件 / 卡片审阅界面'),True,'a')['card']
assert x['scope']=='local' and x['appliesTo']=='MySpace / Butler 插件 / 卡片审阅界面'
y=decide(submit(title='Second',appliesTo='Butler UI'),True,'b')['card']
assert y['scope']=='local' and y['appliesTo']=='Butler UI'
# legacy card written before the split: free-text scope is read as applicability
m={'id':'legacy-x','kind':'knowledge','status':'active','revision':1,'title':'Legacy','summary':'s','scope':'Some project','tags':[],'links':[],'evidence':[]}
m['contentHash']=Cards._hash('legacy body',m); (root/'wiki/knowledge/legacy-x.md').write_text(Cards._dump(m,'legacy body'))
legacy=c.handle('cards.read',{'id':'legacy-x'})
assert legacy['scope']=='local' and legacy['appliesTo']=='Some project'
assert sorted(ids(scope='local'))==sorted([x['id'],y['id'],'legacy-x'])
print(json.dumps({'ok':True}))
`)
    expect(result).toEqual({ ok: true })
  })

  test('a conflict suspends the target until the owner rejects or approves the conflicting draft', () => {
    const result = scenario(`
card=decide(submit(),True,'a')['card']; cid=card['id']
new_run('r2'); base.update(runId='r2')
conflict=submit(operation='revise',targetId=cid,baseRevision=1,body='Rules now live in RULES.md.',conflict='AGENTS.md is no longer the rule source')
assert ids()==[] and unavailable(cid)
assert c.handle('cards.read',{'id':cid,'includeInactive':True})['validity']['reasons'][0]['candidateId']==conflict['id']
decide(conflict,False,'reject')
assert ids()==[cid]
new_run('r3'); base.update(runId='r3')
again=submit(operation='revise',targetId=cid,baseRevision=1,body='Rules now live in RULES.md, version two.',conflict='superseded')
assert unavailable(cid)
revised=decide(again,True,'approve')['card']
assert revised['revision']==2 and ids()==[cid] and c.handle('cards.read',{'id':cid})['validity']['state']=='valid'
try: submit(operation='create',conflict='x'); raise AssertionError('conflict on create')
except CardError as e: assert e.code=='invalid_candidate'
print(json.dumps({'ok':True}))
`)
    expect(result).toEqual({ ok: true })
  })

  test('checks are validated, run at submit time and rejected for profile cards; pipeline claim refreshes', () => {
    const result = scenario(`
(docs/'README.md').write_text('hello')
for bad in ([{'type':'path','path':'../etc/passwd'}],[{'type':'path','path':'/etc/passwd'}],[{'type':'quote','path':'README.md'}],[{'type':'shell','path':'x'}]):
    try: submit(checks=bad); raise AssertionError('accepted '+json.dumps(bad))
    except CardError as e: assert e.code=='invalid_candidate', e.code
try: submit(checks=[{'type':'path','path':'missing.md'}]); raise AssertionError('failing check accepted')
except CardError as e: assert 'check fails now' in str(e)
try: submit(kind='profile',checks=[{'type':'path','path':'README.md'}]); raise AssertionError('profile checks')
except CardError as e: assert e.code=='invalid_candidate'
cid=decide(submit(checks=[{'type':'path','path':'README.md'}]),True,'a')['card']['id']
(docs/'README.md').unlink()
for p in (root/'runs').glob('*.json'): p.unlink()  # synthetic runs lack the store's manifest
env={**os.environ,'BUTLER_SELF_ROOT':str(root)}
out=json.loads(subprocess.run([sys.executable,os.environ['PIPELINE']],input=json.dumps({'action':'distill.claim','args':{}}),capture_output=True,text=True,env=env).stdout)
assert out['ok'], out
rec=json.loads((root/'validity'/(cid+'.json')).read_text())
print(json.dumps({'state':rec['state'],'claimOk':out['ok']}))
`)
    expect(result).toEqual({ state: 'suspended', claimOk: true })
  })
})
