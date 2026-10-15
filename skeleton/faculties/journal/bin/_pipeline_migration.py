"""Crash-safe, explicitly confirmed migration from legacy cards to Wiki cards.

Migration is intentionally independent from :class:`Cards` transactions.  A
migration has its own write-ahead manifest and never removes or rolls back a
personal file.  If a process stops half way through, the manifest is resumed
on the next ``migration.apply`` with the same plan hash.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import tempfile
import time
from pathlib import Path
from typing import Any

from _pipeline_cards import CardError, Cards
from _lib import split_card


MARKER_RELATIVE_PATH = Path("etc/knowledge-store.json")
_PLAN_HASH = re.compile(r"^[0-9a-f]{64}$")


class MigrationError(RuntimeError):
    pass


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _json_hash(value: Any) -> str:
    return _sha(_canonical(value))


def _yaml_scalar(value: str) -> Any:
    """Parse the scalar subset emitted by ``memory``'s YAML front matter.

    The skeleton deliberately has no PyYAML dependency.  ``split_card`` is
    still the authoritative boundary/parser for legacy cards; this conversion
    only retains YAML scalar types such as ``approvedAt: 7`` instead of
    turning them into a lossy string (or trying JSON-only parsing).
    """
    value = value.strip()
    if not value:
        return ""
    try:
        return json.loads(value)
    except (ValueError, TypeError):
        pass
    if value in ("true", "True"): return True
    if value in ("false", "False"): return False
    if value in ("null", "Null", "~"): return None
    if len(value) >= 2 and value[0] == value[-1] == "'":
        return value[1:-1].replace("''", "'")
    if len(value) >= 2 and value[0] == value[-1] == '"':
        return value[1:-1]
    # Common YAML flow-sequence form used by memory cards (e.g.
    # ``tags: [foo, bar]``).  Keep this dependency-free while preserving the
    # scalar types of each element.
    if value.startswith("[") and value.endswith("]"):
        inner = value[1:-1].strip()
        if not inner:
            return []
        return [_yaml_scalar(part.strip()) for part in inner.split(",")]
    try:
        return int(value, 10)
    except ValueError:
        try:
            return float(value)
        except ValueError:
            return value


def _source_parts(raw: bytes) -> tuple[dict[str, Any], str]:
    """Read the same front-matter form as ``memory`` and preserve body bytes."""
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise MigrationError("legacy source is not valid UTF-8") from exc

    # Use the skeleton parser for compatibility, then parse all keys rather
    # than the old four-key projection.  In particular this keeps approvedAt.
    parsed, _ = split_card(text)
    meta: dict[str, Any] = dict(parsed)
    body = text
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end >= 0:
            body = text[end + 5:]
            for line in text[4:end].splitlines():
                key, sep, value = line.partition(":")
                if sep and key.strip():
                    meta[key.strip()] = _yaml_scalar(value)
    return meta, body


def _first_summary(body: str) -> str:
    for line in body.splitlines():
        line = line.strip()
        if line and not line.startswith(("#", ">", "---", "```")):
            return line[:200]
    return "Legacy migrated card"


class Migration:
    VERSION = 2

    def __init__(self, root: Path):
        self.root = Path(root).absolute()
        self.cards = Cards(self.root)
        self._fault_count = 0

    # ---------- strict filesystem helpers ----------
    def _safe(self, rel: str) -> Path:
        try:
            return self.cards._safe(rel)
        except (CardError, OSError) as exc:
            raise MigrationError(f"unsafe migration path: {rel}") from exc

    def _atomic(self, rel: str, data: bytes) -> None:
        path = self._safe(rel)
        if path.exists() and (path.is_symlink() or not path.is_file()):
            raise MigrationError(f"migration target is not a regular file: {rel}")
        path.parent.mkdir(parents=True, exist_ok=True)
        # Re-check after mkdir: a hostile symlink must fail closed.
        path = self._safe(rel)
        fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(data)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, path)
        finally:
            try: os.unlink(tmp)
            except FileNotFoundError: pass

    def _fault(self, stage: str) -> None:
        """Test-only crash injection; the manifest remains for resume."""
        self._fault_count += 1
        value = os.environ.get("PIPELINE_MIGRATION_FAIL_AFTER")
        if value and value.isdigit() and self._fault_count >= int(value):
            raise MigrationError(f"migration interrupted after {stage}; resume with the same planHash")

    def _guard_path(self) -> Path:
        # root is Butler/self; the guard belongs to the faculty skeleton, not
        # inside a user's self directory.
        path = self.root.parent / "faculties" / "journal" / "bin" / "_legacy_guard.py"
        cur = path
        while True:
            if cur.is_symlink():
                raise MigrationError("legacy guard path contains a symlink")
            if cur == cur.parent: break
            cur = cur.parent
        if not path.is_file():
            raise MigrationError(f"legacy guard command code is missing: {path}")
        for name in ('memory','proposals','migrate-rules'):
            command=path.parent/name
            if command.is_symlink() or not command.is_file(): raise MigrationError('legacy command guard deployment incomplete')
            code=command.read_text(encoding='utf-8')
            if 'from _legacy_guard import' not in code or 'assert_legacy_write_allowed(' not in code: raise MigrationError('legacy command guard deployment incomplete: '+name)
        return path

    def _marker_path(self) -> Path:
        return self._safe(str(MARKER_RELATIVE_PATH))

    def _marker(self) -> dict[str, Any]:
        path = self._marker_path()
        if not path.exists():
            return {"version": 1, "active": "legacy"}
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, UnicodeDecodeError) as exc:
            raise MigrationError("knowledge-store marker is corrupt") from exc
        if (not isinstance(value, dict) or type(value.get("version")) is not int
                or value.get("version") != 1 or value.get("active") not in ("legacy", "wiki")):
            raise MigrationError("knowledge-store marker has an invalid version or active value")
        if value.get("planHash") is not None and not _PLAN_HASH.fullmatch(str(value["planHash"])):
            raise MigrationError("knowledge-store marker has an invalid planHash")
        return value

    # ---------- source and plan ----------
    def _sources(self) -> list[tuple[str, Path]]:
        found: list[tuple[str, Path]] = []
        for directory in ("rules", "knowledge"):
            base = self._safe(directory)
            if not base.exists(): continue
            if not base.is_dir(): raise MigrationError(f"source directory is not a directory: {directory}")
            for path in sorted(base.iterdir(), key=lambda p: p.name):
                rel = f"{directory}/{path.name}"
                self._safe(rel)
                if path.is_symlink(): raise MigrationError(f"symlink source is unsafe: {rel}")
                if path.is_file() and path.suffix == ".md": found.append((rel, path))
        persona = self._safe("persona")
        if persona.exists():
            if not persona.is_dir(): raise MigrationError("persona is not a directory")
            path = self._safe("persona/profile.md")
            if path.exists():
                if path.is_symlink() or not path.is_file(): raise MigrationError("profile source is unsafe")
                found.append(("persona/profile.md", path))
        return found

    def _wiki_files(self) -> list[tuple[str, Path]]:
        base = self._safe("wiki")
        if not base.exists(): return []
        if not base.is_dir(): raise MigrationError("wiki is not a directory")
        out: list[tuple[str, Path]] = []
        for path in sorted(base.rglob("*"), key=lambda p: str(p)):
            rel = str(path.relative_to(self.root))
            self._safe(rel)
            if path.is_symlink(): raise MigrationError(f"symlink Wiki path is unsafe: {rel}")
            if path.is_file(): out.append((rel, path))
        return out

    def _card_payload(self, item: dict[str, Any], raw: bytes) -> tuple[str, bytes]:
        source_meta, body = _source_parts(raw)
        kind = item["kind"]
        title = source_meta.get("title")
        if not isinstance(title, str) or not title.strip():
            title = "Profile" if kind == "profile" else Path(item["source"]).stem
        summary = source_meta.get("summary")
        if not isinstance(summary, str) or not summary.strip(): summary = _first_summary(body)
        tags = source_meta.get("tags")
        if isinstance(tags, list): tags = [str(x) for x in tags]
        elif tags is None: tags = ["legacy", kind]
        else: tags = [str(tags)]
        meta = dict(source_meta)  # preserve every source metadata key
        meta['legacyMetadata'] = source_meta
        meta.setdefault('provenance', 'legacy')
        meta.update({"id": item["id"], "kind": kind, "status": "active", "revision": 1,
                     "source": item["source"], "sourceHash": item["sourceHash"],
                     "scope": "local", "title": title, "summary": summary, "tags": tags,
                     "links": []})
        # approvedAt is deliberately retained from YAML.  Do not synthesize a
        # value when the legacy source did not have one.
        meta["contentHash"] = Cards._hash(body, {k: v for k, v in meta.items() if k != "contentHash"})
        target = f"wiki/{kind}/{item['id']}.md"
        self._safe(target)
        return target, Cards._dump(meta, body).encode("utf-8")

    def activate_empty(self, args: dict[str, Any]) -> dict[str, Any]:
        """Explicit authority switch without promoting legacy or pending content."""
        if args.get('confirmed') is not True: raise MigrationError('explicit confirmation required')
        plan = self._plan()
        if args.get('planHash') != plan['planHash']: raise MigrationError('source changed; rerun migration.plan')
        self._guard_path()
        if self._wiki_files(): raise MigrationError('empty activation requires an empty Wiki')
        marker = self._marker()
        if marker.get('active') == 'wiki':
            if marker.get('activationMode') != 'empty-review': raise MigrationError('Wiki already activated by another mode')
            return {'active':'wiki','formalCards':0,'unchanged':True}
        output = {'version':1,'active':'wiki','activationMode':'empty-review','planHash':plan['planHash']}
        self._atomic(str(MARKER_RELATIVE_PATH), (json.dumps(output,sort_keys=True)+'\n').encode())
        return {'active':'wiki','formalCards':0,'unchanged':False}

    def stage_review(self, args: dict[str, Any]) -> dict[str, Any]:
        """Import legacy snapshots as pending drafts only; never activate Wiki."""
        if args.get('confirmed') is not True: raise MigrationError('explicit confirmation required')
        plan = self._plan()
        if args.get('planHash') != plan['planHash']: raise MigrationError('source changed; rerun migration.plan')
        cards = Cards(self.root)
        writes=[]; created=[]; skipped=[]
        for item in plan['sources']:
            raw=self._safe(item['source']).read_bytes()
            if _sha(raw)!=item['sourceHash']: raise MigrationError('source changed during staging')
            _, payload=self._card_payload(item,raw)
            original, body=Cards._parse(payload)
            cid=item['id']
            path=cards._safe('candidates/'+cid+'.md')
            if path.exists():
                existing,_=cards._candidate(cid)
                if existing.get('legacySourceHash')!=item['sourceHash']: raise MigrationError('previously imported source changed; refusing overwrite')
                skipped.append(cid);continue
            review={'kind':item['kind'],'operation':'create','targetId':None,'baseRevision':None,
                    'title':original['title'],'summary':original['summary'],'scope':'local','tags':original['tags'],
                    'rationale':'旧资料重新审阅：保留原正文，尚未批准进入新 Wiki。',
                    'evidence':[{'sourcePath':item['source'],'sourceHash':item['sourceHash'],'messageIds':[], 'quote':body}]}
            meta={**review,'id':cid,'revision':1,'status':'pending','createdAt':int(time.time()),
                  'legacySource':item['source'],'legacySourceHash':item['sourceHash'],
                  'legacyMetadata':item['metadata'],'importPlanHash':plan['planHash'],
                  'contentHash':Cards._hash(body,review)}
            writes.append(('candidates/'+cid+'.md',Cards._dump(meta,body)));created.append(cid)
        if writes: cards._commit(writes)
        return {'created':len(created),'skipped':len(skipped),'candidateIds':created+skipped,'activated':False}

    def _plan(self) -> dict[str, Any]:
        marker = self._marker()  # malformed marker must fail closed even in preview
        items: list[dict[str, Any]] = []
        payloads: dict[str, bytes] = {}
        for rel, path in self._sources():
            raw = path.read_bytes()
            meta, _ = _source_parts(raw)
            kind = "profile" if rel == "persona/profile.md" else ("rule" if rel.startswith("rules/") else "knowledge")
            ident = "legacy-" + hashlib.sha256((kind + ":" + rel).encode()).hexdigest()[:24]
            item = {"source": rel, "sourceHash": _sha(raw), "kind": kind, "id": ident,
                    "metadata": meta, "profileWhole": kind == "profile"}
            target, payload = self._card_payload(item, raw)
            card_meta, _ = Cards._parse(payload)
            item["contentHash"] = card_meta.get("contentHash")
            item["target"] = target
            item["payloadHash"] = _sha(payload)
            payloads[target] = payload
            items.append(item)
        existing = self._wiki_files()
        existing_hashes = {rel: _sha(path.read_bytes()) for rel, path in existing}
        conflicts = []
        for target, payload in payloads.items():
            if target in existing_hashes and existing_hashes[target] != _sha(payload):
                conflicts.append({"path": target, "existingHash": existing_hashes[target], "plannedHash": _sha(payload)})
        existing_confirmation = bool(existing)
        plan = {"version": self.VERSION, "root": str(self.root), "sources": items,
                "existingWiki": [{"path": p, "hash": h} for p, h in sorted(existing_hashes.items())],
                "conflicts": conflicts, "requiresExistingConfirmation": existing_confirmation,
                "mapping": "legacy:<kind>:<relative-source> -> deterministic legacy-<sha256[:24]>",
                "readOnly": True}
        plan["planHash"] = _json_hash(plan)
        # Keep local variables alive only for clarity; payloads are regenerated
        # from source snapshots when an apply manifest is created.
        del marker, payloads
        return plan

    def _validate_runs(self) -> None:
        runs = self._safe("runs")
        if not runs.exists(): return
        if not runs.is_dir(): raise MigrationError("runs is not a directory")
        for path in runs.iterdir():
            rel = str(path.relative_to(self.root)); self._safe(rel)
            if path.is_symlink(): raise MigrationError(f"symlink run is unsafe: {rel}")
            if path.suffix != ".json": continue
            try: value = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError, UnicodeDecodeError) as exc:
                raise MigrationError(f"run record is corrupt: {rel}") from exc
            if not isinstance(value, dict): raise MigrationError(f"run record is corrupt: {rel}")
            if value.get("status") == "running" and float(value.get("leaseUntil", 0)) > time.time():
                raise MigrationError("active distillation run; migration refused")

    def _ensure_applyable(self, plan: dict[str, Any], args: dict[str, Any]) -> None:
        self._guard_path()
        self._validate_runs()
        if plan.get("conflicts"):
            raise MigrationError("existing Wiki card conflict; refusing to overwrite personal data")
        if plan.get("requiresExistingConfirmation") and args.get("existingConfirmed") is not True:
            raise MigrationError("existing Wiki data requires existingConfirmed=true")
        marker = self._marker()
        if marker.get("active") == "wiki":
            raise MigrationError("marker active=wiki without a completed migration result")

    # ---------- WAL manifest and replay ----------
    def _manifest_path(self, plan_hash: str) -> str:
        if not _PLAN_HASH.fullmatch(plan_hash): raise MigrationError("planHash must be exactly 64 lowercase hex characters")
        rel = f"migration/{plan_hash}/manifest.json"; self._safe(rel); return rel

    def _result_path(self, plan_hash: str) -> str:
        rel = f"migration/{plan_hash}/result.json"; self._safe(rel); return rel

    def _read_json_rel(self, rel: str) -> dict[str, Any] | None:
        path = self._safe(rel)
        if not path.exists(): return None
        if path.is_symlink() or not path.is_file(): raise MigrationError(f"invalid migration record: {rel}")
        try: value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, UnicodeDecodeError) as exc: raise MigrationError(f"corrupt migration record: {rel}") from exc
        if not isinstance(value, dict): raise MigrationError(f"corrupt migration record: {rel}")
        return value

    def _build_manifest(self, plan: dict[str, Any]) -> dict[str, Any]:
        entries = []
        for item in plan["sources"]:
            source = self._safe(item["source"])
            raw = source.read_bytes()
            if _sha(raw) != item["sourceHash"]: raise MigrationError(f"source changed after planning: {item['source']}")
            target, payload = self._card_payload(item, raw)
            target_path = self._safe(target)
            baseline = target_path.read_bytes() if target_path.exists() else None
            if baseline is not None and target_path.is_symlink(): raise MigrationError(f"symlink target is unsafe: {target}")
            entries.append({"source": item["source"], "sourceHash": item["sourceHash"],
                            "sourceSnapshot": base64.b64encode(raw).decode("ascii"), "target": target,
                            "payload": payload.decode("utf-8"), "payloadHash": _sha(payload),
                            "baselineHash": _sha(baseline) if baseline is not None else None,
                            "baselineSnapshot": base64.b64encode(baseline).decode("ascii") if baseline is not None else None})
        # Capture the complete Wiki baseline, not only migration targets.  A
        # rollback preview must report an edit to an unrelated existing card
        # as well as cards created by this migration.
        baseline_inventory = list(plan.get("existingWiki") or [])
        manifest = {"version": self.VERSION, "planHash": plan["planHash"],
                    "requiresExistingConfirmation": plan["requiresExistingConfirmation"],
                    "wikiBaseline": baseline_inventory, "entries": entries,
                    "createdAt": int(time.time())}
        manifest["manifestHash"] = _json_hash({k: v for k, v in manifest.items() if k != "manifestHash"})
        return manifest

    def _validate_manifest(self, manifest: dict[str, Any], plan_hash: str, *, check_sources: bool = True) -> None:
        if (manifest.get("version") != self.VERSION or manifest.get("planHash") != plan_hash
                or not isinstance(manifest.get("entries"), list)):
            raise MigrationError("corrupt migration manifest")
        digest = manifest.get("manifestHash")
        expected = _json_hash({k: v for k, v in manifest.items() if k != "manifestHash"})
        if digest != expected: raise MigrationError("corrupt migration manifest hash")
        if not _PLAN_HASH.fullmatch(plan_hash): raise MigrationError("invalid planHash")
        for entry in manifest["entries"]:
            if (not isinstance(entry, dict) or not isinstance(entry.get("source"), str)
                    or not isinstance(entry.get("target"), str)):
                raise MigrationError("corrupt migration manifest entry")
            if not re.fullmatch(r'(?:rules|knowledge)/[^/\\\\]+\.md|persona/profile\.md', entry['source']):
                raise MigrationError('migration source outside legacy card allowlist')
            kind = 'profile' if entry['source']=='persona/profile.md' else 'rule' if entry['source'].startswith('rules/') else 'knowledge'
            ident = 'legacy-' + hashlib.sha256((kind + ':' + entry['source']).encode()).hexdigest()[:24]
            if entry['target'] != f'wiki/{kind}/{ident}.md': raise MigrationError('migration target does not match source identity')
            source = self._safe(entry["source"])
            target = self._safe(entry["target"])
            source_hash = entry.get("sourceHash")
            if not isinstance(source_hash, str) or not _PLAN_HASH.fullmatch(source_hash):
                raise MigrationError("corrupt migration source hash")
            if check_sources:
                if source.is_symlink() or not source.is_file():
                    raise MigrationError(f"migration source is missing or unsafe: {entry['source']}")
                # A resume must not silently complete from a stale source. The
                # immutable source snapshot remains in the manifest for audit,
                # but current bytes must still match before replay writes.
                if _sha(source.read_bytes()) != source_hash:
                    raise MigrationError(f"source changed during migration: {entry['source']}")
            payload = entry.get("payload")
            payload_hash = entry.get("payloadHash")
            if (not isinstance(payload, str) or not isinstance(payload_hash, str)
                    or not _PLAN_HASH.fullmatch(payload_hash)
                    or _sha(payload.encode("utf-8")) != payload_hash):
                raise MigrationError("corrupt migration manifest payload")
            try:
                source_snapshot = base64.b64decode(entry.get("sourceSnapshot", ""), validate=True)
            except (ValueError, TypeError):
                raise MigrationError("corrupt migration source snapshot") from None
            if _sha(source_snapshot) != source_hash:
                raise MigrationError("corrupt migration source snapshot hash")
            # Ensure every target is safe and unchanged before replay begins.
            # A target may still contain its captured baseline, or may already
            # contain the planned payload after a prior interrupted replay.
            if target.exists():
                if target.is_symlink() or not target.is_file():
                    raise MigrationError(f"migration target is unsafe: {entry['target']}")
                current_hash = _sha(target.read_bytes())
                if current_hash not in (entry.get("baselineHash"), payload_hash):
                    raise MigrationError(f"target changed during migration: {entry['target']}")
            elif entry.get("baselineHash") is not None:
                raise MigrationError(f"migration target disappeared: {entry['target']}")

    def _replay(self, manifest: dict[str, Any], plan_hash: str, args: dict[str, Any]) -> dict[str, Any]:
        self._validate_manifest(manifest, plan_hash)
        if manifest.get("requiresExistingConfirmation") and args.get("existingConfirmed") is not True:
            raise MigrationError("existing Wiki data requires existingConfirmed=true")
        for entry in manifest["entries"]:
            path = self._safe(entry["target"])
            expected = entry["payload"].encode("utf-8")
            if path.exists():
                if path.is_symlink() or not path.is_file(): raise MigrationError(f"migration target is unsafe: {entry['target']}")
                if _sha(path.read_bytes()) != entry["payloadHash"]:
                    raise MigrationError(f"target changed during migration; refusing overwrite: {entry['target']}")
            else:
                self._atomic(entry["target"], expected)
            self._fault(f"card:{entry['target']}")
        result_rel = self._result_path(plan_hash)
        result = self._read_json_rel(result_rel)
        if result is None:
            result = {"ok": True, "planHash": plan_hash, "migrated": len(manifest["entries"]),
                      "marker": {"version": 1, "active": "wiki", "planHash": plan_hash}}
            self._atomic(result_rel, (json.dumps(result, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8"))
            self._fault("result")
        elif result.get("planHash") != plan_hash or result.get("ok") is not True:
            raise MigrationError("corrupt migration result")
        marker = self._marker()
        if marker.get("active") == "wiki":
            if marker.get("planHash") not in (None, plan_hash): raise MigrationError("marker belongs to another migration")
            return result
        if marker.get("active") != "legacy": raise MigrationError("invalid marker state")
        marker_out = {"version": 1, "active": "wiki", "planHash": plan_hash}
        self._atomic(str(MARKER_RELATIVE_PATH), (json.dumps(marker_out, separators=(",", ":")) + "\n").encode("utf-8"))
        self._fault("marker")
        return result

    def _apply(self, plan: dict[str, Any], args: dict[str, Any]) -> dict[str, Any]:
        supplied = args.get("planHash")
        if not isinstance(supplied, str) or not _PLAN_HASH.fullmatch(supplied):
            raise MigrationError("planHash must be exactly 64 lowercase hex characters")
        marker = self._marker()
        # Every apply, including an idempotent replay, repeats the guard and
        # active-run preflight before consulting result.json.
        self._guard_path()
        self._validate_runs()
        result_rel = self._result_path(supplied)
        result = self._read_json_rel(result_rel)
        if result is not None:
            if result.get("planHash") != supplied or result.get("ok") is not True: raise MigrationError("corrupt migration result")
            manifest = self._read_json_rel(self._manifest_path(supplied))
            if manifest is None: raise MigrationError("completed result has no migration manifest")
            self._validate_manifest(manifest, supplied)
            if manifest.get("requiresExistingConfirmation") and args.get("existingConfirmed") is not True:
                raise MigrationError("existing Wiki data requires existingConfirmed=true")
            if marker.get("active") == "wiki":
                if marker.get("planHash") != supplied:
                    raise MigrationError("marker belongs to another migration")
                return result
            return self._replay(manifest, supplied, args)
        manifest_rel = self._manifest_path(supplied)
        manifest = self._read_json_rel(manifest_rel)
        if manifest is None:
            current = self._plan()
            if current.get("planHash") != supplied: raise MigrationError("planHash mismatch; re-plan required")
            self._ensure_applyable(current, args)
            manifest = self._build_manifest(current)
            self._atomic(manifest_rel, (json.dumps(manifest, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8"))
            self._fault("manifest")
        else:
            self._validate_manifest(manifest, supplied)
        return self._replay(manifest, supplied, args)

    # ---------- public actions ----------
    def _rollback_plan(self, args: dict[str, Any]) -> dict[str, Any]:
        supplied = args.get("planHash")
        if supplied is None:
            marker = self._marker()
            supplied = marker.get("planHash") if marker.get("active") == "wiki" else None
        if supplied is not None and (not isinstance(supplied, str) or not _PLAN_HASH.fullmatch(supplied)):
            raise MigrationError("planHash must be exactly 64 lowercase hex characters")
        manifest = self._read_json_rel(self._manifest_path(supplied)) if supplied else None
        diffs = []
        if manifest:
            self._validate_manifest(manifest, supplied, check_sources=False)
            baseline = {str(x.get("path")): x.get("hash") for x in manifest.get("wikiBaseline", []) if isinstance(x, dict)}
            planned = {entry["target"]: entry for entry in manifest["entries"]}
            current_inventory = {rel: _sha(path.read_bytes()) for rel, path in self._wiki_files()}
            paths = set(baseline) | set(planned) | set(current_inventory)
            for rel in sorted(paths):
                path = self._safe(rel)
                current = current_inventory.get(rel)
                before = baseline.get(rel) if rel in baseline else planned[rel].get("baselineHash") if rel in planned else None
                migration_hash = planned[rel].get("payloadHash") if rel in planned else None
                if current != before:
                    diffs.append({"path": rel, "change": "added" if before is None else "modified" if current is not None else "deleted",
                                  "baselineHash": before, "currentHash": current, "migrationHash": migration_hash})
        return {"version": self.VERSION, "readOnly": True, "planHash": supplied,
                "marker": self._marker(), "wikiDiff": diffs,
                "note": "rollback-plan only reports differences from the migration baseline; it never changes files or marker"}

    def handle(self, action: str, args: dict[str, Any] | None = None):
        args = args or {}
        if action == "migration.plan": return self._plan()
        if action == 'migration.activate-empty': return self.activate_empty(args)
        if action == 'migration.stage-review': return self.stage_review(args)
        if action == "migration.apply":
            # Confirmation is checked before idempotency lookup: a replay is
            # still a write-capable operation (it may need to finish marker).
            if args.get("confirmed") is not True: raise MigrationError("confirmed=true is required")
            return self._apply({}, args)
        if action == "migration.rollback-plan": return self._rollback_plan(args)
        raise MigrationError("unknown migration action")
