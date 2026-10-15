"""Block legacy writes after the controlled Wiki cutover.

Cutover marker: self/etc/knowledge-store.json, exactly version 1 with
active="wiki" (or "legacy" before cutover). Missing marker means legacy for
backward compatibility. Creating/changing this marker belongs to the controlled
migration, never to this guard or to directory auto-detection.
"""
from __future__ import annotations

import json
from pathlib import Path

MARKER_RELATIVE_PATH = Path("etc/knowledge-store.json")


class LegacyWriteBlocked(RuntimeError):
    """A formal legacy write is unsafe under the selected store mode."""


def assert_legacy_write_allowed(selfRoot) -> None:
    """Allow formal writes only in legacy mode; malformed markers fail closed."""
    marker = Path(selfRoot) / MARKER_RELATIVE_PATH
    try:
        raw = marker.read_text(encoding="utf-8")
    except FileNotFoundError:
        return  # Old instances remain legacy until explicitly migrated.
    except OSError as error:
        raise LegacyWriteBlocked(
            f"无法读取 {marker}，为保护个人知识已拒绝旧 CLI 正式写入；请审核 Wiki 迁移状态。"
        ) from error

    try:
        data = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as error:
        raise LegacyWriteBlocked(
            f"{marker} 内容损坏，为保护个人知识已拒绝旧 CLI 正式写入；请审核 Wiki 迁移状态。"
        ) from error

    if (not isinstance(data, dict) or type(data.get("version")) is not int
            or data.get("version") != 1 or data.get("active") not in ("wiki", "legacy")):
        raise LegacyWriteBlocked(
            f"{marker} 标记格式或 active 未知，为保护个人知识已拒绝旧 CLI 正式写入；请审核 Wiki 迁移状态。"
        )
    if data["active"] == "wiki":
        raise LegacyWriteBlocked(
            "旧 CLI 正式知识/画像写入已禁用：当前知识库为 Wiki；请先在 Wiki 完成审核，再通过受控迁移流程处理。"
        )
