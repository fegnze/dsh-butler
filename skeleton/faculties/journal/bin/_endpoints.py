"""Journal faculty 外部端点生命周期：install / check / uninstall。

端点 id：claude、codex、workbuddy、git。

安全模型（详见 install --help）：
  - 只增删 Butler 自有内容：规则文件里的 `<!-- butler:begin vN -->…<!-- butler:end -->`
    区块、hook JSON 里 command 与 Butler 命令完全相同的 Stop hook、
    butler-port/SKILL.md（sha256 一致才删）、post-commit 里的 `# butler:begin/end` 区块。
  - 任何写入前先在内存里算出全部目标文件的新内容（JSON 可解析、marker 完整），
    预检失败零写入；随后逐个原子替换（保留 mode、跟随软链接），写前备份到
    <instance>/.state/endpoint-backups/，中途失败按快照回滚。
  - hook JSON 用定位编辑而非重新序列化，Butler 以外的字节逐字保留，
    卸载后能回到安装前的原文。

仅供 bin/ 下脚本导入。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

from _lib import BUTLER_ROOT, FACULTY_ROOT, REGISTRY_FILE, file_lock, utc_now

VERSION = 4
IDS = ("claude", "codex", "workbuddy", "git")
ACTIONS = ("install", "check", "uninstall")
BIN_DIR = FACULTY_ROOT / "bin"
SKILL_NAME = "butler-port"
LEGACY_SKILL = "myspace-port"
HOOK_TIMEOUT = 15

MD_BEGIN = re.compile(r"<!-- butler:begin\b[^\n]*?-->|<!-- butler:begin\b")
MD_END = re.compile(r"<!-- butler:end -->")
MD_VERSION = re.compile(r"<!-- butler:begin v(\d+) -->")
SH_BEGIN = re.compile(r"^# butler:begin\b.*$", re.MULTILINE)
SH_END = re.compile(r"^# butler:end\b.*$", re.MULTILINE)
SHEBANG = "#!/bin/sh\n"


class EndpointError(Exception):
    """预检或动作失败；消息直接展示给用户。"""


# ---------------------------------------------------------------- 路径与配置

def instance_root() -> Path:
    raw = os.environ.get("BUTLER_INSTANCE_ROOT")
    return Path(raw).expanduser().resolve() if raw else FACULTY_ROOT.parent.parent


def instance_config() -> dict:
    path = instance_root() / "butler.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise EndpointError(f"实例配置不可解析: {path}: {error}") from error
    return data if isinstance(data, dict) else {}


def backup_dir() -> Path:
    return instance_root() / ".state" / "endpoint-backups"


def interpreter(config: dict) -> str:
    raw = os.environ.get("BUTLER_PYTHON") or config.get("python") or sys.executable
    path = Path(str(raw)).expanduser()
    if not path.is_absolute():
        path = instance_root() / path
    # 不 resolve：venv 的 python 是软链接，解析后会丢掉 venv。
    return os.path.normpath(str(path))


def butler_command(config: dict, script: str, args: list[str]) -> str:
    parts = ["env", "BUTLER_SELF_ROOT=" + str(BUTLER_ROOT), interpreter(config),
             str(BIN_DIR / script), *args]
    return " ".join(shlex.quote(part) for part in parts)


def hook_command(config: dict, source: str) -> str:
    return butler_command(config, "hook-intake", ["--source", source]) + " || true"


def git_hook_line(config: dict) -> str:
    return (butler_command(config, "hook-intake", ["--source", "git", "--git"])
            + " </dev/null >/dev/null 2>&1 || true")


def endpoint_override(config: dict, name: str) -> dict:
    endpoints = config.get("endpoints")
    if endpoints is None:
        return {}
    if not isinstance(endpoints, dict):
        raise EndpointError("butler.json endpoints 必须是对象")
    value = endpoints.get(name)
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise EndpointError(f"butler.json endpoints.{name} 必须是对象")
    return value


def _path_option(override: dict, key: str, default: Path) -> Path:
    value = override.get(key)
    if value is None:
        return default
    if not isinstance(value, str) or not value.strip():
        raise EndpointError(f"endpoints 配置 {key} 必须是非空字符串")
    return Path(value).expanduser()


def agent_paths(name: str, config: dict) -> tuple[Path, Path]:
    home = Path.home()
    override = endpoint_override(config, name)
    if name == "claude":
        rules, hooks = home / ".claude" / "CLAUDE.md", home / ".claude" / "settings.json"
    else:
        rules, hooks = home / ".codex" / "AGENTS.md", home / ".codex" / "hooks.json"
    return _path_option(override, "path", rules), _path_option(override, "hookPath", hooks)


def skill_dir(config: dict) -> Path:
    return _path_option(endpoint_override(config, "workbuddy"), "path",
                        Path.home() / ".workbuddy" / "skills" / SKILL_NAME)


def git_repos(config: dict, entry: dict) -> list[str]:
    override = endpoint_override(config, "git")
    repos = override.get("repos") if "repos" in override else entry.get("repos", [])
    if repos is None:
        return []
    if not isinstance(repos, list) or not all(isinstance(r, str) and r.strip() for r in repos):
        raise EndpointError("git.repos 必须是非空字符串数组")
    return list(repos)


# ---------------------------------------------------------------- 注册表

def read_registry(strict: bool) -> dict:
    try:
        data = json.loads(REGISTRY_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        data = {"version": 1, "targets": {}}
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        if strict:
            raise EndpointError(f"注册表不可解析: {REGISTRY_FILE}: {error}") from error
        data = {}
    if not isinstance(data, dict):
        if strict:
            raise EndpointError(f"注册表必须是 JSON 对象: {REGISTRY_FILE}")
        data = {}
    targets = data.get("targets")
    if not isinstance(targets, dict):
        if strict and targets is not None:
            raise EndpointError("注册表 targets 必须是对象")
        targets = {}
    data["targets"] = targets
    data.setdefault("version", 1)
    return data


def entry_of(registry: dict, name: str) -> dict:
    entry = registry["targets"].get(name)
    return entry if isinstance(entry, dict) else {}


def installed_of(entry: dict) -> dict | None:
    value = entry.get("installed")
    return value if isinstance(value, dict) else None


def installed_version(installed: dict | None) -> int | None:
    if not installed:
        return None
    version = installed.get("version")
    return version if isinstance(version, int) and not isinstance(version, bool) else None


# ---------------------------------------------------------------- 文件写入

def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_text(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except UnicodeDecodeError as error:
        raise EndpointError(f"文件不是 UTF-8 文本: {path}") from error


class Change:
    """一次计划中的文件变更；content=None 表示删除。"""

    def __init__(self, path: Path, content: str | None, mode: int | None = None):
        self.path = path.expanduser().resolve()  # 跟随软链接，写真实文件
        self.content = content
        self.mode = mode


def _atomic_write(path: Path, data: bytes, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".butler-tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp, mode)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def _backup(path: Path, data: bytes) -> None:
    target = backup_dir()
    target.mkdir(parents=True, exist_ok=True)
    key = sha256_bytes(str(path).encode())[:12]
    stamp = utc_now().replace(":", "").replace("-", "")
    dest = target / f"{stamp}-{key}-{os.getpid()}-{path.name}.bak"
    counter = 0
    while dest.exists():
        counter += 1
        dest = target / f"{stamp}-{key}-{os.getpid()}-{counter}-{path.name}.bak"
    _atomic_write(dest, data, 0o600)


def apply_changes(changes: list[Change]) -> list[tuple[Path, bytes | None, int | None]]:
    """按计划写入；任一步失败回滚已写文件并抛出。返回快照供后续失败回滚。"""
    snapshots: list[tuple[Path, bytes | None, int | None]] = []
    try:
        for change in changes:
            path = change.path
            old = path.read_bytes() if path.exists() else None
            old_mode = stat.S_IMODE(path.stat().st_mode) if old is not None else None
            new = change.content.encode("utf-8") if change.content is not None else None
            mode = change.mode if change.mode is not None else old_mode
            if old == new and (new is None or mode == old_mode):
                continue
            if old is not None:
                _backup(path, old)
            snapshots.append((path, old, old_mode))
            if new is None:
                path.unlink()
            else:
                _atomic_write(path, new, mode if mode is not None else 0o644)
    except Exception:
        rollback(snapshots)
        raise
    return snapshots


def rollback(snapshots) -> None:
    for path, old, old_mode in reversed(snapshots):
        try:
            if old is None:
                if path.exists():
                    path.unlink()
            else:
                _atomic_write(path, old, old_mode if old_mode is not None else 0o644)
        except OSError as error:  # pragma: no cover - 尽力回滚
            print(f"endpoints: 回滚失败 {path}: {error}", file=sys.stderr)


# ---------------------------------------------------------------- marker 区块

def find_block(text: str, begin: re.Pattern, end: re.Pattern):
    """返回 (start, end, begin_match) 或 None；marker 不完整/重复抛错。"""
    begins = list(begin.finditer(text))
    ends = list(end.finditer(text))
    if not begins and not ends:
        return None
    if len(begins) != 1 or len(ends) != 1 or ends[0].start() < begins[0].end():
        raise EndpointError("Butler marker 不完整或重复，拒绝修改")
    stop = ends[0].end()
    if text[stop:stop + 1] == "\n":
        stop += 1
    return begins[0].start(), stop, begins[0]


def put_block(text: str | None, block: str, begin, end) -> str:
    if not text:
        return block
    found = find_block(text, begin, end)
    if found:
        return text[:found[0]] + block + text[found[1]:]
    return text + "\n" + block


def drop_block(text: str, begin, end) -> str:
    found = find_block(text, begin, end)
    if not found:
        return text
    head, tail = text[:found[0]], text[found[1]:]
    if not tail and head.endswith("\n"):
        head = head[:-1]  # 安装时追加的分隔换行
    return head + tail


def rules_block(name: str, config: dict) -> str:
    card = butler_command(config, "card", [])
    intake = butler_command(config, "intake", ["--source", name])
    return (f"<!-- butler:begin v{VERSION} -->\n"
            "## Butler 端点\n\n"
            f"- 执行涉及主人偏好或约束的任务前，运行 `{card}` 读取画像与卡片索引；需要某张卡的细节时运行 `{card} <id>`（如 rule/xxx）。\n"
            f"- 值得沉淀的事实/决策/里程碑，运行 `{intake} --type fact -- \"文本\"` 上报观察。\n"
            "- 回合结束由 Stop hook 自动记录会话引用；Butler 数据只经 journal faculty 命令写入，不手改。\n"
            "- 本区块由 Butler install 维护；区块以外的内容不归 Butler 管理。\n"
            "<!-- butler:end -->\n")


# ---------------------------------------------------------------- JSON 定位编辑

class _Node:
    __slots__ = ("kind", "start", "end", "items", "members")

    def __init__(self, kind, start):
        self.kind, self.start, self.end = kind, start, start
        self.items: list[_Node] = []
        self.members: list[tuple[str, int, _Node]] = []  # (key, key_start, value)


class _Spans:
    """只在 json.loads 成功后使用：记录每个值的字符区间。"""

    def __init__(self, text: str):
        self.text, self.i = text, 0

    def ws(self):
        while self.i < len(self.text) and self.text[self.i] in " \t\r\n":
            self.i += 1

    def string(self):
        self.i += 1
        while self.text[self.i] != '"':
            self.i += 2 if self.text[self.i] == "\\" else 1
        self.i += 1

    def value(self) -> _Node:
        self.ws()
        char = self.text[self.i]
        if char == "{":
            node = _Node("obj", self.i)
            self.i += 1
            self.ws()
            if self.text[self.i] == "}":
                self.i += 1
            else:
                while True:
                    self.ws()
                    key_start = self.i
                    self.string()
                    key = json.loads(self.text[key_start:self.i])
                    self.ws()
                    self.i += 1  # ':'
                    node.members.append((key, key_start, self.value()))
                    self.ws()
                    sep = self.text[self.i]
                    self.i += 1
                    if sep == "}":
                        break
        elif char == "[":
            node = _Node("arr", self.i)
            self.i += 1
            self.ws()
            if self.text[self.i] == "]":
                self.i += 1
            else:
                while True:
                    node.items.append(self.value())
                    self.ws()
                    sep = self.text[self.i]
                    self.i += 1
                    if sep == "]":
                        break
        elif char == '"':
            node = _Node("str", self.i)
            self.string()
        else:
            node = _Node("lit", self.i)
            while self.i < len(self.text) and self.text[self.i] not in ",]} \t\r\n":
                self.i += 1
        node.end = self.i
        return node


def _member(node: _Node | None, key: str) -> _Node | None:
    if node is None or node.kind != "obj":
        return None
    found = None
    for name, _, value in node.members:
        if name == key:
            found = value
    return found


def _member_index(node: _Node, key: str) -> int | None:
    found = None
    for index, (name, _, _) in enumerate(node.members):
        if name == key:
            found = index
    return found


def _spans(node: _Node) -> list[tuple[int, int]]:
    if node.kind == "obj":
        return [(start, value.end) for _, start, value in node.members]
    return [(item.start, item.end) for item in node.items]


def _insert(text: str, node: _Node, piece: str) -> str:
    spans = _spans(node)
    if not spans:
        at = node.start + 1
        return text[:at] + piece + text[at:]
    at = spans[-1][1]
    return text[:at] + ", " + piece + text[at:]


def _remove(text: str, node: _Node, index: int) -> str:
    spans = _spans(node)
    start, end = spans[index]
    if len(spans) == 1:
        return text[:start] + text[end:]
    if index == len(spans) - 1:
        return text[:spans[index - 1][1]] + text[end:]
    return text[:start] + text[spans[index + 1][0]:]


def parse_hook_json(text: str, path: Path):
    try:
        data = json.loads(text)
    except json.JSONDecodeError as error:
        raise EndpointError(f"hook 配置 JSON 无法解析: {path}: {error}") from error
    if not isinstance(data, dict):
        raise EndpointError(f"hook 配置必须是 JSON 对象: {path}")
    hooks = data.get("hooks")
    if hooks is not None and not isinstance(hooks, dict):
        raise EndpointError(f"hooks 必须是对象: {path}")
    if isinstance(hooks, dict) and hooks.get("Stop") is not None and not isinstance(hooks["Stop"], list):
        raise EndpointError(f"hooks.Stop 必须是数组: {path}")
    return data, _Spans(text).value()


def _command_of(text: str, node: _Node) -> str | None:
    value = _member(node, "command")
    if value is None or value.kind != "str":
        return None
    return json.loads(text[value.start:value.end])


def stop_commands(text: str, root: _Node) -> list[str]:
    stop = _member(_member(root, "hooks"), "Stop")
    found = []
    for group in (stop.items if stop is not None and stop.kind == "arr" else []):
        hooks = _member(group, "hooks")
        for hook in (hooks.items if hooks is not None and hooks.kind == "arr" else []):
            command = _command_of(text, hook) if hook.kind == "obj" else None
            if command is not None:
                found.append(command)
    return found


def remove_owned_hooks(text: str, path: Path, owned: set[str]) -> str:
    """删除 command 完全等于 owned 的 hook；group 只剩它们时整组删除（不留空 group）。"""
    while True:
        _, root = parse_hook_json(text, path)
        stop = _member(_member(root, "hooks"), "Stop")
        if stop is None or stop.kind != "arr":
            return text
        changed = False
        for index, group in enumerate(stop.items):
            hooks = _member(group, "hooks")
            if hooks is None or hooks.kind != "arr":
                continue
            hits = [i for i, hook in enumerate(hooks.items)
                    if hook.kind == "obj" and _command_of(text, hook) in owned]
            if not hits:
                continue
            if len(hits) == len(hooks.items):
                text = _remove(text, stop, index)
            else:
                text = _remove(text, hooks, hits[0])
            changed = True
            break
        if not changed:
            return text


def owned_group(command: str) -> str:
    return json.dumps({"matcher": ".*", "hooks": [
        {"type": "command", "command": command, "timeout": HOOK_TIMEOUT}]}, ensure_ascii=False)


def add_hook(text: str, path: Path, command: str) -> tuple[str, dict]:
    """在 hooks.Stop 末尾追加 Butler group；返回新文本与“由 Butler 创建的容器”标记。"""
    created = {"stop": False, "hooks": False}
    _, root = parse_hook_json(text, path)
    hooks = _member(root, "hooks")
    group = owned_group(command)
    if hooks is None:
        created.update(stop=True, hooks=True)
        return _insert(text, root, '"hooks": {"Stop": [' + group + "]}"), created
    stop = _member(hooks, "Stop")
    if stop is None or stop.kind != "arr":
        if stop is not None:  # "Stop": null → 视为缺失但不改写用户值
            raise EndpointError(f"hooks.Stop 必须是数组: {path}")
        created["stop"] = True
        return _insert(text, hooks, '"Stop": [' + group + "]"), created
    return _insert(text, stop, group), created


def prune_created(text: str, path: Path, created: dict) -> str:
    """卸载后回收 Butler 当初创建且现已为空的 Stop/hooks 容器。"""
    _, root = parse_hook_json(text, path)
    hooks = _member(root, "hooks")
    stop = _member(hooks, "Stop")
    if created.get("stop") and stop is not None and stop.kind == "arr" and not stop.items:
        text = _remove(text, hooks, _member_index(hooks, "Stop"))
        _, root = parse_hook_json(text, path)
        hooks = _member(root, "hooks")
    if created.get("hooks") and hooks is not None and hooks.kind == "obj" and not hooks.members:
        text = _remove(text, root, _member_index(root, "hooks"))
    return text


# ---------------------------------------------------------------- claude / codex

def plan_agent(name, action, config, entry, installed):
    rules_path, hooks_path = agent_paths(name, config)
    command = hook_command(config, name)
    owned = {command}
    if installed and isinstance(installed.get("hookCommand"), str):
        owned.add(installed["hookCommand"])
    created = dict(installed.get("created", {})) if installed and isinstance(installed.get("created"), dict) else {}
    changes = []

    rules = read_text(rules_path)
    hook_text = read_text(hooks_path)
    if rules is not None:
        find_block(rules, MD_BEGIN, MD_END)  # 预检 marker
    if hook_text is not None:
        parse_hook_json(hook_text, hooks_path)  # 预检 JSON

    if action == "install":
        new_rules = put_block(rules, rules_block(name, config), MD_BEGIN, MD_END)
        if rules is None:
            created["rules"] = True
        changes.append(Change(rules_path, new_rules, None if rules is not None else 0o644))

        base = hook_text if hook_text is not None else "{}\n"
        if hook_text is None:
            created.update(file=True)
        present = stop_commands(base, parse_hook_json(base, hooks_path)[1])
        if present.count(command) == 1 and not (owned - {command}) & set(present):
            new_hooks = base
        else:
            stripped = remove_owned_hooks(base, hooks_path, owned)
            new_hooks, made = add_hook(stripped, hooks_path, command)
            for key, value in made.items():
                created[key] = created.get(key, False) or value
        changes.append(Change(hooks_path, new_hooks, None if hook_text is not None else 0o600))
        record = {"hookCommand": command, "rulesPath": str(rules_path),
                  "hookPath": str(hooks_path), "created": created}
        return changes, record

    # uninstall
    if rules is not None:
        new_rules = drop_block(rules, MD_BEGIN, MD_END)
        if new_rules == "" and created.get("rules"):
            changes.append(Change(rules_path, None))
        else:
            changes.append(Change(rules_path, new_rules))
    if hook_text is not None:
        new_hooks = remove_owned_hooks(hook_text, hooks_path, owned)
        if new_hooks != hook_text:
            new_hooks = prune_created(new_hooks, hooks_path, created)
            if created.get("file") and json.loads(new_hooks) == {}:
                changes.append(Change(hooks_path, None))
            else:
                changes.append(Change(hooks_path, new_hooks))
    return changes, None


def status_agent(name, config, entry, installed):
    rules_path, hooks_path = agent_paths(name, config)
    command = hook_command(config, name)
    errors, legacy = [], False
    block_version = None
    rules = read_text(rules_path)
    if rules is not None:
        try:
            found = find_block(rules, MD_BEGIN, MD_END)
        except EndpointError as error:
            errors.append(f"{rules_path}: {error}")
            found = None
        if found:
            match = MD_VERSION.match(rules, found[0])
            block_version = int(match.group(1)) if match else 0
            if block_version < VERSION:
                legacy = True
            elif rules[found[0]:found[1]] != rules_block(name, config):
                errors.append(f"{rules_path}: Butler 区块内容与当前版本不一致")
    hook_present = False
    hook_text = read_text(hooks_path)
    if hook_text is not None:
        try:
            _, root = parse_hook_json(hook_text, hooks_path)
            hook_present = command in stop_commands(hook_text, root)
        except EndpointError as error:
            errors.append(str(error))
    if installed:
        if installed_version(installed) != VERSION or not installed.get("hookCommand"):
            legacy = True
        else:
            if installed.get("hookCommand") != command:
                legacy = True
            if block_version is None and not errors:
                errors.append(f"规则区块缺失: {rules_path}")
            if not hook_present and not legacy:
                errors.append(f"Stop hook 缺失: {hooks_path}")
    elif block_version is not None or hook_present:
        legacy = True  # 有 Butler 痕迹但注册表未记录
    return errors, legacy


# ---------------------------------------------------------------- workbuddy

def skill_text(config: dict) -> str:
    card = butler_command(config, "card", [])
    intake = butler_command(config, "intake", ["--source", "workbuddy"])
    return ("---\n"
            f"name: {SKILL_NAME}\n"
            "description: \"Butler 端点（WorkBuddy）：读取主人画像与规则/知识卡、向 Butler 上报观察。"
            "涉及个人偏好、Butler、管家、上报观察时使用。\"\n"
            "---\n\n"
            "# Butler 端点\n\n"
            f"<!-- butler:managed v{VERSION} -->\n\n"
            f"- 执行涉及主人偏好或约束的任务前，运行 `{card}` 读取画像与卡片索引；需要某张卡的细节时运行 `{card} <id>`（如 rule/xxx）。\n"
            f"- 值得沉淀的事实/决策/里程碑，运行 `{intake} --type fact -- \"文本\"` 上报观察。\n"
            "- Butler 数据只经 journal faculty 命令写入，不手改。\n"
            "- 本文件由 Butler install --target workbuddy 生成并以 sha256 校验，勿手改。\n")


def plan_workbuddy(action, config, entry, installed):
    directory = skill_dir(config)
    path = directory / "SKILL.md"
    recorded = installed.get("sha256") if installed else None
    current = path.read_bytes() if path.exists() else None
    current_sha = sha256_bytes(current) if current is not None else None
    text = skill_text(config)
    digest = sha256_bytes(text.encode("utf-8"))
    if action == "install":
        if current is not None and current_sha not in (recorded, digest):
            raise EndpointError(f"拒绝覆盖非 Butler 或已被修改的 skill: {path}")
        created_dir = bool(installed and installed.get("createdDir")) or not directory.exists()
        return [Change(path, text, None if current is not None else 0o644)], {
            "sha256": digest, "path": str(path), "createdDir": created_dir}
    if current is None:
        return [], None
    if not recorded or current_sha != recorded:
        raise EndpointError(f"skill 内容与安装记录的 sha256 不一致，拒绝删除: {path}")
    return [Change(path, None)], None


def status_workbuddy(config, entry, installed):
    path = skill_dir(config) / "SKILL.md"
    legacy_dir = Path.home() / ".workbuddy" / "skills" / LEGACY_SKILL
    errors, legacy = [], False
    if installed:
        if installed_version(installed) != VERSION or not installed.get("sha256"):
            legacy = True
        elif not path.exists():
            errors.append(f"skill 缺失: {path}")
        elif sha256_bytes(path.read_bytes()) != installed["sha256"]:
            errors.append(f"skill 内容 sha256 与安装记录不一致: {path}")
        elif installed["sha256"] != sha256_bytes(skill_text(config).encode("utf-8")):
            legacy = True  # 已安装旧模板，重新 install 即可升级
    elif legacy_dir.exists():
        legacy = True
    return errors, legacy


# ---------------------------------------------------------------- git

def _git(repo: Path, args: list[str]) -> str:
    try:
        result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True,
                                text=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise EndpointError(f"git 调用失败: {error}") from error
    if result.returncode != 0:
        raise EndpointError(f"不是 git 仓库或 git 失败: {repo}: {result.stderr.strip()}")
    return result.stdout.strip()


def git_hook_file(repo_raw: str) -> Path:
    repo = Path(repo_raw).expanduser()
    if not repo.is_dir():
        raise EndpointError(f"git 仓库目录不存在: {repo}")
    hooks = Path(_git(repo, ["rev-parse", "--git-path", "hooks"]))
    if not hooks.is_absolute():
        hooks = repo / hooks  # 相对路径相对于 -C 目录（含 core.hooksPath / worktree）
    return (hooks / "post-commit").resolve()


def git_block(config: dict) -> str:
    return f"# butler:begin\n{git_hook_line(config)}\n# butler:end\n"


def _is_executable(mode: int) -> bool:
    return bool(mode & stat.S_IXUSR)


def plan_git(action, config, entry, installed):
    configured = git_repos(config, entry)
    recorded = installed.get("repos") if installed and isinstance(installed.get("repos"), dict) else {}
    block = git_block(config)
    changes, files, seen = [], {}, set()
    if action == "install":
        if not configured:
            raise EndpointError("未配置 git 仓库：在 butler.json endpoints.git.repos 中列出")
        for repo in configured:
            hook = git_hook_file(repo)
            if hook in seen:
                continue
            seen.add(hook)
            text = read_text(hook)
            previous = recorded.get(repo) if isinstance(recorded.get(repo), dict) else {}
            if text is None:
                new, mode, created, original_mode = SHEBANG + "\n" + block, 0o755, True, None
            else:
                new = put_block(text, block, SH_BEGIN, SH_END)
                current_mode = stat.S_IMODE(hook.stat().st_mode)
                created = bool(previous.get("created"))
                original_mode = previous.get("originalMode")
                if not _is_executable(current_mode):
                    original_mode = current_mode
                    mode = current_mode | ((current_mode & 0o444) >> 2)
                else:
                    mode = None
            changes.append(Change(hook, new, mode))
            files[repo] = {"hookFile": str(hook), "created": created}
            if original_mode is not None:
                files[repo]["originalMode"] = original_mode
        merged = {k: v for k, v in recorded.items() if isinstance(v, dict)}
        merged.update(files)
        return changes, {"hookCommand": git_hook_line(config), "repos": merged}

    for repo in dict.fromkeys([*configured, *recorded.keys()]):
        info = recorded.get(repo) if isinstance(recorded.get(repo), dict) else {}
        try:
            hook = git_hook_file(repo)
        except EndpointError:
            if not info.get("hookFile"):
                continue  # 仓库已不存在且无安装记录：无可删
            hook = Path(info["hookFile"])
        if hook in seen:
            continue
        seen.add(hook)
        text = read_text(hook)
        if text is None:
            continue  # 不存在则不创建
        new = drop_block(text, SH_BEGIN, SH_END)
        if new == text:
            continue
        if info.get("created") and new.strip() in ("", SHEBANG.strip()):
            changes.append(Change(hook, None))
        else:
            mode = info.get("originalMode") if isinstance(info.get("originalMode"), int) else None
            changes.append(Change(hook, new, mode))
    return changes, None


def status_git(config, entry, installed):
    errors, legacy = [], False
    try:
        repos = git_repos(config, entry)
    except EndpointError as error:
        return [str(error)], False
    block = git_block(config)
    if installed:
        if installed_version(installed) != VERSION or not installed.get("hookCommand"):
            return errors, True
        if installed.get("hookCommand") != git_hook_line(config):
            legacy = True
        if not repos:
            errors.append("未配置 git 仓库")
    for repo in repos:
        try:
            hook = git_hook_file(repo)
        except EndpointError as error:
            errors.append(str(error))
            continue
        text = read_text(hook)
        found = None
        if text is not None:
            try:
                found = find_block(text, SH_BEGIN, SH_END)
            except EndpointError as error:
                errors.append(f"{hook}: {error}")
                continue
        if not installed:
            if found:
                legacy = True
            continue
        if not found:
            errors.append(f"post-commit 缺少 Butler 区块: {hook}")
        elif text[found[0]:found[1]] != block and not legacy:
            errors.append(f"post-commit Butler 区块与当前版本不一致: {hook}")
        elif not _is_executable(stat.S_IMODE(hook.stat().st_mode)):
            errors.append(f"post-commit 不可执行: {hook}")
    return errors, legacy


# ---------------------------------------------------------------- 入口

def _result(name: str, installed: dict | None, errors: list[str], legacy: bool) -> dict:
    if errors:
        state = "fail"
    elif legacy:
        state = "legacy"
    elif installed:
        state = "ok"
    else:
        state = "missing"
    return {"id": name, "installed": bool(installed), "version": installed_version(installed),
            "status": state, "errors": errors, "lastCheck": utc_now()}


def status(name: str, registry: dict | None = None) -> dict:
    installed = None
    try:
        registry = registry if registry is not None else read_registry(strict=False)
        entry = entry_of(registry, name)
        installed = installed_of(entry)
        config = instance_config()
        if name in ("claude", "codex"):
            errors, legacy = status_agent(name, config, entry, installed)
        elif name == "workbuddy":
            errors, legacy = status_workbuddy(config, entry, installed)
        else:
            errors, legacy = status_git(config, entry, installed)
    except (EndpointError, OSError, ValueError) as error:
        errors, legacy = [str(error)], False
    return _result(name, installed, errors, legacy)


def list_status() -> list[dict]:
    registry = read_registry(strict=False)
    return [status(name, registry) for name in IDS]


def lifecycle(name: str, action: str) -> dict:
    if name not in IDS:
        raise EndpointError(f"未知端点 {name!r}")
    if action not in ACTIONS:
        raise EndpointError(f"未知动作 {action!r}")
    if action == "check":
        return status(name)
    REGISTRY_FILE.parent.mkdir(parents=True, exist_ok=True)
    with file_lock(REGISTRY_FILE.with_name("endpoints.lock")):
        registry = read_registry(strict=True)
        entry = entry_of(registry, name)
        installed = installed_of(entry)
        config = instance_config()
        if name in ("claude", "codex"):
            changes, record = plan_agent(name, action, config, entry, installed)
        elif name == "workbuddy":
            changes, record = plan_workbuddy(action, config, entry, installed)
        else:
            changes, record = plan_git(action, config, entry, installed)

        # 预检已完成（plan_* 读取并校验了全部目标），开始写入。
        snapshots = apply_changes(changes)
        new_entry = {k: v for k, v in entry.items()
                     if k not in ("installed", "driver", "path", "endpoint_version")}
        new_entry["kind"] = {"claude": "agent-rules+stop-hook", "codex": "agent-rules+stop-hook",
                             "workbuddy": "skill", "git": "git-post-commit"}[name]
        display = record.get("rulesPath") or record.get("path") if record else None
        if display:
            new_entry["path"] = display  # 仅供 Host 展示；路径权威是 butler.json 与默认值
        if record is not None:
            previous = installed if installed and installed_version(installed) == VERSION else {}
            unchanged = not snapshots and all(previous.get(k) == v for k, v in record.items())
            ts = previous.get("ts") if unchanged and previous.get("ts") else utc_now()
            new_entry["endpoint_version"] = VERSION
            new_entry["installed"] = {"version": VERSION, "ts": ts, **record}
        registry["targets"][name] = new_entry
        try:
            tmp = REGISTRY_FILE.with_name(REGISTRY_FILE.name + ".tmp")
            tmp.write_text(json.dumps(registry, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            os.replace(tmp, REGISTRY_FILE)
        except OSError:
            rollback(snapshots)
            raise
    return status(name)
