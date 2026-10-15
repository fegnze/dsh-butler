import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function scenario(body: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'butler-safety-')));
  try {
    const code = `import sys,json,time\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1])\nfrom _pipeline_store import Store,PipelineError\nfrom _pipeline_cards import Cards,CardError\nroot=Path(sys.argv[2]); store=Store(root)\n(root/'etc').mkdir(); (root/'etc/knowledge-store.json').write_text(json.dumps({'version':1,'active':'wiki'}))\n${body}`;
    const out = Bun.spawnSync(['/Users/ghost/MySpace/.venv/bin/python', '-c', code, join(import.meta.dir, '../skeleton/faculties/journal/bin'), root]);
    expect(out.exitCode, out.stderr.toString()).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('legacy or corrupt store marker blocks Wiki reads and transaction replay', () => scenario(`
with store.lock():
    marker=root/'etc/knowledge-store.json'
    for value in ({'version':1,'active':'legacy'}, {'version':2,'active':'wiki'}, None):
        marker.write_text(json.dumps(value))
        for action in ('cards.search','cards.read','candidates.approve'):
            try: Cards(root).handle(action,{});raise AssertionError('inactive store allowed '+action)
            except CardError as e: assert e.code=='store_not_active'
    tx=root/'transactions';tx.mkdir()
    (tx/'pending.json').write_text(json.dumps({'version':1,'writes':[{'path':'wiki/rule/blocked.md','payload':'blocked'}]}))
    try: Cards(root).recover();raise AssertionError('inactive replay accepted')
    except CardError as e: assert e.code=='store_not_active'
    assert not (root/'wiki').exists()
`));

test('zero-candidate completion requires reason and expired lease never covers input', () => scenario(`
with store.lock():
    store.handle('sessions.ingest',{'source':'test','externalSessionId':'s','segmentId':'t','revision':1,'messages':[{'id':'m','role':'user','content':'evidence','sequence':1}]})
    run=store.handle('distill.claim',{})
    args={k:run[k] for k in ('runId','runToken','inputHash')};args['candidateIds']=[]
    try: store.handle('distill.complete',args);raise AssertionError('empty result without reason accepted')
    except PipelineError: pass
    p=root/'runs'/(run['runId']+'.json'); r=json.loads(p.read_text());r['leaseUntil']=0;p.write_text(json.dumps(r))
    try: store.handle('distill.complete',{**args,'reason':'no durable fact'});raise AssertionError('expired lease accepted')
    except PipelineError: pass
    assert json.loads(p.read_text())['status']=='running'
`));

test('interrupted multi-file transaction replays fully before later operations', () => scenario(`
with store.lock():
    cards=Cards(root)
    original=cards._replace
    def interrupted(path,payload):
        if path.parent.name=='decisions': raise OSError('simulated interruption')
        original(path,payload)
    cards._replace=interrupted
    try: cards._commit([('runs/recovery.json','{}'),('decisions/recovery.json','{}')]);raise AssertionError('failure not injected')
    except OSError: pass
    assert list((root/'transactions').glob('*.json'))
    Cards(root).recover()
    assert (root/'runs/recovery.json').read_text()=='{}'
    assert (root/'decisions/recovery.json').read_text()=='{}'
    assert not list((root/'transactions').glob('*.json'))
`));

test('candidate rejects bad quotes and formal reads reject tampered body', () => scenario(`
with store.lock():
    src=store.handle('sessions.ingest',{'source':'test','externalSessionId':'s','segmentId':'t','revision':1,'messages':[{'id':'m','role':'user','content':'actual evidence','sequence':1}]})
    run=store.handle('distill.claim',{})
    cards=Cards(root,lambda sid:store.handle('sessions.read',{'id':sid}))
    a={k:run[k] for k in ('runId','runToken','inputHash')};a.update(kind='knowledge',operation='create',title='title',summary='summary',body='body',scope='local',rationale='reason',evidence=[{'sourceId':src['id'],'messageIds':['m'],'quote':'invented quote'}])
    try: cards.handle('candidates.submit',a);raise AssertionError('false quote accepted')
    except CardError as e: assert e.code=='invalid_evidence'
    a['evidence'][0]['quote']='actual evidence';c=cards.handle('candidates.submit',a)
    approved=cards.handle('candidates.approve',{'id':c['id'],'revision':c['revision'],'contentHash':c['contentHash'],'actor':'human-ui','idempotencyKey':'safe'})
    p=root/'wiki/knowledge'/(approved['card']['id']+'.md');p.write_text(p.read_text()+'tampered')
    try: cards.handle('cards.read',{'id':approved['card']['id']});raise AssertionError('tampered card read')
    except CardError as e: assert e.code=='corrupt'
`));
