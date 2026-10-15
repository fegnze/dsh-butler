# dsh-butler

English | [中文](<docs/zh.md>)

`dsh-butler` is the Butler plugin for the DSH App, shipping its browser UI and local host in one package. The host registers routes, scans extensions, and manages processes through DSH's `webServer` and `subprocess` services. It does not start a standalone Guardian, install a LaunchAgent, or depend on Nowledge Mem.

## Working directory

Plugin configuration accepts `workdir`, defaulting to `~/.dsh/butler/`. On first load, the plugin copies its built-in generic skeleton; a directory that already contains `butler.json` is not overwritten. Personal data, interpreter configuration, and extensions belong to the instance working directory and can be migrated together. The plugin does not assume a personal workspace.

Example root configuration for the working directory:

```json
{
  "scanRoots": ["tools", "services", "faculties"],
  "selfRoot": "self",
  "validityRoot": ".",
  "python": "/path/to/python",
  "bun": "/opt/homebrew/bin/bun",
  "notification": {
    "enabled": true,
    "command": ["bun", "notification-bridge/scripts/cli.js", "send", "--stdin"]
  },
  "endpoints": {},
  "collector": { "enabled": true, "workspaces": [], "excludePresets": ["butler"], "debounceMs": 2000 },
  "automations": {}
}
```

Relative paths are resolved against the directory containing `butler.json`. Extensions under `tools/` and `services/` with `hosted.autoStart` resume when the DSH App starts; DSH's subprocess managed range terminates them when the App exits or the plugin unloads. Services do not restart automatically; tools restart inside the host according to their manifest policy. Bounded commands and reports from `faculties/` also run through the same subprocess integration.

## Host API

Public Host APIs share DSH's same-origin prefix `/myspace-butler/api`; the original client paths `/myspace-butler/*` remain compatibility aliases. Routes include `/health`, `/catalog`, `/services`, `/faculties`, `/runs`, and `/quick-actions`; tool lists come from `/overview`. Both tools and services support `/:kind/:id/{start,stop,restart}` and `/:kind/:id/log` SSE. Requests accept only local same-origin browser traffic or local SDK calls. The public extension catalog excludes commands and environment variables; configuration-editing endpoints are for trusted local calls only. See [HOST.md](<HOST.md>) for the complete routes.

Extensions use a `butler.json` in each directory; see [the schema](<spec/butler.schema.json>) for all fields. The SDK runner sends events using `BUTLER_HOST_URL`; `BUTLER_GUARDIAN_URL` is only a compatibility alias for old extensions, not a new configuration entry point.

**Delegations:** tools/services may declare steps requiring judgment in their manifests. The Host delegates them to a new Butler Session (`POST /delegations`, blocking until submission, timeout, or failure). Only the Host drives sessions: it creates a butler-preset session with `sessionController.create`, delivers a `prompt` using the delegation ID as requestId, and calls `cancel` on timeout. The session may use only the declared tools and `butler_delegation_submit`; results are validated against the declared schema. Results with `risk: confirm` remain pending in the observation area. `POST /runs/:runId/steps/:i/confirm` uses the same owner-only gate as card review (`X-Butler-Review` plus same-origin Origin or authenticated desktop forwarding). If DSH does not provide `sessionController.prompt`, `/delegations` returns 503 and callers use their own fallback. See [the SDK README](<sdk/README.md>) for usage.

## Unified MCP service (Butler Framework MCP standard)

Three layers communicate only through manifests and the MCP protocol:

| Layer | Responsibility | Exclusions |
| --- | --- | --- |
| Framework (`spec/butler.schema.json`) | Defines the `mcp` registration block: `transport: "stdio"`, `command`, optional `cwd/env/namespace/timeoutSec`; tools/services only | No independently exposed `http`/`url` forms |
| Host (`src/host/mcp-hub.ts`) | Derives providers from scan results without a second registry; starts stdio subprocesses through `Spawner` on demand; aggregates as `<namespace>__<tool>`; serves stateless Streamable HTTP at `/myspace-butler/api/mcp`; adds/removes providers on rescan and restarts them when idle; terminates with the managed range on App exit | Does not import extension code or interpret business parameters |
| Extension | Implements a stdio MCP server | Does not listen on an MCP port or call Host internals; may reject direct client connections using `BUTLER_MCP_CHANNEL=butler-hub` |

