"""Safe persistence for journal capture and distillation runs."""
from __future__ import annotations
import contextlib, fcntl, hashlib, json, os, re, secrets, stat, tempfile, time
from pathlib import Path

class PipelineError(Exception):
    def __init__(self, code: str, message: str): self.code,self.message=code,message; super().__init__(f"{code}: {message}")

def canonical(value): return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(",",":")).encode()
def canonical_hash(value): return hashlib.sha256(canonical(value)).hexdigest()
def _atomic(path,data):
    path.parent.mkdir(parents=True,exist_ok=True); fd,tmp=tempfile.mkstemp(prefix='.'+path.name+'.',dir=str(path.parent))
    try:
        with os.fdopen(fd,'wb') as f: f.write(data); f.flush(); os.fsync(f.fileno())
        os.replace(tmp,path)
        parent_fd=os.open(path.parent,os.O_RDONLY)
        try:os.fsync(parent_fd)
        finally:os.close(parent_fd)
    finally:
        with contextlib.suppress(FileNotFoundError): os.unlink(tmp)
def atomic_json(path,value): _atomic(path,(json.dumps(value,ensure_ascii=False,sort_keys=True,indent=2)+'\n').encode())
def read_json(path,default=None):
    try:return json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:return default
    except (ValueError,UnicodeDecodeError) as e:raise PipelineError('corrupt',f'invalid JSON: {path}') from e
