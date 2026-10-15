"""Crash-safe candidate and formal-card pipeline storage."""
from __future__ import annotations
import hashlib, json, os, re, secrets, time
from pathlib import Path
from typing import Any, Callable
import _pipeline_validity as validity

ID_RE=r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}'
# Visibility is a short token (local/team/...); anything else was free-text applicability.
VISIBILITY_RE=r'[a-z][a-z0-9-]{0,31}'
# Optional review fields added later; hashed only when present so older candidates keep their hashes.
OPTIONAL_REVIEW=('appliesTo','checks','conflict')

class CardError(Exception):
    def __init__(self, code: str, message: str, **details: Any):
        super().__init__(message); self.code=code; self.details=details

def _invalid_candidate(message: str):
    raise CardError('invalid_candidate', message)

def split_scope(scope, applies_to=None):
    """Return (visibility, appliesTo): free-text scopes describe applicability, not visibility."""
    if isinstance(scope,str) and re.fullmatch(VISIBILITY_RE,scope): return scope, applies_to
    if isinstance(scope,str) and scope.strip() and not applies_to: return 'local', scope.strip()
    return 'local', applies_to

class Cards:
    def __init__(self, root: Path, evidence_loader: Callable[[str], Any] | None = None):
        self.root=Path(root).absolute(); self.evidence_loader=evidence_loader
        if any(p.is_symlink() for p in (self.root,*self.root.parents)): raise CardError('unsafe_path','symlink root')

    def _safe(self, rel: str) -> Path:
        if not isinstance(rel,str) or not rel or rel.startswith('/') or '\\' in rel:
            raise CardError('unsafe_path','invalid path')
        p=Path(rel)
        if any(x in ('','.','..') for x in p.parts): raise CardError('unsafe_path','path traversal')
        out=(self.root/p).resolve()
        try: out.relative_to(self.root.resolve())
        except ValueError: raise CardError('unsafe_path','path outside root')
        cur=self.root
        for part in p.parts:
            cur=cur/part
            if cur.is_symlink(): raise CardError('unsafe_path','symlink path')
        return out

    def _read(self, rel: str) -> bytes | None:
        p=self._safe(rel)
        if not p.exists(): return None
        if p.is_symlink() or not p.is_file(): raise CardError('unsafe_path','not regular file')
        return p.read_bytes()

    @staticmethod
    def _sync_dir(path):
        fd=os.open(path,os.O_RDONLY)
        try: os.fsync(fd)
        finally: os.close(fd)

    def _replace(self,path,payload):
        tmp=path.with_name('.'+path.name+'.tmp-'+secrets.token_hex(8))
        with tmp.open('xb') as stream:
            stream.write(payload.encode('utf-8')); stream.flush(); os.fsync(stream.fileno())
        os.replace(tmp,path); self._sync_dir(path.parent)

    def require_wiki(self):
        raw=self._read('etc/knowledge-store.json')
        try: marker=json.loads(raw) if raw is not None else {}
        except (ValueError,TypeError): raise CardError('store_not_active','knowledge store marker is invalid')
        if not isinstance(marker,dict) or marker.get('version')!=1 or marker.get('active')!='wiki': raise CardError('store_not_active','Wiki must be explicitly activated by confirmed migration')

    def recover(self):
        td=self.root/'transactions'
        if not td.exists(): return
        if td.is_symlink() or not td.is_dir(): raise CardError('corrupt','invalid transactions directory')
        for tx in sorted(td.glob('*.json')):
            if tx.is_symlink() or not tx.is_file(): raise CardError('unsafe_path','invalid transaction file')
            try: obj=json.loads(tx.read_text(encoding='utf-8'))
            except Exception as e: raise CardError('corrupt','invalid transaction') from e
            if not isinstance(obj,dict) or obj.get('version')!=1 or not isinstance(obj.get('writes'),list):
                raise CardError('corrupt','invalid transaction')
            for ent in obj['writes']:
                if not isinstance(ent,dict) or not isinstance(ent.get('path'),str) or 'payload' not in ent:
                    raise CardError('corrupt','invalid transaction entry')
                rel=ent['path']; parts=Path(rel).parts
                if not parts or parts[0] not in ('candidates','wiki','history','decisions','runs','validity'):
                    raise CardError('corrupt','transaction target not allowed')
                if not isinstance(ent['payload'],str): raise CardError('corrupt','transaction payload must be text')
                self._safe(rel)
                if parts[0] in ('wiki','history'): self.require_wiki()
                if parts[0] == 'decisions' and json.loads(ent['payload']).get('status') != 'rejected': self.require_wiki()
            # Validate every target before replaying any write.
            for ent in obj['writes']:
                p=self._safe(ent['path']); p.parent.mkdir(parents=True,exist_ok=True)
                self._replace(p,ent['payload'])
            tx.unlink(); self._sync_dir(td)

    def _commit(self,writes):
        self.recover(); td=self.root/'transactions'; td.mkdir(parents=True,exist_ok=True)
        rel='transactions/'+secrets.token_hex(16)+'.json'; tx=self._safe(rel)
        payload={'version':1,'writes':[{'path':p,'payload':v} for p,v in writes]}
        self._replace(tx,json.dumps(payload,ensure_ascii=False))
        self.recover()

    @staticmethod
    def _hash(body: str, review: dict | None = None) -> str:
        return hashlib.sha256(json.dumps({'body':body,'review':review or {}},ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    @staticmethod
    def _dump(meta,body): return '---\n'+json.dumps(meta,ensure_ascii=False,sort_keys=True,separators=(',',':'))+'\n---\n'+body
    @staticmethod
    def _parse(raw):
        try: text=raw.decode()
        except Exception as e: raise CardError('corrupt','invalid utf8') from e
        if not text.startswith('---\n') or '\n---\n' not in text[4:]: raise CardError('corrupt','invalid frontmatter')
        end=text.find('\n---\n',4)
        try: meta=json.loads(text[4:end])
        except Exception as e: raise CardError('corrupt','invalid frontmatter json') from e
        if not isinstance(meta,dict): raise CardError('corrupt','frontmatter must object')
        return meta,text[end+5:]
    def _candidate(self,cid):
        if not isinstance(cid,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}',cid): raise CardError('unsafe_path','invalid id')
        raw=self._read('candidates/'+cid+'.md')
        if raw is None: raise CardError('not_found','candidate not found')
        m,b=self._parse(raw)
        if m.get('contentHash') != self._hash(b,self._review_meta(m)): raise CardError('corrupt','candidate hash mismatch')
        return m,b
    @staticmethod
    def _review_meta(m):
        meta={k:m.get(k) for k in ('kind','operation','targetId','baseRevision','title','summary','rationale','scope','tags','evidence')}
        meta.update({k:m[k] for k in OPTIONAL_REVIEW if k in m})
        return meta

    def _validate_evidence(self,run,evidence):
        if self.evidence_loader is None: raise CardError('evidence_required','evidence_loader required')
        if not isinstance(evidence,list) or not evidence: raise CardError('evidence_required','evidence required')
        allowed=set(run.get('sourceIds') or [])
        for e in evidence:
            if not isinstance(e,dict) or not isinstance(e.get('sourceId'),str) or not isinstance(e.get('messageIds'),list) or not e['messageIds']: raise CardError('invalid_evidence','invalid evidence')
            if e['sourceId'] not in allowed: raise CardError('invalid_evidence','source not in run')
            src=self.evidence_loader(e['sourceId'])
            if src is None: raise CardError('invalid_evidence','source not found')
            if run.get('inputManifest'):
                claimed=[x for x in run['inputManifest'] if x.get('sourceId')==e['sourceId']]
                permitted={mid for item in claimed for mid in item.get('messageIds',[])}
                if not set(e['messageIds']).issubset(permitted): raise CardError('invalid_evidence','message not in claimed segments')
                current={str(x.get('segmentId')):x for x in src.get('segments',[])}
                if any(current.get(str(x.get('segmentId')),{}).get('contentHash')!=x.get('contentHash') or current.get(str(x.get('segmentId')),{}).get('revision')!=x.get('revision') for x in claimed): raise CardError('input_changed','evidence source changed since claim')
            msgs=src.get('messages',[]) if isinstance(src,dict) else []
            byid={str(x.get('id')):x for x in msgs if isinstance(x,dict)}
            for mid in e['messageIds']:
                if not isinstance(mid,str) or mid not in byid: raise CardError('invalid_evidence','message not found')
            quote=e.get('quote')
            if quote is not None and (not isinstance(quote,str) or not quote or quote not in '\n'.join(str(byid[mid].get('content','')) for mid in e['messageIds'])): raise CardError('invalid_evidence','quote not found in cited messages')

    def _run(self,a):
        rid=a.get('runId'); raw=self._read('runs/'+str(rid)+'.json')
        if raw is None: raise CardError('invalid_run','run not found')
        try:r=json.loads(raw)
        except Exception as e: raise CardError('invalid_run','invalid run') from e
        if r.get('runToken')!=a.get('runToken') or r.get('inputHash')!=a.get('inputHash') or r.get('status')!='running' or float(r.get('leaseUntil',0))<=time.time(): raise CardError('invalid_run','run token/hash/status/lease mismatch')
        return r

    def handle(self,action,args=None):
        a=args or {}
        if action in ('candidates.approve','cards.search','cards.read','validity.set-checks','validity.refresh'): self.require_wiki()
        if action!='migration.plan': self.recover()
        if action=='candidates.submit': return self._submit(a)
        if action=='candidates.list':
            items=[]
            d=self.root/'candidates'
            if d.exists():
                for p in sorted(d.glob('*.md')):
                    m,b=self._candidate(p.stem); items.append({**m,'body':b})
            status=a.get('status'); return {'items':[x for x in items if not status or x.get('status')==status]}
        if action=='candidates.get':
            m,b=self._candidate(a['id']); result={**m,'body':b,'conflicts':[]}
            if m.get('targetId'):
                try:
                    result['currentTarget']=self._read_card({'id':m['targetId'],'includeInactive':True})
                    if result['currentTarget']['revision'] != m.get('baseRevision'): result['conflicts'].append({'code':'revision_conflict','message':'目标卡版本已变化，需要重新蒸馏'})
                except CardError as error:
                    if error.code != 'not_found': raise
                    result['conflicts'].append({'code':'not_found','message':'目标卡已不存在'})
            return result
        if action=='candidates.edit': return self._edit(a)
        if action=='candidates.approve': return self._decision(a,True)
        if action=='candidates.reject': return self._decision(a,False)
        if action=='cards.search': return self._search(a)
        if action=='cards.read': return self._read_card(a)
        if action=='validity.set-checks': return self._set_checks(a)
        if action=='validity.refresh': return self.refresh_validity()
        if action=='migration.plan': return self._migration()
        raise CardError('bad_action','unknown action')

    def _submit(self,a):
        r=self._run(a); self._validate_evidence(r,a.get('evidence'))
        body,kind,op=a.get('body'),a.get('kind'),a.get('operation')
        if not isinstance(body,str) or kind not in ('knowledge','profile','rule') or op not in ('create','revise','archive'): raise CardError('invalid_candidate','invalid kind/operation/body')
        target=a.get('targetId')
        if target is not None and (not isinstance(target,str) or '/' in target or '\\' in target or target in ('.','..')): raise CardError('unsafe_path','invalid target id')
        if op=='create' and (a.get('baseRevision') is not None or target is not None): raise CardError('invalid_candidate','create cannot specify target or baseRevision')
        if a.get('scope') is None: a={**a,'scope':'local'}
        for field,limit in (('title',500),('summary',5000),('body',100000),('rationale',5000),('scope',500)):
            if not isinstance(a.get(field),str) or not a[field].strip() or len(a[field])>limit: raise CardError('invalid_candidate','invalid '+field)
        extra={}
        if a.get('appliesTo') is not None:
            if not isinstance(a['appliesTo'],str) or not a['appliesTo'].strip() or len(a['appliesTo'])>500: raise CardError('invalid_candidate','invalid appliesTo')
            extra['appliesTo']=a['appliesTo']
        if a.get('checks') is not None:
            if kind=='profile': raise CardError('invalid_candidate','profile cards take no checks')
            if op=='archive': raise CardError('invalid_candidate','archive takes no checks')
            extra['checks']=validity.normalize_checks(a['checks'],_invalid_candidate)
            root=validity.check_root()
            if root is not None:
                # A check that already fails would suspend the card on approval; tell the distiller now.
                failed=[r['detail'] for r in validity.run_checks(root,extra['checks']) if not r['ok']]
                if failed: raise CardError('invalid_candidate','check fails now (paths are relative to the validity root): '+'; '.join(failed))
        if a.get('conflict') is not None:
            if op not in ('revise','archive'): raise CardError('invalid_candidate','conflict requires a revise or archive target')
            if not isinstance(a['conflict'],str) or not a['conflict'].strip() or len(a['conflict'])>1000: raise CardError('invalid_candidate','invalid conflict')
            extra['conflict']=a['conflict']
        if op in ('revise','archive') and (type(a.get('baseRevision')) is not int or a['baseRevision']<1): raise CardError('invalid_candidate','positive baseRevision required')
        if op in ('revise','archive') and not isinstance(target,str): raise CardError('invalid_candidate','target required')
        if target is not None and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}',target): raise CardError('unsafe_path','invalid target id')
        target_meta=None
        if target is not None and op in ('revise','archive'):
            # Fail at submit time rather than leaving an unapprovable conflict that suspends nothing.
            target_meta,_=self._load_card(target)
            if extra.get('conflict') and target_meta.get('status')!='active': raise CardError('invalid_candidate','conflict target is not active')
        review={**{k:a.get(k) for k in ('kind','operation','targetId','baseRevision','title','summary','rationale','scope','tags','evidence')},**extra}
        fp=hashlib.sha256(json.dumps({**review,'body':body},sort_keys=True,ensure_ascii=False).encode()).hexdigest()
        d=self.root/'candidates'
        if d.exists():
            for p in d.glob('*.md'):
                m,b=self._candidate(p.stem)
                if m.get('fingerprint')==fp:
                    run2=dict(r); ids=list(run2.get('generatedCandidates') or [])
                    if m['id'] not in ids:
                        ids.append(m['id']);run2['generatedCandidates']=ids
                        self._commit([('runs/'+str(a['runId'])+'.json',json.dumps(run2,ensure_ascii=False,sort_keys=True))])
                    return {**m,'body':b,'duplicate':True}
        cid=secrets.token_hex(12); meta={**review,'id':cid,'revision':1,'status':'pending','contentHash':self._hash(body,review),'fingerprint':fp,'createdAt':int(time.time())}
        run2=dict(r); run2['generatedCandidates']=list(run2.get('generatedCandidates') or [])
        if cid not in run2['generatedCandidates']: run2['generatedCandidates'].append(cid)
        writes=[('candidates/'+cid+'.md',self._dump(meta,body)),('runs/'+str(a['runId'])+'.json',json.dumps(run2,ensure_ascii=False,sort_keys=True))]
        if extra.get('conflict'):
            # A reported contradiction suspends the target until the owner approves or rejects this draft.
            _,write=self._assess(target_meta,add_conflict={'candidateId':cid,'detail':extra['conflict'][:300],'at':int(time.time())})
            if write: writes.append(write)
        self._commit(writes); return {**meta,'body':body}

    def _edit(self,a):
        m,b=self._candidate(a['id'])
        if m.get('status') != 'pending': raise CardError('already_decided','only pending candidates are editable')
        if any(k not in ('id','expectedRevision','title','summary','body') for k in a): raise CardError('invalid_candidate','unsupported edit field')
        if any(k in a and (not isinstance(a[k],str) or not a[k].strip()) for k in ('title','summary','body')): raise CardError('invalid_candidate','edit values must be nonempty strings')
        if a.get('expectedRevision')!=m.get('revision'): raise CardError('revision_conflict','revision mismatch')
        nb=a.get('body',b); nm=dict(m); nm.update({k:a[k] for k in ('title','summary','rationale','scope','tags','evidence') if k in a}); nm['revision']=m['revision']+1; nm['contentHash']=self._hash(nb,self._review_meta(nm)); self._commit([('candidates/'+a['id']+'.md',self._dump(nm,nb))]); return {**nm,'body':nb}

    def _decision(self,a,approved):
        m,b=self._candidate(a['id'])
        if a.get('actor')!='human-ui' or a.get('revision')!=m.get('revision') or a.get('contentHash')!=m.get('contentHash') or not a.get('idempotencyKey'): raise CardError('invalid_review','review binding required')
        fp=hashlib.sha256(json.dumps({'approved':approved,'id':a['id'],'revision':a['revision'],'contentHash':a['contentHash'],'idempotencyKey':a['idempotencyKey'],'reason':a.get('reason')},sort_keys=True).encode()).hexdigest()
        if m.get('status') in ('approved','rejected'):
            if m.get('decisionFingerprint')==fp: return m.get('decisionResult')
            raise CardError('already_decided','different decision rejected')
        nm=dict(m); nm.update(status='approved' if approved else 'rejected',decisionFingerprint=fp,decidedAt=int(time.time()))
        decisionId=hashlib.sha256((a['id']+fp).encode()).hexdigest()[:24]; nm['decisionId']=decisionId
        writes=[('candidates/'+a['id']+'.md',self._dump(nm,b)),('decisions/'+decisionId+'.json',json.dumps({'id':a['id'],'decisionId':decisionId,'status':nm['status'],'actor':'human-ui','revision':m['revision'],'contentHash':m['contentHash'],'reason':a.get('reason'),'decidedAt':nm['decidedAt'],'operation':m['operation'],'targetId':m.get('targetId'),'fingerprint':fp},ensure_ascii=False))]
        card=None
        if approved:
            kind=m['kind']; target=m.get('targetId') or m['id']; rev=1; status='active'; old=None
            if m['operation'] in ('revise','archive'):
                try: old,old_body=self._load_card(target); rev=old['revision']+1
                except CardError as error:
                    if error.code != 'not_found': raise
                    raise CardError('not_found','target card not found')
                expected=m.get('baseRevision')
                if m['operation'] in ('revise','archive') and expected!=rev-1: raise CardError('revision_conflict','target revision mismatch')
                if m['operation']=='archive': status='archived'
                if old['kind'] != kind: raise CardError('revision_conflict','target kind mismatch')
                writes.append(('history/'+target+'/'+str(old['revision'])+'.md',self._dump(old,old_body)))
            visibility,applies=split_scope(m.get('scope'),m.get('appliesTo'))
            meta={'id':target,'kind':kind,'status':status,'revision':rev,'approvedAt':int(time.time()),'decisionId':decisionId,'evidence':m.get('evidence',[]),'title':m.get('title'),'summary':m.get('summary'),'scope':visibility,'tags':m.get('tags') or [],'links':[]}
            if applies: meta['appliesTo']=applies
            meta['links']=sorted(set(re.findall(r'\[\[([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?:\|[^\]]*)?\]\]',b)))
            meta['contentHash']=self._hash(b,meta); writes.append(('wiki/'+kind+'/'+target+'.md',self._dump(meta,b))); card={**meta,'body':b}
            # A new revision gets a fresh verdict: candidate checks replace the old ones,
            # conflicts about the previous text are resolved by this very decision.
            if status=='active':
                _,write=self._assess(meta,checks=m.get('checks'),conflicts=[])
                if write: writes.append(write)
        elif m.get('conflict') and m.get('targetId'):
            # Rejecting the conflicting draft releases the suspension it caused.
            try: target_meta,_=self._load_card(m['targetId'])
            except CardError as error:
                if error.code!='not_found': raise
                target_meta=None
            if target_meta is not None:
                _,write=self._assess(target_meta,drop_conflict=a['id'])
                if write: writes.append(write)
        result={'card':card,'decisionId':decisionId}; nm['decisionResult']=result; writes[0]=('candidates/'+a['id']+'.md',self._dump(nm,b)); self._commit(writes); return result

    # ── formal cards: one usability gate for every consumer ──────────────
    def _load_card_path(self,p):
        m,b=self._parse(self._read(str(p.relative_to(self.root))))
        if m.get('contentHash') != self._hash(b,{k:v for k,v in m.items() if k != 'contentHash'}): raise CardError('corrupt','formal card hash mismatch')
        return m,b
    def _load_card(self,ident):
        """Load one formal card regardless of lifecycle or validity (internal use only)."""
        if not isinstance(ident,str) or not re.fullmatch(ID_RE,ident): raise CardError('unsafe_path','invalid id')
        matches=list((self.root/'wiki').glob('*/'+ident+'.md'))
        if not matches: raise CardError('not_found','card not found')
        if len(matches)!=1: raise CardError('corrupt','duplicate formal card id')
        return self._load_card_path(matches[0])
    def _all_cards(self):
        base=self.root/'wiki'
        return [(p,*self._load_card_path(p)) for p in sorted(base.glob('*/*.md'))] if base.exists() else []
    def _maintain(self,m):
        """Refresh an active card's validity, committing only a changed verdict."""
        if m.get('status')!='active': return None
        view,write=self._assess(m)
        if write: self._commit([write])
        return view
    @staticmethod
    def _public(m):
        """Expose scope as visibility; older free-text scopes are read as applicability."""
        visibility,applies=split_scope(m.get('scope'),m.get('appliesTo'))
        out={**m,'scope':visibility}
        if applies: out['appliesTo']=applies
        return out
    @staticmethod
    def _usable(m,view): return m.get('status')=='active' and (view is None or view['state']=='valid')
    @staticmethod
    def _search_text(m,b):
        # Evidence, hashes and decision metadata are audit data, never search keys.
        return ' '.join([str(m.get('title') or ''),str(m.get('summary') or ''),str(m.get('appliesTo') or ''),' '.join(str(t) for t in m.get('tags') or []),b]).casefold()

    def _search(self,a):
        include=a.get('includeInactive') is True
        out=[]; writes=[]; q=str(a.get('query','')).casefold()
        for p,m,b in self._all_cards():
            m=self._public(m)
            if a.get('kind') and m.get('kind') != a['kind']: continue
            if a.get('scope') and m.get('scope') != a['scope']: continue
            view=None
            if m.get('status')=='active':
                view,write=self._assess(m)
                if write: writes.append(write)
            usable=self._usable(m,view)
            if not usable and not include: continue
            if q and q not in self._search_text(m,b): continue
            out.append({**m,'body':b,'path':str(p.relative_to(self.root)),'validity':view,'usable':usable})
        if writes: self._commit(writes)
        return {'items':out}
    def _read_card(self,a):
        ident=a.get('id'); m,b=self._load_card(ident)
        view=self._maintain(m); usable=self._usable(m,view)
        if not usable and a.get('includeInactive') is not True:
            if m.get('status')!='active': raise CardError('card_unavailable','card is archived and must not be used',cardStatus=m.get('status'))
            raise CardError('card_unavailable','card is suspended and must not be used: '+'; '.join(r.get('detail') or r['code'] for r in view['reasons']),validity=view['state'])
        backlinks=[linked['id'] for _,linked,_ in self._all_cards() if linked.get('status')=='active' and ident in linked.get('links',[])]
        return {**self._public(m),'body':b,'links':m.get('links',[]),'backlinks':sorted(backlinks),'validity':view,'usable':usable}

    # ── validity sidecar ─────────────────────────────────────────────────
    def _validity_record(self,ident):
        raw=self._read('validity/'+ident+'.json')
        if raw is None: return None
        try: rec=json.loads(raw)
        except ValueError as e: raise CardError('corrupt','invalid validity record') from e
        if not isinstance(rec,dict) or rec.get('version')!=1 or rec.get('id')!=ident: raise CardError('corrupt','invalid validity record')
        return rec

    def _assess(self,m,*,checks=None,conflicts=None,add_conflict=None,drop_conflict=None):
        """Return (view, write-or-None). The verdict binds to revision+contentHash; a new
        revision keeps the checks but never inherits results or conflicts about older text."""
        old=self._validity_record(m['id'])
        bound=bool(old) and old.get('revision')==m.get('revision') and old.get('contentHash')==m.get('contentHash')
        if checks is None: checks=list((old or {}).get('checks') or [])
        if conflicts is None: conflicts=list(old.get('conflicts') or []) if bound else []
        if add_conflict and all(c.get('candidateId')!=add_conflict['candidateId'] for c in conflicts): conflicts.append(add_conflict)
        if drop_conflict: conflicts=[c for c in conflicts if c.get('candidateId')!=drop_conflict]
        root=validity.check_root() if checks and m.get('status')=='active' else None
        if root is not None: results=validity.run_checks(root,checks)
        elif bound and old.get('checks')==checks: results=list(old.get('results') or [])  # source unavailable: keep last verdict
        else: results=[]
        reasons=[{'code':'check_failed','detail':r['detail']} for r in results if not r.get('ok')]
        reasons+=[{'code':'conflict','candidateId':c['candidateId'],'detail':c.get('detail','')} for c in conflicts]
        state='suspended' if reasons else 'valid'
        rec={'version':1,'id':m['id'],'revision':m['revision'],'contentHash':m['contentHash'],'checks':checks,'results':results,'conflicts':conflicts,'state':state,'reasons':reasons}
        view={'state':state,'reasons':reasons,'checks':checks,'results':results,'changedAt':(old or {}).get('changedAt')}
        if old is None and not checks and not conflicts: return view,None
        if old is not None and all(old.get(k)==v for k,v in rec.items()): return view,None
        now=int(time.time()); history=list((old or {}).get('history') or [])
        if not old or old.get('state')!=state or old.get('revision')!=m['revision']:
            history.append({'at':now,'revision':m['revision'],'state':state,'reasons':[r['code'] for r in reasons]})
        rec.update(changedAt=now,history=history[-20:]); view['changedAt']=now
        return view,('validity/'+m['id']+'.json',json.dumps(rec,ensure_ascii=False,sort_keys=True))

    def refresh_validity(self):
        writes=[]; summary={'checked':0,'changed':0,'suspended':[]}
        for _,m,_ in self._all_cards():
            if m.get('status')!='active': continue
            view,write=self._assess(m); summary['checked']+=1
            if write: writes.append(write); summary['changed']+=1
            if view['state']!='valid': summary['suspended'].append({'id':m['id'],'reasons':view['reasons']})
        if writes: self._commit(writes)
        return summary

    def maintain(self):
        """Distill-claim hook: refresh validity when the Wiki is active, otherwise do nothing."""
        try: self.require_wiki()
        except CardError as error:
            if error.code=='store_not_active': return None
            raise
        return self.refresh_validity()

    def _set_checks(self,a):
        """Owner/operator action (faculty CLI only): replace one active card's checks."""
        m,_=self._load_card(a.get('id'))
        if m.get('status')!='active': raise CardError('card_unavailable','archived cards take no checks')
        if m.get('kind')=='profile': raise CardError('invalid_checks','profile cards take no checks')
        if a.get('revision')!=m.get('revision'): raise CardError('revision_conflict','revision mismatch')
        if validity.check_root() is None: raise CardError('invalid_checks','BUTLER_VALIDITY_ROOT must point to an existing directory so checks run now')
        def bad(message): raise CardError('invalid_checks',message)
        view,write=self._assess(m,checks=validity.normalize_checks(a.get('checks'),bad))
        if write: self._commit([write])
        return {'id':m['id'],'revision':m['revision'],'validity':view}
    def _migration(self):
        items=[]
        for name in ('rules','knowledge','persona'):
            p=self.root/name
            if p.exists(): items.append({'path':name,'count':sum(1 for x in p.rglob('*') if x.is_file() and not x.is_symlink())})
        return {'items':items}
