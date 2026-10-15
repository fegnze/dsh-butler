#!/bin/zsh
# Manual acceptance for run attention: posts a fake run to the live Host.
#   tests/smoke-run-attention.sh            start → steps → success
#   tests/smoke-run-attention.sh await      start → a step awaiting the owner
# Watch where you are in DSH when it fires: workbench (scroll + flash),
# a conversation (console opens in the right sidebar), another page (nudge),
# or another app (system notification only; routing happens on return).
set -eu
B=${BUTLER_BASE:-http://127.0.0.1:19387/myspace-butler}
R="smoke-$(date +%s)"
post() { curl -sf -o /dev/null -X POST "$B/runs/event" -H 'Content-Type: application/json' -d "$1"; }
post "{\"type\":\"run:start\",\"runId\":\"$R\",\"workflow\":\"attention-smoke\",\"title\":\"观测路由冒烟\",\"source\":\"cli\",\"steps\":[{\"name\":\"准备\"},{\"name\":\"执行\"},{\"name\":\"收尾\"}]}"
for i in 0 1 2; do
  post "{\"type\":\"step:start\",\"runId\":\"$R\",\"index\":$i}"
  sleep 2
  if [[ ${1:-} == await && $i == 1 ]]; then
    post "{\"type\":\"step:await\",\"runId\":\"$R\",\"index\":1,\"token\":\"smoke\",\"summary\":\"冒烟：只验证提醒路由，批准或拒绝都不会执行任何动作\",\"items\":[\"无副作用\"]}"
    echo "awaiting: $R (decide in the console; the step itself ends after 60s)"
    sleep 60
  fi
  post "{\"type\":\"step:end\",\"runId\":\"$R\",\"index\":$i,\"status\":\"success\",\"ms\":2000}"
done
post "{\"type\":\"run:end\",\"runId\":\"$R\",\"status\":\"success\"}"
echo "done: $R"