@contextlib.contextmanager
def global_lock(root):
    root=Path(root)
    if any(p.is_symlink() for p in (root,*root.parents)):raise PipelineError('unsafe_path','symlink lock root')
    root.mkdir(parents=True,exist_ok=True)
    fd=os.open(root/'.pipeline.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd);raise PipelineError('unsafe_path','lock is not a regular file')
    with os.fdopen(fd,'a') as f:
        fcntl.flock(f,fcntl.LOCK_EX)
        try:yield
        finally:fcntl.flock(f,fcntl.LOCK_UN)
def write_md(path,meta,body):
    _atomic(path,('---\n'+''.join(f'{k}: {json.dumps(v,ensure_ascii=False,sort_keys=True)}\n' for k,v in meta.items())+'---\n\n'+body).encode());return hashlib.sha256(body.encode()).hexdigest()
def read_md(path):
    raw=path.read_text(encoding='utf-8')
    if not raw.startswith('---\n') or '\n---\n' not in raw[4:]:raise PipelineError('corrupt','invalid markdown frontmatter')
    end=raw.find('\n---\n',4);meta={}
    for line in raw[4:end].splitlines():
        k,sep,v=line.partition(':')
        if sep:
            try:meta[k]=json.loads(v)
            except ValueError as e:raise PipelineError('corrupt','invalid frontmatter value') from e
    body=raw[end+5:];return meta,body,hashlib.sha256(body.encode()).hexdigest()
_SECRET=re.compile(r'(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+|(api[_-]?key|password|private[_-]?key|secret|token)(\s*[=:]\s*)[^\s,;]+')
def redact(v):
    if isinstance(v,str):return _SECRET.sub(lambda m:(m.group(1)+'[REDACTED]') if m.group(1) else m.group(2)+(m.group(3) or '')+'[REDACTED]',v)
    if isinstance(v,list):return [redact(x) for x in v]
    if isinstance(v,dict):return {k:redact(x) for k,x in v.items()}
    return v
class Store:
    def __init__(self,root):
        self.root=Path(root).absolute()
        self._path()
    def _path(self,*parts):
        for a in (self.root,*self.root.parents):
            if a.is_symlink():raise PipelineError('unsafe_path',str(a))
        cur=self.root
        for part in parts:
            if not isinstance(part,str) or not part or part in ('.','..') or '/' in part or '\\' in part:raise PipelineError('unsafe_path','invalid path component')
            cur=cur/part
            if cur.is_symlink():raise PipelineError('unsafe_path',str(cur))
        try:cur.resolve(strict=False).relative_to(self.root.resolve(strict=False))
        except ValueError:raise PipelineError('unsafe_path','outside root')
        return cur
    def resolve(self,relative):
        p=Path(relative)
        if p.is_absolute() or '..' in p.parts:raise PipelineError('unsafe_path','expected relative path')
        return self._path(*p.parts)
    @contextlib.contextmanager
    def lock(self):
        self._path('.pipeline.lock')
        with global_lock(self.root): yield
    def _ensure(self):
        for d in ('sources','sessions','runs'):self._path(d).mkdir(parents=True,exist_ok=True)
    def _save(self,parts,v):self._ensure();atomic_json(self._path(*parts),v)
    def _load(self,parts,default=None):return read_json(self._path(*parts),default)
    def _sid(self,s,e):return hashlib.sha256((s+'\0'+e).encode()).hexdigest()[:32]
    def _segfile(self,seg,rev):return canonical_hash([str(seg),rev])[:24]+'.json'
    def ingest(self,a):
        source,ext=a.get('source'),a.get('externalSessionId');rev,seg=a.get('revision'),a.get('segmentId')
        if not isinstance(source,str) or not source or not isinstance(ext,str) or not ext or not isinstance(rev,int) or rev<0 or not isinstance(seg,(str,int)):raise PipelineError('invalid','source/externalSessionId/revision/segmentId required')
        ms=a.get('messages')
        if not isinstance(ms,list) or len(ms)>1000:raise PipelineError('invalid','messages must be an array of at most 1000 entries')
        if type(rev) is not int or rev<1 or not str(seg).strip():raise PipelineError('invalid','positive revision and nonempty segment required')
        if a.get('integrity','partial') not in ('complete','partial'):raise PipelineError('invalid','invalid integrity')
        msgs=[];seen=set()
        for i,m in enumerate(ms):
            if not isinstance(m,dict) or m.get('role') not in ('user','assistant','system','tool') or 'content' not in m or not isinstance(m.get('content'),(str,list,dict)):raise PipelineError('invalid','invalid message')
            if m.get('hiddenReasoning') is True:raise PipelineError('invalid','hidden reasoning is not ingestible')
            if not isinstance(m.get('id'),str) or not m['id'].strip() or type(m.get('sequence')) is not int or m['sequence']<0 or not isinstance(m.get('content'),str):raise PipelineError('invalid','message id, sequence and text content required')
            mid=m['id']
            if mid in seen:raise PipelineError('invalid','duplicate message id')
            seen.add(mid);msgs.append(redact({'id':mid,'role':m['role'],'content':m['content'],'sequence':m.get('sequence',i),**({'name':m['name']} if 'name' in m else {})}))
        digest=canonical_hash(msgs);sid=self._sid(source,ext);idx=self._load(('sessions',sid,'index.json'),{});old=idx.get('segments',{}).get(str(seg))
        if old:
            if rev==old.get('revision') and digest==old.get('contentHash'):return {'id':sid,'sourceId':sid,'segmentId':seg,'revision':rev,'contentHash':digest,'idempotent':True}
            if rev<=old.get('revision',-1):raise PipelineError('revision_conflict','same or older revision differs')
        rec={'source':source,'externalSessionId':ext,'workspace':a.get('workspace'),'title':a.get('title'),'captureMode':a.get('captureMode','transcript'),'integrity':a.get('integrity','partial'),'revision':rev,'segmentId':seg,'contentHash':digest,'messages':msgs}
        self._path('sessions',sid).mkdir(parents=True,exist_ok=True);fn=self._segfile(seg,rev);atomic_json(self._path('sessions',sid,fn),rec)
        idx.update({'source':source,'externalSessionId':ext});idx.setdefault('segments',{})[str(seg)]={'revision':rev,'contentHash':digest,'file':fn};self._save(('sessions',sid,'index.json'),idx);self._save(('sources',sid+'.json'),idx)
        return {'id':sid,'sourceId':sid,'segmentId':seg,'revision':rev,'contentHash':digest,'idempotent':False}
    def _segments(self,sid):
        idx=self._load(('sessions',sid,'index.json'),None)
        if idx is None:return []
        if not isinstance(idx,dict) or not isinstance(idx.get('segments'),dict):raise PipelineError('corrupt','invalid session index')
        result=[]
        for ref in idx['segments'].values():
            segment=self._load(('sessions',sid,ref['file']),None)
            if not isinstance(segment,dict) or not isinstance(segment.get('messages'),list) or canonical_hash(segment['messages'])!=ref.get('contentHash') or segment.get('contentHash')!=ref.get('contentHash') or segment.get('revision')!=ref.get('revision'):raise PipelineError('corrupt','session segment hash mismatch')
            result.append(segment)
        return result
    def list(self,a):
        out=[]; directory=self._path('sessions')
        if not directory.exists():return {'items':[]}
        for p in directory.iterdir():
            if p.is_symlink():raise PipelineError('unsafe_path','symlink session')
            if p.is_dir():
                detail=self.read({'id':p.name});out.append({k:v for k,v in detail.items() if k!='messages'})
        return {'items':out[:min(max(int(a.get('limit',50)),0),100)]}
    def read(self,a):
        sid=a.get('id') or a.get('sourceId');segs=self._segments(sid) if isinstance(sid,str) else []
        if not segs:raise PipelineError('not_found','session not found')
        segs.sort(key=lambda x:(str(x.get('segmentId')),x.get('revision',0)));msgs=[];seen=set()
        for s in segs:
            for m in s.get('messages',[]):
                if m.get('id') not in seen:seen.add(m.get('id'));msgs.append(m)
        msgs.sort(key=lambda m:m.get('sequence',0))
        covered=set(); claimed=set(); candidate_ids=set()
        runs=self._path('runs')
        for path in runs.glob('*.json') if runs.exists() else []:
            if path.is_symlink():raise PipelineError('unsafe_path','symlink run')
            run=read_json(path,{})
            manifest=[m for m in run.get('inputManifest',[]) if m.get('sourceId')==sid]
            if not manifest:continue
            candidate_ids.update(run.get('generatedCandidates',[]))
            keys={(str(m['segmentId']),m['revision'],m['contentHash']) for m in manifest}
            if run.get('status')=='succeeded':covered.update(keys)
            elif run.get('status')=='running' and run.get('leaseUntil',0)>time.time():claimed.update(keys)
        keys={(str(s['segmentId']),s['revision'],s['contentHash']) for s in segs}
        distill_status='covered' if keys.issubset(covered) else 'running' if keys & claimed else 'pending'
        return {'distillStatus':distill_status,'candidateCount':len(candidate_ids),'id':sid,'sourceId':sid,'source':segs[0].get('source'),'externalSessionId':segs[0].get('externalSessionId'),'title':segs[-1].get('title'),'workspace':segs[-1].get('workspace'),'captureMode':segs[-1].get('captureMode','transcript'),'segments':[{'segmentId':s.get('segmentId'),'revision':s.get('revision'),'contentHash':s.get('contentHash')} for s in segs],'messages':msgs,'integrity':'complete' if all(s.get('integrity')=='complete' for s in segs) else 'partial'}
    def claim(self,a):
        limit=a.get('limit',1);budget=a.get('maxChars',a.get('charBudget',100000))
        if type(limit) is not int or not 1<=limit<=20 or type(budget) is not int or not 1<=budget<=500000:raise PipelineError('invalid_request','invalid claim limit or character budget')
        self._ensure();chosen=[];used=0
        leased=set(); covered=set(); now=time.time()
        for rp in self._path('runs').glob('*.json'):
            if rp.is_symlink():raise PipelineError('unsafe_path','symlink run')
            if rp.name == 'runs.json':raise PipelineError('corrupt','unsupported legacy run index')
            rr=read_json(rp,{})
            if not isinstance(rr,dict) or rr.get('status') not in ('running','succeeded','failed') or not isinstance(rr.get('inputManifest'),list):raise PipelineError('corrupt','invalid run manifest')
            if isinstance(rr,dict) and rr.get('status')=='running' and float(rr.get('leaseUntil',0)) > now:
                leased.update((m.get('sourceId'),str(m.get('segmentId'))) for m in rr.get('inputManifest',[]))
            if isinstance(rr,dict) and rr.get('status')=='succeeded':
                covered.update((m.get('sourceId'),str(m.get('segmentId')),m.get('revision'),m.get('contentHash')) for m in rr.get('inputManifest',[]))
        for p in sorted(self._path('sessions').iterdir()):
            if p.is_symlink():raise PipelineError('unsafe_path','symlink session')
            if not p.is_dir():continue
            for s in self._segments(p.name):
                key=(p.name,str(s.get('segmentId')))
                if key in leased or (p.name,str(s.get('segmentId')),s.get('revision'),s.get('contentHash')) in covered: continue
                cost=len(json.dumps(s.get('messages',[]),ensure_ascii=False))
                if len(chosen)>=limit:break
                if used+cost>budget:
                    if not chosen:raise PipelineError('input_too_large','segment exceeds requested character budget; increase maxChars')
                    continue
                chosen.append(s);used+=cost
            if len(chosen)>=limit:break
        if not chosen:return {'runId':None,'sources':[]}
        rid=secrets.token_urlsafe(16);token=secrets.token_urlsafe(24);manifest=[{'sourceId':self._sid(s['source'],s['externalSessionId']),'segmentId':s['segmentId'],'revision':s['revision'],'contentHash':s['contentHash'],'messageIds':[message['id'] for message in s['messages']]} for s in chosen];ih=canonical_hash(manifest)
        run={'runId':rid,'runToken':token,'inputHash':ih,'status':'running','sourceIds':sorted({x['sourceId'] for x in manifest}),'inputManifest':manifest,'generatedCandidates':[],'leaseUntil':time.time()+900};self._save(('runs',rid+'.json'),run)
        return {'runId':rid,'runToken':token,'inputHash':ih,'sources':[{'id':m['sourceId'],'sourceId':m['sourceId'],'segmentId':s['segmentId'],'revision':s['revision'],'contentHash':s['contentHash'],'integrity':s.get('integrity','partial'),'captureMode':s.get('captureMode','transcript'),'title':s.get('title'),'workspace':s.get('workspace'),'messages':s['messages']} for m,s in zip(manifest,chosen)]}
    def append_generated_candidates(self,run_id,candidate_ids):
        r=self._load(('runs',run_id+'.json'),None)
        if not r:raise PipelineError('not_found','run not found')
        if not isinstance(candidate_ids,list) or not all(isinstance(x,str) for x in candidate_ids):raise PipelineError('invalid','candidate ids must be strings')
        for x in candidate_ids:
            if x not in r['generatedCandidates']:r['generatedCandidates'].append(x)
        self._save(('runs',run_id+'.json'),r)
    def complete(self,a):
        rid=a.get('runId');r=self._load(('runs',str(rid)+'.json'),None)
        if not r:raise PipelineError('not_found','run not found')
        ids=a.get('candidateIds')
        if not isinstance(ids,list) or any(not isinstance(x,str) for x in ids) or len(ids)!=len(set(ids)):raise PipelineError('candidate_mismatch','candidateIds must be unique')
        if r.get('status')=='succeeded':
            if secrets.compare_digest(str(r.get('runToken')),str(a.get('runToken'))) and a.get('inputHash')==r.get('inputHash') and set(ids)==set(r.get('candidateIds',[])):return {'ok':True,'idempotent':True}
            raise PipelineError('invalid_run','run already completed')
        if r.get('status')!='running' or time.time()>float(r.get('leaseUntil',0)):raise PipelineError('lease_expired','run lease expired')
        if not secrets.compare_digest(str(r.get('runToken')),str(a.get('runToken'))):raise PipelineError('unauthorized','invalid run token')
        if a.get('inputHash')!=r.get('inputHash'):raise PipelineError('input_mismatch','input hash mismatch')
        if set(ids)!=set(r.get('generatedCandidates',[])):raise PipelineError('candidate_mismatch','candidate set mismatch')
        if not ids and (not isinstance(a.get('reason'),str) or not a['reason'].strip()):raise PipelineError('invalid_reason','zero candidates require an explanation')
        for m in r.get('inputManifest',[]):
            idx=self._load(('sessions',m['sourceId'],'index.json'),None);cur=idx and idx.get('segments',{}).get(str(m['segmentId']))
            if not cur or cur.get('revision')!=m['revision'] or cur.get('contentHash')!=m['contentHash']:raise PipelineError('input_changed','input manifest changed')
        r.update({'status':'succeeded','candidateIds':ids,'completedAt':time.time(),'reason':a.get('reason')});self._save(('runs',rid+'.json'),r);return {'ok':True}
    def handle(self,action,args=None):
        fn={'sessions.ingest':self.ingest,'sessions.list':self.list,'sessions.read':self.read,'distill.claim':self.claim,'distill.complete':self.complete}.get(action)
        if not fn:raise PipelineError('unknown_action',action)
        return fn(args or {})
