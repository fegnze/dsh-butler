# Journal faculty

This built-in faculty writes observations to `self/spool/`, merges them into `self/journal/`, and reports work-directory health. Add endpoint drivers in the work directory when integrating an external agent.

## Distill and candidates

Distill never writes a card. It hands the model the observation records after the cursor, and the model may mark the few worth keeping as **candidates**; the owner decides on the memory page. Marking nothing is the normal outcome.

```
distill [--limit N] [--max-chars M] [--json]     # observation records after the cursor (read-only), each with its `key`
distill --advance <to>                           # move the cursor once the batch is dealt with
memory candidate-mark <key> --to knowledge|rule|profile --reason <line>   # suggest promoting one observation record
memory candidate-dismiss <key>                   # the owner: not worth keeping; distill never marks it again
```

- Distill reads **observations only**. Commit records and session turns are lookup categories (Git and session record cards) and are never offered; `candidate-mark` refuses them. The cursor still moves past them.
- `self/candidates.jsonl` is append-only, one event per line (`mark`, `dismiss`, `promote`); the last event per record wins. A record with any event is not shown to distill again, so a dismissed record is never re-marked. Promoting a record (`card-create --origin`, `profile-append --origin`) writes `promote`, which closes its suggestion.
- Butler's own `memory` decisions are not handed back to distill: they are the consequence of a promotion, not new information.
- The daily, weekly and audit reports are retired. The briefing page shows the same facts live, old files in `digests/` stay as they are, and the DSH automation tasks that wrote them are removed when the plugin registers its tasks.

## Legacy proposals and reports

Nothing creates proposals any more and the briefing page no longer lists them. The scripts remain for the proposals already in `self/proposals.jsonl` and for the old digests; a leftover pending proposal is decided from the command line. The tools above that read `distill` do not use them.

```
proposals add --kind rule|knowledge|persona|fact|noise --title <t> [--slug <s>] [--find <text>] [--summary <line>] [--evidence <ref>]...   # body on stdin
proposals list [--status pending|applied|rejected] [--json]
proposals apply <id> --confirmed
proposals reject <id> [--reason <why>]           # one click; a reason is optional
report gather daily|weekly|audit [--json]        # journal window, pending proposals, spool backlog
report write daily|weekly|audit [--date YYYY-MM-DD]   # body on stdin → digests/ and outbox/
```

- `self/proposals.jsonl` is append-only: one `create` event plus later `status` events, folded by id. Corrupt lines are kept and counted, never dropped.
- `apply` is the only writer of `rules/`, `knowledge/` and `persona/`:
  - `rule` and `knowledge` are cards: one file each, `rules/<slug>.md` or `knowledge/<slug>.md`. Without `--find` the proposal creates the card (front matter `title`, `summary`, `proposal`, `approvedAt`, then the body) and refuses to overwrite. With `--find` it replaces that text once inside the existing card.
  - A rule card is a working rule the owner approved. It is not a hard constraint: root rule files such as `AGENTS.md` still win on conflict.
  - `persona` replaces the single occurrence of `--find` in `profile.md`.
  - Zero or several `--find` matches fail with no writes and the proposal stays pending. Legacy `iron` proposals can no longer be applied.
  - `fact` appends a journal fact. `noise` only closes the proposal.
  - Every apply appends a journal `decision` with `ref: proposal://<id>`.
- The cursor (`self/etc/cursor.json` `distill`) never moves backwards or past the journal. If `--advance` is skipped, the next run re-reads the same batch.
## Context compilation and injection

```
build-context [--max-chars N] [--json]   # self/build/context.md = profile + one index line per card
card [all|profile|rule/<slug>|knowledge/<slug>]   # all = compiled context.md; a card id prints that card
card --list [--json]                     # the full index: id, title, summary
migrate-rules [--slugs a,b,...] [--json] # one-off: split a legacy persona/iron-card.md into rule cards
```

- Card bodies never enter the context. Each index line is `` `id` title — summary ``: rules first in approval order, then knowledge newest first. The profile is never cut; overflow is stated as a count. Agents read a card in full with `card <id>`, or `butler_card` in a Butler session.
- `migrate-rules` turns each numbered item `N. **title**: body` into one card, keeping the original text. It validates every slug first, then deletes the legacy file, journals a `decision` and rebuilds. `doctor` warns while a legacy file remains.
- `run` and a successful `apply` rebuild it. A rebuild failure only warns; the decision stays recorded.
- Host injects `context.md` once per DSH session through `agent/pre-step`, as a plugin snapshot message. Root `butler.json` `inject` controls it: `enabled` (default true), `workspaces` (empty = all), `excludePresets` (default `["butler"]`, which reads its own persona), `includeSubagents` (default false), `maxChars`.

