"""Butler 共享库：路径常量、目录自愈、文件锁、JSONL 读写。

仅供 bin/ 下脚本导入，不作为独立命令运行。
协议语义与并发模型见本 faculty 的 README.md。
"""
from __future__ import annotations

import fcntl
import json
import os
import re
import time
from contextlib import contextmanager
from pathlib import Path

# 本 faculty 目录（bin/ 的上级）；drivers/ 随 faculty 走。
FACULTY_ROOT = Path(__file__).resolve().parent.parent
# Butler 本体目录：守护 exec 时注入 BUTLER_SELF_ROOT；直接调用时回退到实例的 self/。
BUTLER_ROOT = Path(os.environ.get("BUTLER_SELF_ROOT") or FACULTY_ROOT.parent.parent / "self").resolve()
SPOOL_DIR = BUTLER_ROOT / "spool"
JOURNAL_DIR = BUTLER_ROOT / "journal"
JOURNAL_FILE = JOURNAL_DIR / "JOURNAL.jsonl"
JOURNAL_LOCK = JOURNAL_DIR / ".lock"
PERSONA_DIR = BUTLER_ROOT / "persona"
PROFILE_FILE = PERSONA_DIR / "profile.md"
LEGACY_IRON_FILE = PERSONA_DIR / "iron-card.md"  # 旧版合卷，只供 migrate-rules 读取
RULES_DIR = BUTLER_ROOT / "rules"
ETC_DIR = BUTLER_ROOT / "etc"
REGISTRY_FILE = ETC_DIR / "endpoints.json"
OUTBOX_DIR = BUTLER_ROOT / "outbox"
DRIVERS_DIR = FACULTY_ROOT / "drivers"
KNOWLEDGE_DIR = BUTLER_ROOT / "knowledge"
DECISIONS_DIR = BUTLER_ROOT / "decisions"
DIGESTS_DIR = BUTLER_ROOT / "digests"

VALID_TYPES = ("note", "decision", "fact", "milestone", "error", "session")


def ensure_dirs() -> None:
    for d in (SPOOL_DIR, JOURNAL_DIR, PERSONA_DIR, ETC_DIR, OUTBOX_DIR,
              RULES_DIR, KNOWLEDGE_DIR, DECISIONS_DIR, DIGESTS_DIR):
        d.mkdir(parents=True, exist_ok=True)


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def today_local() -> str:
    return time.strftime("%Y-%m-%d", time.localtime())


@contextmanager
def file_lock(path: Path):
    """独占锁：锁文件存在即可，内容无意义。写者必须持锁再写。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    fh = open(path, "a")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX)
        yield
    finally:
        fh.close()


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def save_json(path: Path, data) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                   encoding="utf-8")
    os.replace(tmp, path)


def append_jsonl(path: Path, records) -> None:
    with open(path, "a", encoding="utf-8") as fh:
        for rec in records:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")


def parse_jsonl_lines(raw_lines):
    """返回 (records, bad_count)。损坏行不抛异常、不静默丢弃，由调用方隔离。"""
    records, bad = [], 0
    for line in raw_lines:
        line = line.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            bad += 1
    return records, bad


PROPOSALS_FILE = BUTLER_ROOT / "proposals.jsonl"
PROPOSALS_LOCK = BUTLER_ROOT / ".proposals.lock"


def load_proposals():
    """按 id 折叠 proposals.jsonl 的 create/status 事件；返回 ({id: proposal}, bad_count)。"""
    try:
        raw = PROPOSALS_FILE.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return {}, 0
    records, bad = parse_jsonl_lines(raw)
    folded = {}
    for rec in records:
        if not isinstance(rec, dict) or not isinstance(rec.get("id"), str):
            continue
        if rec.get("event") == "create":
            folded[rec["id"]] = {k: v for k, v in rec.items() if k != "event"}
        elif rec["id"] in folded and rec.get("event") == "status":
            folded[rec["id"]].update({k: v for k, v in rec.items() if k not in ("event", "id")})
    return folded, bad


BUILD_DIR = BUTLER_ROOT / "build"
CONTEXT_FILE = BUILD_DIR / "context.md"
CONTEXT_MAX_CHARS = 8000

# ---------------------------------------------------------------- 卡片
# 每张沉淀卡一个文件：rules/<slug>.md（规则）、knowledge/<slug>.md（知识）。
# 文件以可选的 front matter 开头（title/summary/proposal/approvedAt），正文随后。
# 卡片 id = "<kind>/<slug>"，kind ∈ CARD_KINDS。会话只注入画像 + 索引，正文按 id 读取。

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
CARD_KINDS = {"rule": RULES_DIR, "knowledge": KNOWLEDGE_DIR}
CARD_ID_RE = re.compile(r"^(rule|knowledge)/([a-z0-9][a-z0-9-]{0,63})$")
SUMMARY_MAX = 120
_META_KEYS = ("title", "summary", "proposal", "approvedAt", "origin")
# 卡片在各自分区里的顺序（主人拖动排的）：{"rule": [slug…], "knowledge": [slug…]}。
# 没出现在里面的卡排在后面，沿用原有顺序；只记 slug，卡被删后残留项无害。
CARD_ORDER_FILE = ETC_DIR / "card-order.json"
# 蒸馏给记录卡打的「建议升级」标记，只追加；同一条记录以最后一个事件为准（mark 之后主人可 dismiss）。
# mark 遇到已有任何状态就跳过：主人忽略过的、已经升级的，蒸馏都不会再打。promote 由升级命令写入。
CANDIDATES_FILE = BUTLER_ROOT / "candidates.jsonl"
CANDIDATES_LOCK = ETC_DIR / ".candidates.lock"
CANDIDATE_TARGETS = ("knowledge", "rule", "profile")


def record_kind(record: dict) -> str:
    """记录属于哪一类：git 提交与会话回合只供查阅，只有观察可以升级。与 Host 的 classifyRecord 一致。"""
    if record.get("source") == "git" or "git-commit" in (record.get("tags") or []):
        return "git"
    return "session" if record.get("type") == "session" else "observation"


def record_keys(records: list) -> list:
    """每条记录的稳定句柄 journal:<ts>:<source>；同秒同源的第二条起加 #n。journal 只追加，句柄不会漂移。"""
    seen, keys = {}, []
    for rec in records:
        base = f"journal:{rec.get('ts', '')}:{rec.get('source', '')}"
        n = seen.get(base, 0)
        seen[base] = n + 1
        keys.append(base if n == 0 else f"{base}#{n}")
    return keys


