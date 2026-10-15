"""Butler Framework SDK（Python 版）：工作流事件发射器。

让 Python 工具也能进宿主的运行观测区：照 TS runner 相同的 `/runs/event`
契约推事件。fire-and-forget，守护不在 / 出错都不影响业务流程。仅用标准库。

用法（把本文件所在目录加进 sys.path，或以 BUTLER_SDK_PY 指向它）：
    from butler_sdk import Workflow
    wf = Workflow("gmail-send", "Gmail 发送 · 月度审批",
                  ["解析 spec", "触发判断", "渲染", "发送"], source="cron", target="monthly")
    wf.start("解析 spec"); ...; wf.end("解析 spec")            # 成功
    wf.end("发送", "error", "SMTP 超时")                        # 失败
    wf.skip("渲染")                                            # 跳过
    wf.done("success")                                         # 或 wf.done("error", "...")
"""
from __future__ import annotations

import json
import os
import time
import uuid
import urllib.request

# 宿主地址解析顺序：WF_OBSERVER_URL（完整事件 URL，兼容）→ BUTLER_HOST_URL（宿主根，exec 注入）。
# 未注入即不推送——没有宿主就没有观测区，不再猜测端口。
_HOST = os.environ.get("BUTLER_HOST_URL") or os.environ.get("BUTLER_GUARDIAN_URL")
_URL = os.environ.get("WF_OBSERVER_URL") or (_HOST.rstrip("/") + "/runs/event" if _HOST else None)


def _post(payload: dict) -> None:
    if not _URL:
        return
    try:
        body = json.dumps({**payload, "at": int(time.time() * 1000)}).encode("utf-8")
        req = urllib.request.Request(_URL, data=body, headers={"Content-Type": "application/json"}, method="POST")
        urllib.request.urlopen(req, timeout=1.5).read()
    except Exception:
        pass  # 观测是尽力而为


class Workflow:
    """一次运行：按名字驱动 step 事件；步骤名须来自初始 steps 列表。"""

    def __init__(self, name: str, title: str, steps: list[str], source: str = "cron", target: str | None = None):
        self.name = name
        self.run_id = uuid.uuid4().hex[:8]
        self._steps = list(steps)
        self._t: dict[str, float] = {}
        _post({"type": "run:start", "runId": self.run_id, "workflow": name, "title": title,
               "source": source, "target": target, "steps": [{"name": s} for s in steps]})

    def _idx(self, name: str) -> int:
        return self._steps.index(name) if name in self._steps else -1

    def start(self, name: str) -> None:
        self._t[name] = time.time()
        _post({"type": "step:start", "runId": self.run_id, "index": self._idx(name), "name": name})

    def end(self, name: str, status: str = "success", error: str | None = None) -> None:
        ms = int((time.time() - self._t.get(name, time.time())) * 1000)
        _post({"type": "step:end", "runId": self.run_id, "index": self._idx(name), "name": name,
               "status": status, "ms": ms, "error": error})

    def skip(self, name: str) -> None:
        _post({"type": "step:end", "runId": self.run_id, "index": self._idx(name), "name": name, "status": "skipped"})

    def done(self, status: str = "success", error: str | None = None) -> None:
        _post({"type": "run:end", "runId": self.run_id, "status": status, "error": error})