Clients configure just one address: `http://127.0.0.1:19387/myspace-butler/api/mcp` (the desktop profile's App port). `GET /api/mcp/status` reports provider status, exposed tool names, namespace conflicts, and rejected tool names. The default namespace replaces `-` in the ID with `_`; exposed names must match `^[A-Za-z0-9_-]{1,64}$`. Nonmatching tools are not exposed and appear in status. A provider crash affects only that provider: calls return an `isError` result and startup is retried after 5 seconds, without affecting other providers. The security boundary matches other Host APIs: loopback only, rejecting cross-site Origins (the DNS rebinding protection required by MCP).

**Unified MCP service:** tools/services in Butler that provide MCP declare only an `mcp` block (`transport:"stdio"` plus `command`). The Host lazily starts and aggregates them, exposing `POST /myspace-butler/api/mcp` (Streamable HTTP) with tool names `<namespace>__<tool>`. **Tools must not expose their own MCP listener or register directly with any client.** The Host does not import tool code; tools depend only on stdio MCP and the `BUTLER_MCP_CHANNEL` environment marker. The manifest contract is the sole connection between them. Clients register only `http://127.0.0.1:19387/myspace-butler/api/mcp`; status is at `/api/mcp/status`. See [HOST.md](<HOST.md#mcp-统一服务>).

## Dashboard display preferences

Services and tools each retain a “Show all / Show resident” mode. The heading arrow switches the display scope rather than collapsing the whole section. “Display management · N stored” is a single entry opening a drawer with all items. There you can mark items resident, operate them directly, and save or cancel display changes; card menus can also store individual items or mark them resident.

Storing an item is exclusively a manual choice, not inferred from autoStart, running state, or usage frequency; it does not change manifests or start/stop processes. Newly registered items are resident by default. Search always covers names, IDs, and descriptions of all items, marking matching stored items. Clearing search restores the previous mode. Sorting is disabled when some items are hidden or a search is active; showing all enables sorting.

Preferences use the Host's existing `layout.json` (version 1, adding optional `display.services/tools: { mode: 'all' | 'resident', stored: string[] }`), remaining compatible with old files. The page and sidebar share them, and they survive refreshes. “Reset order” clears only `order`, not display preferences. A failed save rolls back the display while retaining the drawer draft; older polling results do not overwrite newly saved settings.

## Development and verification

The full test suite includes maintainer-workspace fixtures, historical Git objects, and desktop integration checks; it is not a standalone-install smoke test. The portable CI slice after building is `bun test ./tests/build-launcher.test.ts ./tests/record-ref.test.ts ./tests/pipeline-agent-tools.test.ts`. Passing this slice does not establish full-suite or live-desktop acceptance.

```sh
# Requires Node, Bun, and Python 3.10+
npm run build
bun test
bun test contract.test.ts
bun run typecheck
```

`dsh/host.js` and `dsh/client.js` are built artifacts shipped in the package; rerun `npm run build` after host or UI changes. The build launcher selects, in order: `BUTLER_PYTHON` (a single interpreter path or command name), the nearest `.venv` found by walking upward from the plugin directory, then Python 3.10+ on PATH. An invalid explicit configuration or virtual environment fails immediately rather than falling back to the system interpreter. Specify one with `BUTLER_PYTHON=/path/to/venv/bin/python npm run build`. Installation is described below. Historical Plan acceptance records remain only in the maintainer's local workspace and are not distributed in the repository or npm package.

Client dynamic styles are marked `data-plugin="myspace-butler-panel"` before insertion into the DOM. `data-plugin-css` identifies styles but does not establish ownership. DSH assigns unowned styles to subsequently loaded plugins, which can incorrectly remove dashboard styles when disabling or hot-reloading plugins such as Aqua. Each effect still handles its own style cleanup.

## DSH App installation

Install only in the desktop profile; local development may use `link:/path/to/dsh-butler`. **The current CLI refuses to manage the desktop profile.** Do not run `dsh plugin --profile desktop add` from old plans. Use the App plugin manager, or quit the App and modify dependencies using its bundled pnpm:

```sh
# Use the App's matching Node/pnpm to avoid nvm pnpm store-version mismatches.
# Replace the link with your checkout; runtime paths depend on the actual App installation.
ELECTRON_RUN_AS_NODE=1 \
"/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" --expose-internals \
  "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/pnpm/bin/pnpm.mjs" \
  --dir "$HOME/.dsh/profiles/desktop" add \
  'dsh-butler@link:/path/to/dsh-butler' \
  --config.minimum-release-age=1440
```

Manual installation also requires registering `dsh-butler` in `dsh.profile.bundles` in the desktop `package.json`, and configuring `cordis.patch.yml`:

```yaml
- id: butler-panel
  config:
    workdir: /path/to/butler-instance
```

If pnpm reports a minimum release age error, check for duplicate package names shadowing entries in the exclusion list; do not disable validation globally. After Host bundle changes, fully quit and reopen the App; refreshing the web page alone does not reload Node modules. Acceptance checks must cover new APIs, individual start/stop operations, processes and listening ports after exit, and autoStart items after reopening. An existing link or passing tests alone is not sufficient.

Keep the plugin checkout and instance working directory separate. On case-insensitive filesystems, do not distinguish them solely by directory-name capitalization.

## Card lifecycle redesign (in progress)

The new core pipeline is: session evidence → complete candidate card → human review → Markdown Wiki → Agent search/read. Redesign plans and implementation records are local maintainer Plan documents, not distributed in the public repository or npm package. Updating source does not automatically migrate historical personal data; dry-run migration first. The M1–M4 sections below describe the old pipeline and must not be taken as evidence that unfinished transitions are live.

The new UI opens pending confirmations by default, with separate card-library and session areas; runs and settings retain the old maintenance capabilities. The new same-origin `/myspace-butler/api/pipeline` route invokes faculty commands through the DSH Host without starting another service. Ordinary model tools do not expose approval actions.

The protocol is `POST {action,args}`, returning `{ok:true,data}` or `{ok:false,error:{code,message}}`. Review first calls `review.prepare` for a short-lived token, then submits the same candidate's `id/revision/contentHash` with an `idempotencyKey`. An explicit same-origin Origin, Sec-Fetch-Site, and `X-Butler-Review: 1` are required. The UI does not automatically retry approvals. Bodies and hashes pass through unchanged; only run/lease token fields are stripped. Credentials are redacted during collection.

Approved-card validity separates approval state (`status` active/archived, changed only by human approval) from validity (`valid`/`suspended`). Validity lives in `self/validity/<id>.json`, bound to the card's `revision+contentHash`, without editing the card file or triggering injection replay. Checks have only two deterministic types: `path` (a file exists relative to `validityRoot`) and `quote` (the file still contains that exact text, with whitespace normalized). `validityRoot` defaults to the working directory and is passed to faculties via `BUTLER_VALIDITY_ROOT`; absolute paths, `..`, and symlinks escaping the root are rejected. Checks refresh on card reads, searches, and `distill.claim`; unchanged conclusions are not written to disk. Failed checks automatically suspend a card, restored evidence automatically restores it, and an unavailable root retains the previous conclusion. Distillation candidates may carry `checks` (effective after approval, must already pass at submission; not accepted for profile cards) and `conflict` (revise/archive only; submitting suspends the target card, cleared when the owner rejects the candidate or approves the revision). Set checks on existing cards with the operational command `validity.set-checks` (faculty CLI only, requiring the current revision); `validity.refresh` refreshes all. `scope` means visibility only (default `local`); applicability belongs in `appliesTo`. Free-text scope in old cards is automatically converted to `appliesTo` on read.

The faculty centrally determines consumability: `cards.search`/`cards.read` return only active, unsuspended cards by default; reading suspended or archived cards returns `card_unavailable`. Injection, `butler_search/read`, and the `card` command all use this decision, with an additional fallback filter in consumer tools. Only the card-library UI may pass `includeInactive` over HTTP to view archived and suspended cards. Model tool schemas omit this parameter and reject it if supplied. Searches match only titles, summaries, applicability, tags, and bodies, not evidence or metadata.

Agent consumption boundaries: automatic injection contains only approved-card titles, summaries, and version indexes. `butler_search` returns core index fields, not bodies; `butler_read` returns core bodies and related card IDs on demand. Evidence, review reasons, hashes, internal paths, and decision metadata remain in the management interface and are not returned by consumer tools. Card bodies should contain currently valid content, not historical evidence standing in for core content.

The root-level `dsh-butler/consumer` plugin registers `butler_search`, `butler_read`, and `butler_report_session` for ordinary Agents without installing a tool limiter. Presets can inherit DSH root tools while retaining their own restrictions. The Consumer uses only the working directory published by the Host; the interpreter must be configured through the instance's `python` setting. The restricted Butler preset additionally provides tools for claiming batches, reading evidence, submitting candidates, and completing batches.

Existing instance faculties are independent file copies; updating source does not automatically update instances. `deploy-faculty.py --workdir <instance>` only outputs a deployment dry-run by default. Only `--apply` writes validated pipeline modules plus legacy write-protection and read-switch commands. Legacy commands can be upgraded only when they match the fixed repository baseline or a previous deployment manifest; personal modifications are not overwritten. An explicit store marker still controls the old-data switchover: before Wiki activation, reads/reviews of new approved cards return `store_not_active`, not a successful empty library; sessions and candidate drafts can still be saved. Migration tools and crash recovery are undergoing acceptance testing; the real instance has not switched over yet.

The collector saves redacted messages for each turn rather than 200-character markers. Truncated long messages/tool results are marked partial. Redacted segments are first saved atomically to stateDir/collector-pending and deleted only after an explicit JSON success acknowledgment. Failures are retained and replayed on startup or flush; normal unload flushes before closing the subprocess. Persistence failures or capacity overruns generate warnings, not claims of completed collection. Passing builds and tests is not equivalent to runtime acceptance after an App restart.

## Session Collector (M1, legacy pipeline)

The host subscribes to DSH `session/event`, handling only `turn/end`. After debouncing by `session.header.id` for `collector.debounceMs`, it extracts the current turn from `session.snapshotEvents()` (the corresponding `turn/start` through `turn/end`), derives a `type=session` observation, and invokes journal `intake --source dsh --ref dsh://<session>#<turn>` to write to the spool:

- Text: the first `user/message` in the turn with `source.kind === 'user'`, truncated to 200 characters; plugin context from `agent.inject()` is excluded.
- `toolsUsed`: `tool/call.name`; `filesTouched`: `file_path`/`path` in `tool/call.arguments`; `gitCommits`: `[branch sha]` in `tool/result` text.
- `failed`: `tool/result` carries `error` or `isError`, or `turn/end.reason.kind === 'error'`.
- Filtering: skip when `header.agentPreset` matches `excludePresets` (default `butler`, preventing collection loops), or when a nonempty `workspaces` list excludes `header.cwd`. Delegated sessions with `header.origin === 'subagent'` are skipped by default (covered by the parent turn); enable with `collector.includeSubagents: true`.

The Collector does not write directly to `self/`. Unavailable `snapshotEvents` or intake failures produce `[butler] collector:` warnings in the App log rather than throwing into DSH's event chain. Host bundle changes require a full App restart to take effect.

### `POST /api/observe`

External probes (endpoint hooks/scripts) report an observation with body `{source, type?, tags?, text, ref?}`: `source` uses `[a-z0-9-]`; `type` is one of `note|decision|fact|milestone|error|session` (default `note`); `text` is 1–2000 characters; `tags` is an array of strings without commas/control characters (≤32); `ref` is ≤500 characters. Success: 202 `{queued:true}`; validation failure: 400 `invalid_observation`; intake failure: 502 `intake_failed`; cross-site request: 403. This only appends to the spool, not directly to the journal.

### L0 direct observations

Facts witnessed by the Host also enter the spool through `intake --source butler`, with `ref` set to `butler://<subject>`: unexpected tool exits (`type=error`, `tool:<id>`, including exit code and next restart interval), service crashes (`type=error`, `service:<id>`), and extensions added/removed on rescan (`type=note`, `catalog:<id>`). Manual stops, restarts, and the first startup scan are not recorded. Observation failures only write to the App log and do not affect hosting.

The desktop App is Butler's sole runtime host: extensions are not managed while the App is not running, and no Butler subprocesses should remain after App exit.

## Context injection (M3)

- Persisted artifacts use one file per card: rule cards at `self/rules/<slug>.md` (owner-approved working agreements; root rules take precedence in conflicts), and knowledge cards at `self/knowledge/<slug>.md`.
- `journal/bin/build-context` compiles the owner profile and card index (one line per card: ID, title, summary) into `self/build/context.md`, with a default limit of 8000 characters. The profile is not truncated; card bodies are excluded. `run`, successful `apply`, and `migrate-rules` automatically rebuild it.
- Agents read cards on demand: ordinary sessions run `card <id>` (the index gives the full command); Butler sessions use `butler_card`.
- The Host registers `agent/pre-step` (`prepend`) in the same `ctx.effect`. Each eligible session receives one injection: a plugin snapshot user message with `source.kind = plugin:myspace-butler-panel`, section `butler-context`. Deduplication checks the model-visible `session.deriveMessages()`; if compaction removes the message, it is injected once again.
- Root `butler.json` controls `inject`: `enabled`, `workspaces`, `excludePresets` (default `["butler"]`), `includeSubagents`, and `maxChars`. Messages are constructed locally with the same shape as `createUserMessage` from `@deepseek-ai/dsh-llm`. When symlinked into the profile, the plugin cannot resolve the App's bundled package; importing it prevents the entire plugin from loading (verified on the real application).

## M4 decisions

- WorkBuddy and git endpoints were implemented in M1B; see External endpoints in the journal faculty README.
- `nowledge-bridge` is deferred until enough knowledge accumulates, then will be planned as a faculty command rather than another resident tool.
- Manifest `flows[]` and action `mode: "flow"` have been removed. Tools implement multistep flows themselves using the `sdk/` runner, triggered through ordinary actions. Historical rationale and real-application acceptance records remain in the maintainer's local Plan handoff documents, not in the public package.

## butler preset (M2)

The plugin bundle patch (`cordis.patch.yml`) declares the restricted `butler` preset. Only this preset mounts the `dsh-butler/agent` sub-export (`dsh/agent.js` → built `dsh/agent-host.js`); its distillation and legacy compatibility tools are visible only in butler sessions. The root consumer independently registers `butler_search/read/report_session`, so ordinary sessions do not need the Butler persona:

| Tool | Underlying command |
| --- | --- |
| `butler_journal_read` | `distill --json` (read-only; observations only, excluding Git commits and session turns) |
| `butler_distill_advance` | `distill --advance` |
| `butler_candidate` | `memory candidate-mark` (only marks a recommendation to promote) |

- The preset otherwise contains only `dsh-persona`, read-only `dsh-tool-fs-search`, and `dsh-tool-ask-user`. It excludes bash, `dsh-tool-fs` (which includes writes), web, delegation, and cordis editing.
- There are no tools for writing cards or editing profiles. The model can only mark observations as recommended for promotion; the owner confirms promotion on the memory page (Host confirmation command).
- Tool parameters are checked against the declared allowlist; validation failure does not start a subprocess. Commands run through DSH's `subprocess` integration.
- On each tool call, the agent side reads the working directory published by the Host (in-process `Symbol.for('myspace-butler.workdir')`). It neither initializes an instance nor falls back to `~/.dsh/butler`; tools fail immediately if the Host is not mounted.
- The agent side registers an agent-scoped `tools.guard`, allowing only `butler_*`, glob, grep, and ask_user_question. Host-level tools for teams, scheduling, memory writes, and similar operations are rejected. It does not use `tools.restrict`, because preset tools are registered at ancestor levels and restrict would hide them too (verified on the real application).
- The preset locks on the session's first turn: choose Butler when creating a session or switch in an empty session.

### Automation tasks (registered by the plugin)

“Automation tasks → Register” on the briefing page calls Host `POST /automations`, registering one cron task (distillation) in DSH automation with time zone `Asia/Shanghai`, and removing retired daily/weekly report and weekly-check tasks. Task definitions and prompts are authoritative in `src/host/automations.ts` and maintained with the plugin version.

| Title | Schedule | Action |
| --- | --- | --- |
| 蒸馏 · Butler | Every hour, on the hour | `butler_distill_claim` → search approved cards → `butler_candidate_submit` complete candidates → `butler_distill_complete` acknowledge coverage |

Updated definitions replace actual tasks only upon re-registration; editing source does not automatically modify installed tasks. Tool declarations define the full parameters. Zero candidates require an explanation; failed processing must not acknowledge coverage.

- DSH tasks bind to sessions and deliver their prompts there when due. Tasks run in a newly created `butler`-preset session rooted at the instance directory, attached to the Butler workspace through `workspaceRegistry` (`session.create` with only `cwd` produces an orphan session belonging to no workspace). Existing orphan task sessions are attached during registration; if the service is unavailable, creation falls back to the directory. Thus only butler_* tools are available. DSH automatically compacts long sessions.
- Registration is idempotent by title: unchanged content is retained; changed prompts or schedules cause deletion and recreation. Tasks without the `· Butler` suffix are untouched. Repeated clicks are safe.
- Daily reports, weekly reports, and weekly checks are retired. “Recent activity” on the briefing page provides the same facts live, without another written report. Registration removes installed legacy tasks by their old titles (`日报/周报/周检 · Butler`); existing reports in `self/digests/` are preserved unchanged.
- `schedule`/`sessionController` are optional App services. The Host obtains them per request through `ctx.get`, not `inject`, because cordis treats every injected service as required. Without `dsh-experimental-schedule-bundle`, the route returns 503 while other Butler features continue working.
