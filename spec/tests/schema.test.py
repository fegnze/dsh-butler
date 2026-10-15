"""butler.schema.json 契约测试：4 正例 + 11 负例。运行：uvx --with jsonschema python dsh-plugins/dsh-butler/spec/tests/schema.test.py"""
import json, os, sys
from jsonschema import Draft202012Validator

HERE = os.path.dirname(os.path.abspath(__file__))
schema = json.load(open(os.path.join(HERE, '..', 'butler.schema.json')))
Draft202012Validator.check_schema(schema)
v = Draft202012Validator(schema)

cases = {
  "tool-hosted": {"schemaVersion":1,"kind":"tool","id":"feishu-document-gateway","name":"Feishu","hosted":{"command":["bun","src/cli.ts","serve"],"port":37891,"autoStart":True},"health":{"url":"http://127.0.0.1:37891/health/live"},"panelUrl":"http://127.0.0.1:37891/admin","panelSize":{"width":1200,"height":800},"actions":[{"label":"发布","url":"http://127.0.0.1:37897/admin/publish"}]},
  "service": {"schemaVersion":1,"kind":"service","id":"wtc-web","name":"WTC-Web","hosted":{"command":"npm run dev","cwd":"/Users/ghost/work/WTC-Web","port":5174,"autoStart":True}},
  "faculty": {"schemaVersion":1,"kind":"faculty","id":"journal","name":"观察总账","commands":[{"id":"intake","exec":["bin/intake"],"effect":"write"},{"id":"run","exec":["bin/run"],"effect":"write"}],"reports":[{"id":"doctor","name":"巡检","exec":["bin/doctor","--json"],"shape":"status"}]},
  "tool-mcp": {"schemaVersion":1,"kind":"tool","id":"feishu-document-gateway","name":"Feishu","mcp":{"transport":"stdio","command":["bun","src/cli.ts","mcp"],"namespace":"feishu","timeoutSec":900}},
  "BAD mcp-self-exposed-http": {"schemaVersion":1,"kind":"tool","id":"x","name":"x","mcp":{"transport":"http","url":"http://127.0.0.1:1/mcp"}},
  "BAD mcp-namespace-separator": {"schemaVersion":1,"kind":"tool","id":"x","name":"x","mcp":{"transport":"stdio","command":["a"],"namespace":"a__b"}},
  "BAD faculty-with-mcp": {"schemaVersion":1,"kind":"faculty","id":"x","name":"x","mcp":{"transport":"stdio","command":["a"]}},
  "BAD service-with-actions": {"schemaVersion":1,"kind":"service","id":"x","name":"x","hosted":{"command":"a"},"actions":[{"label":"a","url":"http://x"}]},
  "BAD service-no-hosted": {"schemaVersion":1,"kind":"service","id":"x","name":"x"},
  "BAD faculty-with-panel": {"schemaVersion":1,"kind":"faculty","id":"x","name":"x","panelUrl":"http://x"},
  "BAD tool-panel-size-width": {"schemaVersion":1,"kind":"tool","id":"x","name":"x","panelSize":{"width":319}},
  "BAD service-with-panel-size": {"schemaVersion":1,"kind":"service","id":"x","name":"x","hosted":{"command":"a"},"panelSize":{"width":800}},
  "BAD tool-with-flows": {"schemaVersion":1,"kind":"tool","id":"x","name":"x","flows":[{"id":"f","name":"F","exec":["a"],"effect":"read"}]},
  "BAD action-mode-flow": {"schemaVersion":1,"kind":"tool","id":"x","name":"x","actions":[{"label":"a","mode":"flow","flow":"f"}]},
  "BAD bad-id": {"schemaVersion":1,"kind":"tool","id":"Bad_ID","name":"x"},
}
ok = True
for name, doc in cases.items():
    errs = list(v.iter_errors(doc))
    passed = (len(errs) > 0) == name.startswith("BAD")
    ok &= passed
    print(("PASS" if passed else "FAIL"), name, "" if not errs else "-> " + errs[0].message[:80])
sys.exit(0 if ok else 1)
