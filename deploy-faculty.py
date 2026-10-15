#!/usr/bin/env python
"""Safely copy new journal pipeline modules into an existing Butler instance."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
SOURCE_ROOT = ROOT / "skeleton" / "faculties" / "journal" / "bin"
MANIFEST_REL = Path(".state/faculty-deployment.json")
TOOL_ID = "butler-plugin-deploy-faculty-v1"
PIPELINE_NAME = re.compile(r"(?:pipeline|_pipeline[a-zA-Z0-9_]*\.py)\Z")
# Keep this list deliberately explicit: deployment must not copy arbitrary journal tools.
LEGACY_GUARD_FILES = frozenset({"_legacy_guard.py", "memory", "proposals", "migrate-rules", "card", "build-context"})
DEPLOY_ALLOWLIST = LEGACY_GUARD_FILES | {"pipeline"}
# Hashes of the three legacy scripts at repository HEAD.  Production must not
# depend on git being installed or on the checkout being present.
KNOWN_LEGACY_HEAD_HASHES = {
    "card": "da785756bf3e9ded6de1bcedd1e1d0d09f16965004635432d1e430ccdd6a48aa",
    "build-context": "6582ddb75ef76bd7b05bab211ef3cc4d985dc97d3c6a3bb6c20e5a48f8e1ac2b",
    "memory": "4705aea9e5586ad85eb4a56c90eba797874e037498e4648d5f56153b37af41fa",
    "proposals": "44620805122299134ca124fd6c45cbeb702da8128e290befc1655ec05799f3b1",
    "migrate-rules": "3cdbae69a7b4b7c18942cf72e8fcdeb1675f5076ab6287d8a539637c8546a432",
}


class DeployError(Exception):
    pass


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def checked_path(root: Path, rel: Path, *, allow_missing: bool = True) -> Path:
    """Resolve each existing component and reject symlinks/escapes."""
    if rel.is_absolute() or any(part in ("", ".", "..") for part in rel.parts):
        raise DeployError(f"不安全的相对路径: {rel}")
    current = root
    for part in rel.parts:
        current = current / part
        if current.is_symlink():
            raise DeployError(f"拒绝符号链接路径: {rel}")
        if current.exists():
            resolved = current.resolve(strict=True)
            if not within(resolved, root):
                raise DeployError(f"路径逃逸: {rel}")
        elif not allow_missing:
            raise DeployError(f"路径不存在: {rel}")
    return current


def load_json(path: Path, what: str) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise DeployError(f"无法读取{what}: {exc}") from exc
    if not isinstance(data, dict):
        raise DeployError(f"{what}必须是JSON对象")
    return data


def discover_sources() -> list[Path]:
    if not SOURCE_ROOT.is_dir():
        raise DeployError(f"固定源目录不存在: {SOURCE_ROOT.relative_to(ROOT)}")
    files = []
    for entry in sorted(SOURCE_ROOT.iterdir()):
        if entry.name in DEPLOY_ALLOWLIST or PIPELINE_NAME.fullmatch(entry.name):
            if entry.is_symlink() or not entry.is_file():
                raise DeployError(f"源部署文件不是普通文件: {entry.name}")
            files.append(entry)
    if not files or not any(path.name == "pipeline" for path in files):
        raise DeployError(f"固定源目录中暂无pipeline模块或缺少pipeline入口: {SOURCE_ROOT.relative_to(ROOT)}")
    return files


def plan(workdir: Path) -> tuple[Path, list[dict[str, Any]], dict[str, Any] | None, Path]:
    if workdir.is_symlink():
        raise DeployError("实例root不能是符号链接")
    try:
        root = workdir.resolve(strict=True)
    except OSError as exc:
        raise DeployError(f"实例root不存在: {exc}") from exc
    if not root.is_dir():
        raise DeployError("实例root必须是目录")
    config = checked_path(root, Path("butler.json"), allow_missing=False)
    if not config.is_file():
        raise DeployError("实例root缺少普通文件 butler.json")
    faculties = checked_path(root, Path("faculties"), allow_missing=False)
    if not faculties.is_dir():
        raise DeployError("实例root缺少 faculties 目录")
    journal = checked_path(root, Path("faculties/journal"), allow_missing=False)
    if not journal.is_dir():
        raise DeployError("实例缺少 faculties/journal 目录")
    bin_dir = checked_path(root, Path("faculties/journal/bin"), allow_missing=False)
    if not bin_dir.is_dir():
        raise DeployError("实例缺少 faculties/journal/bin 目录")

    manifest_path = checked_path(root, MANIFEST_REL)
    manifest: dict[str, Any] | None = None
    if manifest_path.exists():
        if not manifest_path.is_file():
            raise DeployError("部署manifest路径不是普通文件")
        manifest = load_json(manifest_path, "部署manifest")
        if manifest.get("tool") != TOOL_ID or not isinstance(manifest.get("files"), dict):
            raise DeployError("部署manifest格式/工具标识不匹配，拒绝覆盖")

    old_files = manifest.get("files", {}) if manifest else {}
    actions = []
    for src in discover_sources():
        rel = Path("faculties/journal/bin") / src.name
        dst = checked_path(root, rel)
        digest = sha256(src)
        if dst.exists():
            if not dst.is_file():
                raise DeployError(f"目标不是普通文件: {rel.as_posix()}")
            existing_hash = sha256(dst)
            if existing_hash == digest:
                status = "skip-identical"
            elif (src.name in KNOWN_LEGACY_HEAD_HASHES
                  and existing_hash == KNOWN_LEGACY_HEAD_HASHES[src.name]):
                # A pre-manifest instance may still contain the exact repository
                # HEAD legacy file.  Only that immutable baseline is upgradeable;
                # any locally changed legacy script remains protected.
                status = "upgrade-known-legacy"
            elif old_files.get(rel.as_posix()) == existing_hash:
                status = "update-tool-managed"
            else:
                raise DeployError(f"目标冲突（不是已验证的本工具版本）: {rel.as_posix()}")
        else:
            status = "install"
        actions.append({"path": rel.as_posix(), "source_sha256": digest,
                        "target_sha256": sha256(dst) if dst.exists() else None, "status": status})
    return root, actions, manifest, manifest_path


def _safe_cleanup(path: Path, root: Path) -> None:
    """Remove a newly-created regular file only after revalidating its location."""
    if not within(path.parent.resolve(strict=True), root) or path.is_symlink():
        raise DeployError(f"回滚清理安全校验失败: {path}")
    if path.exists():
        if not path.is_file():
            raise DeployError(f"回滚拒绝删除非普通文件: {path}")
        path.unlink()


def apply(root: Path, actions: list[dict[str, Any]], prior: dict[str, Any] | None,
          manifest_path: Path) -> None:
    changed: list[tuple[Path, bytes | None, int | None]] = []
    made_dirs: list[Path] = []
    try:
        new_manifest_files = dict(prior.get("files", {})) if prior else {}
        for item in actions:
            target = checked_path(root, Path(item["path"]))
            current_hash = sha256(target) if target.exists() else None
            if current_hash != item["target_sha256"]:
                raise DeployError(f"计划后目标已变化，拒绝覆盖: {item['path']}")
            source = SOURCE_ROOT / target.name
            if source.is_symlink() or sha256(source) != item["source_sha256"]:
                raise DeployError(f"计划后源文件已变化: {target.name}")
            if item["status"] == "skip-identical":
                new_manifest_files[item["path"]] = item["source_sha256"]
                continue
            rel = Path(item["path"])
            dst = checked_path(root, rel)
            old = dst.read_bytes() if dst.exists() else None
            mode = stat.S_IMODE(dst.stat().st_mode) if dst.exists() else None
            changed.append((dst, old, mode))
            missing = []
            cursor = dst.parent
            while not cursor.exists():
                missing.append(cursor)
                cursor = cursor.parent
            for directory in reversed(missing):
                directory.mkdir()
                made_dirs.append(directory)
            payload = (SOURCE_ROOT / dst.name).read_bytes()
            if hashlib.sha256(payload).hexdigest() != item["source_sha256"]:
                raise DeployError(f"读取期间源文件已变化: {dst.name}")
            atomic_write(dst, payload, mode or 0o644)
            new_manifest_files[item["path"]] = item["source_sha256"]

        new_manifest = {"schema_version": 1, "tool": TOOL_ID,
                        "files": new_manifest_files}
        prior_bytes = manifest_path.read_bytes() if manifest_path.exists() else None
        prior_mode = stat.S_IMODE(manifest_path.stat().st_mode) if manifest_path.exists() else None
        changed.append((manifest_path, prior_bytes, prior_mode))
        state_dir = manifest_path.parent
        if not state_dir.exists():
            state_dir.mkdir()
            made_dirs.append(state_dir)
        atomic_write(manifest_path, (json.dumps(new_manifest, ensure_ascii=False,
                     sort_keys=True, indent=2) + "\n").encode(), prior_mode or 0o644)
    except Exception:
        for path, old, mode in reversed(changed):
            if old is None:
                _safe_cleanup(path, root)
            else:
                atomic_write(path, old, mode or 0o644)
        for directory in reversed(made_dirs):
            checked = checked_path(root, directory.relative_to(root))
            if checked.resolve() != directory or not within(checked, root):
                raise DeployError("回滚目录安全校验失败")
            if checked.is_dir() and not any(checked.iterdir()):
                checked.rmdir()
        raise


def atomic_write(path: Path, data: bytes, mode: int) -> None:
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temp = Path(temp_name)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(temp, mode)
        os.replace(temp, path)
    except Exception:
        try:
            if temp.is_file() and not temp.is_symlink():
                temp.unlink()
        finally:
            raise


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workdir", required=True, help="现有Butler实例root")
    parser.add_argument("--apply", action="store_true", help="执行计划；默认只dry-run")
    args = parser.parse_args(argv)
    try:
        root, actions, prior, manifest_path = plan(Path(args.workdir).expanduser())
        counts: dict[str, int] = {}
        for action in actions:
            counts[action["status"]] = counts.get(action["status"], 0) + 1
        if args.apply:
            state_dir = checked_path(root, Path('.state'))
            state_dir.mkdir(exist_ok=True)
            lock_path = checked_path(root, Path('.state/faculty-deployment.lock'))
            with lock_path.open('a') as lock:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
                fresh_root, fresh_actions, fresh_prior, fresh_manifest = plan(root)
                if fresh_actions != actions:
                    raise DeployError('等待部署锁期间文件已变化，请重新执行 dry-run')
                apply(fresh_root, fresh_actions, fresh_prior, fresh_manifest)
        result = {"ok": True, "mode": "apply" if args.apply else "dry-run",
                  "counts": counts, "files": actions,
                  "manifest": MANIFEST_REL.as_posix(),
                  "summary": "已执行计划" if args.apply else "仅预览；未创建或修改任何文件"}
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except DeployError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"执行失败: {exc}"}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