- Host exposes `apply`/`reject` as confirmed faculty commands whose `id`/`reason` are the only accepted `args` (the briefing page no longer lists proposals; it used to): approve asks for confirmation because it writes a card; reject is one click with no reason. Distilled cards should be few and good, so rejecting must stay cheaper than approving; a wrongly rejected item comes back at the next distill.

## External endpoints

`bin/install` manages four endpoints, each idempotent:

| id | What Butler owns |
| --- | --- |
| `claude` | `<!-- butler:begin v4 -->` block in `~/.claude/CLAUDE.md`, one `hooks.Stop` entry in `~/.claude/settings.json` |
| `codex` | the same block in `~/.codex/AGENTS.md`, one `hooks.Stop` entry in `~/.codex/hooks.json` |
| `workbuddy` | `~/.workbuddy/skills/butler-port/SKILL.md` (removed only if its sha256 still matches) |
| `git` | `# butler:begin/end` block in `post-commit` of each repo in `butler.json` `endpoints.git.repos` (resolved with `git rev-parse --git-path hooks`) |

```
install --list [--json]
install --target <id> [--check|--uninstall] [--json]   # exit 0 ok, 1 failed, 2 usage
```

- Every target file is planned in memory first; malformed markers, unparsable hook JSON or a foreign `SKILL.md` abort with zero writes.
- Writes are atomic, keep file mode, follow symlinks and back up to `<instance>/.state/endpoint-backups/`; a mid-way failure rolls back.
- Hook JSON is edited in place, so other keys keep their exact bytes and uninstall restores the original text.
- Stop hooks call `bin/hook-intake --source <id>`, which reads the host hook JSON (`transcript_path`, `session_id`, `cwd`) and records one `session` observation; `--git` records the HEAD commit as `git://<repo>@<sha>`.
- Paths can be overridden per endpoint under `butler.json` `endpoints.<id>`. Commands embed absolute paths, so moving the instance requires a reinstall.
- `bin/doctor` prints `[PASS|WARN|FAIL|INFO] 端点 <id> …` per endpoint; WARN means a legacy install, FAIL exits 1. It never crashes on a malformed registry.

## Memory management

The Butler page's memory tab is the owner writing to `rules/`, `knowledge/` and `persona/` directly, as the other legal writer beside `proposals apply`. Bodies go through stdin, so they may be multi-line.

```
memory card-create <rule|knowledge>/<slug> --title <t> [--summary <line>] [--origin <record>]   # body on stdin; refuses to overwrite
memory card-update <rule|knowledge>/<slug> --title <t> [--summary <line>]   # whole card replaced; proposal/approvedAt/origin kept
memory card-delete <rule|knowledge>/<slug>                                  # moved to self/trash/, never unlinked
memory card-order  <rule|knowledge>                                         # slugs on stdin, one per line: the owner's drag order
memory profile-set                                                          # whole identity card on stdin
memory profile-append [--origin <record>]                                   # one line on stdin, appended under the journal lock
```

## From record to card

```
record  ->  record card  ->  knowledge card | rule card | identity card
```

- A **record** is one journal line; the page shows it as a **record card**. Record cards are read-only and come only from collection or the page's "record an observation". The page splits them by what they are, not where they are stored: observations (promotable), Git records (`source: git` or tag `git-commit`; a commit already is the authoritative record of itself) and session records (`type: session`; a turn-end marker). The last two are for lookup only.
- Knowledge, rule and identity cards can also be written and deleted by hand. A record card cannot.
- **Promotion** is `card-create --origin` (or `profile-append --origin`) with the record's handle `journal:<ts>:<source>`; a second record in the same second from the same source is `…#1`, `…#2` in file order, and an append-only journal never renumbers them. A card keeps `origin:` in its front matter; the identity card is one file, so its origin is carried by the journalled `decision` instead. The page marks a promoted record with where it went. Nothing is promoted automatically.
- `card-order` stores the owner's order in `etc/card-order.json` (slugs only; a missing or damaged file means "never reordered"). It is read both by the page and by the injected card index, so the order the owner sees is the order agents get. Cards never placed follow the placed ones in their old order. Reordering is not a decision, so it is not journalled.

- Every write except `card-order` appends a journal `decision` tagged `memory` and rebuilds `context.md`. An identity card that makes the context exceed its limit is rolled back as a whole.
- The journal itself stays append-only through `intake` and `run`; the page can add an observation (it lands in the spool) but not edit the ledger.
- Manifest args may set `stdin: true`: the value is written to the child's stdin instead of argv, validated by its `pattern` like any other arg.
