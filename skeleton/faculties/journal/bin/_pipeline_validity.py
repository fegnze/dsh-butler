"""Formal-card validity: deterministic checks kept outside the card files.

Approval decides what a card says; validity decides whether it may be used now.
Validity never edits a card file (that would change its contentHash and
revision and re-inject every session).  It lives in ``validity/<id>.json``,
bound to the card's revision and contentHash, so a newly approved revision
never inherits a verdict about older text.

Only two deterministic check types exist:

* ``path``  -- a file or directory still exists under the check root;
* ``quote`` -- an authority file under the check root still contains a text
  (whitespace-normalized).

The check root comes from ``BUTLER_VALIDITY_ROOT`` (set by the Host from
``butler.json`` ``validityRoot``).  Without it nothing is re-evaluated and the
last stored verdict stands.  Checks are small local reads, so they simply run
on every consumer read instead of keeping a cache that could go stale.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Callable

MAX_CHECKS = 10
MAX_CHECK_FILE_BYTES = 2 * 1024 * 1024
CHECK_TYPES = ('path', 'quote')


def _norm(text: str) -> str:
    return re.sub(r'\s+', ' ', text).strip()


def normalize_checks(raw, fail: Callable[[str], None]) -> list[dict]:
    """Validate and canonicalize a checks list; ``fail(message)`` must raise."""
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > MAX_CHECKS:
        fail(f'checks must be a list of at most {MAX_CHECKS} entries')
    out = []
    for item in raw:
        if not isinstance(item, dict) or item.get('type') not in CHECK_TYPES or set(item) - {'type', 'path', 'text'}:
            fail('each check needs type path|quote and only path/text fields')
        path = item.get('path')
        if (not isinstance(path, str) or not path.strip() or len(path) > 300
                or path.startswith(('/', '~')) or '\\' in path
                or any(part in ('', '.', '..') for part in path.split('/'))):
            fail('check path must be a plain relative path under the check root')
        check = {'type': item['type'], 'path': path}
        if item['type'] == 'quote':
            text = item.get('text')
            if not isinstance(text, str) or not _norm(text) or len(text) > 500:
                fail('quote check needs non-empty text of at most 500 characters')
            check['text'] = text
        elif 'text' in item:
            fail('path check takes no text')
        out.append(check)
    return out


def check_root() -> Path | None:
    value = os.environ.get('BUTLER_VALIDITY_ROOT')
    if not value:
        return None
    root = Path(value).expanduser()
    try:
        return root.resolve(strict=True) if root.is_dir() else None
    except OSError:
        return None


def _target(root: Path, path: str) -> Path | None:
    """Resolve inside the root; a symlink that leaves the root counts as missing."""
    try:
        resolved = (root / path).resolve()
        resolved.relative_to(root)
    except (OSError, ValueError):
        return None
    return resolved


def run_checks(root: Path, checks: list[dict]) -> list[dict]:
    results = []
    for check in checks:
        target = _target(root, check['path'])
        if target is None or not target.exists():
            results.append({'ok': False, 'detail': f"依据不存在：{check['path']}"})
            continue
        if check['type'] == 'path':
            results.append({'ok': True, 'detail': '依据存在'})
            continue
        try:
            if not target.is_file() or target.stat().st_size > MAX_CHECK_FILE_BYTES:
                raise OSError('not a readable file')
            content = target.read_text(encoding='utf-8', errors='replace')
        except OSError:
            results.append({'ok': False, 'detail': f"依据不可读：{check['path']}"})
            continue
        found = _norm(check['text']) in _norm(content)
        results.append({'ok': found, 'detail': '原文仍在' if found else f"原文已不在：{check['path']}"})
    return results