def close_candidate(origin: str) -> None:
    """记录已升级：在候选日志里关掉它，之后蒸馏不再推荐、页面不再显示建议。"""
    if not origin:
        return
    from datetime import datetime, timezone  # noqa: PLC0415
    with file_lock(CANDIDATES_LOCK):
        if load_candidates().get(origin, {}).get("event") == "promote":
            return
        line = json.dumps({"event": "promote", "origin": origin,
                           "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}, ensure_ascii=False)
        CANDIDATES_FILE.parent.mkdir(parents=True, exist_ok=True)
        with CANDIDATES_FILE.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")


def load_candidates() -> dict:
    """origin -> 该记录的候选状态 {event, to, reason, at}；损坏行跳过，最后一个事件为准。"""
    out = {}
    try:
        lines = CANDIDATES_FILE.read_text(encoding="utf-8").splitlines()
    except OSError:
        return out
    for line in lines:
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict) and isinstance(event.get("origin"), str) and event.get("event") in ("mark", "dismiss", "promote"):
            out[event["origin"]] = event
    return out


def card_path(card_id: str):
    """card id → 文件路径；id 非法返回 None（调用方按用法错误处理）。"""
    m = CARD_ID_RE.match(card_id or "")
    return CARD_KINDS[m.group(1)] / f"{m.group(2)}.md" if m else None


def split_card(text: str):
    """返回 (meta, body)。没有 front matter 时 meta 为空、body 为全文。"""
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end != -1:
            meta = {}
            for line in text[4:end].splitlines():
                key, sep, value = line.partition(":")
                if sep and key.strip() in _META_KEYS:
                    meta[key.strip()] = value.strip()
            return meta, text[end + 5:].lstrip("\n")
    return {}, text


def one_line(text: str, limit: int = SUMMARY_MAX) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _first_prose(body: str) -> str:
    """正文第一个段落（连续非空行合为一行），跳过标题、引用与代码围栏。"""
    lines = []
    for line in body.splitlines():
        line = line.strip()
        if not line:
            if lines:
                break
            continue
        if line.startswith(("#", ">", "---", "```")):
            if lines:
                break
            continue
        lines.append(line)
    return " ".join(lines)


def _heading(body: str) -> str:
    for line in body.splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return ""


def render_card(title: str, body: str, summary: str = "", proposal: str = "", approved_at: str = "",
                origin: str = "") -> str:
    """组装卡片文本；title/summary 收为单行，缺省摘要取正文首个段落行。"""
    body = body.strip("\n")
    meta = {"title": one_line(title, 200), "summary": one_line(summary or _first_prose(body)),
            "proposal": proposal, "approvedAt": approved_at, "origin": origin}
    head = "".join(f"{k}: {v}\n" for k, v in meta.items() if v)
    return f"---\n{head}---\n\n{body}\n"


def card_entry(card_id: str, path: Path) -> dict:
    meta, body = split_card(path.read_text(encoding="utf-8"))
    return {"id": card_id,
            "title": one_line(meta.get("title") or _heading(body) or path.stem, 200),
            "summary": one_line(meta.get("summary") or _first_prose(body))}


def _applied_order():
    """card id -> 批准时间（最新决定为准）；未经提案的卡排在后面。"""
    proposals, _ = load_proposals()
    order = {}
    for p in proposals.values():
        if p.get("kind") in CARD_KINDS and p.get("status") == "applied" and p.get("slug"):
            order[f"{p['kind']}/{p['slug']}"] = p.get("decidedAt") or ""
    return order


def list_cards(kind: str | None = None) -> list:
    """列出卡片索引条目：规则在前（按批准先后），知识在后（最新在前）。"""
    order = _applied_order()
    out = []
    for name, directory in CARD_KINDS.items():
        if kind and kind != name or not directory.exists():
            continue
        files = [p for p in directory.glob("*.md") if p.name != "README.md" and SLUG_RE.match(p.stem)]
        # 规则按批准先后（基础约定在前、同批按写入顺序）；知识最新在前。
        files.sort(key=lambda p: (order.get(f"{name}/{p.stem}", ""), p.stat().st_mtime_ns), reverse=name == "knowledge")
        rank = {slug: i for i, slug in enumerate(load_card_order().get(name, []))}
        files.sort(key=lambda p: rank.get(p.stem, len(rank)))  # 稳定排序：没排过的保持上面的顺序
        out.extend(card_entry(f"{name}/{p.stem}", p) for p in files)
    return out


def load_card_order() -> dict:
    """读主人排过的卡片顺序；文件缺失或损坏都当作没排过。"""
    try:
        data = json.loads(CARD_ORDER_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {k: [s for s in v if isinstance(s, str)] for k, v in data.items()
            if k in CARD_KINDS and isinstance(v, list)} if isinstance(data, dict) else {}


def card_command() -> str:
    """其他 Agent 可直接运行的只读卡片命令（绝对路径，带本实例的 self 根）。"""
    import shlex
    import sys
    parts = ["env", f"BUTLER_SELF_ROOT={BUTLER_ROOT}", sys.executable, str(Path(__file__).resolve().parent / "card")]
    return " ".join(shlex.quote(part) for part in parts)


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def compile_context(max_chars: int = CONTEXT_MAX_CHARS) -> dict:
    """Compile self/build/context.md: the profile plus a one-line index of every card.

    Card bodies are never inlined; an agent reads one with `card <id>`. The
    profile is never cut; index lines fill the remaining budget (rules first,
    then newest knowledge) and the overflow is stated, not silently dropped.
    Raises FileNotFoundError without writing when the profile is missing.
    """
    if not PROFILE_FILE.exists():
        raise FileNotFoundError(str(PROFILE_FILE))
    head = "\n\n".join([
        "# Butler context",
        "> 由 build-context 从 self/persona、self/rules、self/knowledge 编译；不要手改。",
        PROFILE_FILE.read_text(encoding="utf-8").strip(),
        "# 卡片索引\n\n"
        "> 每行一张已批准的卡：`id` 标题 — 摘要。规则卡是本实例主人认可的工作约定，不替代当前会话适用的规则。\n"
        f"> 任务涉及某张卡时先读全文再行动，不要凭摘要臆断细节：Butler 会话用 `butler_card`，其他会话运行 `{card_command()} <id>`。",
    ])
    if len(head) > max_chars:
        raise ValueError(f"画像已有 {len(head)} 字，超过上限 {max_chars}")
    cards = list_cards()
    lines, used, truncated = [], len(head), False
    sections = {"rule": "\n\n## 规则", "knowledge": "\n\n## 知识"}
    current = None
    for index, card in enumerate(cards):
        kind = card["id"].split("/", 1)[0]
        line = f"\n- `{card['id']}` {card['title']}" + (f" — {card['summary']}" if card["summary"] else "")
        prefix = sections[kind] + "\n" if kind != current else ""
        rest = len(cards) - index
        tail = len(f"\n\n（另有 {rest} 张未列出；用 card --list 查看全部）")
        if used + len(prefix) + len(line) + tail > max_chars:
            lines.append(f"\n\n（另有 {rest} 张未列出；用 card --list 查看全部）")
            truncated = True
            break
        lines.append(prefix + line)
        used += len(prefix) + len(line)
        current = kind
    if not cards:
        lines.append("\n\n（暂无已批准的卡片）")
    text = head + "".join(lines) + "\n"
    atomic_write(CONTEXT_FILE, text)
    listed = cards if not truncated else cards[: len([l for l in lines if "\n- `" in l])]
    return {"path": str(CONTEXT_FILE), "chars": len(text),
            "rules": sum(1 for c in listed if c["id"].startswith("rule/")),
            "knowledge": sum(1 for c in listed if c["id"].startswith("knowledge/")),
            "total": len(cards), "truncated": truncated}
