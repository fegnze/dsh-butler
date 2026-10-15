import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const python = '/Users/ghost/MySpace/.venv/bin/python'
const moduleDir = join(import.meta.dir, '../skeleton/faculties/journal/bin')

function scenario(code: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pipeline-cards-')))
  try {
    const p = spawnSync(python, ['-c', code], { env: { ...process.env, CARD_ROOT: root, MODULE_DIR: moduleDir }, encoding: 'utf8' })
    expect(p.status, p.stderr).toBe(0)
    return JSON.parse(p.stdout)
  } finally { rmSync(root, { recursive: true, force: true }) }
}

describe('pipeline cards real behavior', () => {
  test('revise and archive CAS actual target revisions; duplicate submissions suppressed', () => {
    const result = scenario(`
import json, os, sys
from pathlib import Path
sys.path.insert(0, os.environ['MODULE_DIR'])
from _pipeline_cards import Cards, CardError
root=Path(os.environ['CARD_ROOT']); (root/'runs').mkdir(); (root/'etc').mkdir(); (root/'etc/knowledge-store.json').write_text(json.dumps({'version':1,'active':'wiki'}))
(root/'runs/r.json').write_text(json.dumps({'runToken':'tok','inputHash':'ih','status':'running','leaseUntil':9999999999,'sourceIds':['s'],'generatedCandidates':[]}))
c=Cards(root, lambda sid: {'messages':[{'id':'m','content':'body'}]})
a={'runId':'r','runToken':'tok','inputHash':'ih','kind':'knowledge','operation':'create','title':'Title','summary':'Summary','rationale':'Evidence fixture','scope':'local','body':'body','evidence':[{'sourceId':'s','messageIds':['m']}]}
def submit(**kw): return c.handle('candidates.submit',{**a,**kw})
def approve(x,key): return c.handle('candidates.approve',{'id':x['id'],'actor':'human-ui','revision':x['revision'],'contentHash':x['contentHash'],'idempotencyKey':key})
x=submit(); assert submit()['id']==x['id']; target=approve(x,'create')['card']['id']
y=submit(operation='revise',targetId=target,baseRevision=1,body='revision two'); stale=submit(operation='archive',targetId=target,baseRevision=1)
assert approve(y,'revise')['card']['revision']==2
try: approve(stale,'stale'); raise AssertionError('stale archive accepted')
except CardError as e: assert e.code=='revision_conflict'
z=submit(operation='archive',targetId=target,baseRevision=2); archived=approve(z,'archive')['card']
assert archived['revision']==3 and archived['status']=='archived'
assert c.handle('cards.search',{})['items']==[]
print(json.dumps({'revision':archived['revision'],'status':archived['status']}))
`)
    expect(result).toEqual({ revision: 3, status: 'archived' })
  })

  test('create is hidden until approval, then searchable and approval is idempotent', () => {
    const result = scenario(`
import json, os, sys
from pathlib import Path
sys.path.insert(0, os.environ['MODULE_DIR'])
from _pipeline_cards import Cards, CardError
root=Path(os.environ['CARD_ROOT']); (root/'runs').mkdir(); (root/'etc').mkdir(); (root/'etc/knowledge-store.json').write_text(json.dumps({'version':1,'active':'wiki'}))
(root/'runs/r.json').write_text(json.dumps({'runToken':'tok','inputHash':'ih','status':'running','leaseUntil':9999999999,'sourceIds':['s'],'generatedCandidates':[]}))
c=Cards(root, lambda sid: {'messages':[{'id':'m','content':'body'}]})
a={'runId':'r','runToken':'tok','inputHash':'ih','kind':'knowledge','operation':'create','title':'Title','summary':'Summary','rationale':'Evidence fixture','scope':'local','body':'body','evidence':[{'sourceId':'s','messageIds':['m']}],'title':'Title'}
created=c.handle('candidates.submit',a)
assert c.handle('cards.search', {'query':'body'})['items']==[]
review={'id':created['id'],'actor':'human-ui','revision':1,'contentHash':created['contentHash'],'idempotencyKey':'k'}
approved=c.handle('candidates.approve',review); again=c.handle('candidates.approve',review)
assert approved==again and c.handle('cards.search', {'query':'body'})['items'][0]['status']=='active'
print(json.dumps({'created':created['status'],'decisionId':approved['decisionId'],'found':len(c.handle('cards.search',{'query':'body'})['items'])}))
`)
    expect(result).toEqual(expect.objectContaining({ created: 'pending', found: 1 }))
  })

  test('reject is terminal and malformed transactions fail closed', () => {
    const result = scenario(`
import json, os, sys
from pathlib import Path
sys.path.insert(0, os.environ['MODULE_DIR'])
from _pipeline_cards import Cards, CardError
root=Path(os.environ['CARD_ROOT']); (root/'runs').mkdir(); (root/'etc').mkdir(); (root/'etc/knowledge-store.json').write_text(json.dumps({'version':1,'active':'wiki'}))
(root/'runs/r.json').write_text(json.dumps({'runToken':'tok','inputHash':'ih','status':'running','leaseUntil':9999999999,'sourceIds':['s']}))
c=Cards(root, lambda sid: {'messages':[{'id':'m','content':'body'}]})
a={'runId':'r','runToken':'tok','inputHash':'ih','kind':'rule','operation':'create','title':'Title','summary':'Summary','rationale':'Evidence fixture','scope':'local','body':'body','evidence':[{'sourceId':'s','messageIds':['m']}]}
x=c.handle('candidates.submit',a); review={'id':x['id'],'actor':'human-ui','revision':1,'contentHash':x['contentHash'],'idempotencyKey':'reject'}
c.handle('candidates.reject',review)
try: c.handle('candidates.approve',{**review,'idempotencyKey':'approve'}); raise AssertionError('approve after reject')
except CardError as e: assert e.code=='already_decided'
(root/'transactions').mkdir(exist_ok=True); (root/'transactions/bad.json').write_text('{broken')
try: c.recover(); raise AssertionError('bad transaction swallowed')
except CardError as e: assert e.code=='corrupt'
print(json.dumps({'rejected':True,'failClosed':True}))
`)
    expect(result).toEqual({ rejected: true, failClosed: true })
  })
})
