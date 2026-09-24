# Rex

<img src="assets/rex.jpg" alt="Rex" width="360">

**A coding agent cannot diagnose the habit it is currently inside.**

Rex is a therapist for a coding agent. He reads a metrics digest of a working session and
names the habit that cost you the most time, attention or clarity — then recommends the
smallest useful correction. He treats *how* the agent works, not what it builds.

He runs on a different model from the agent he is diagnosing, and that is the entire design.
An agent asked to review its own session reviews its own summary of that session. Rex reads
the evidence instead.

Companion to [sheldon-debbie](https://github.com/sempervire/sheldon-debbie) and
[radar](https://github.com/sempervire/radar). Sheldon rules on what is true. Debbie
rules on what is worth doing. Radar decides what to do next. Rex looks after the agent doing
it.

## What he diagnoses

- **Bloat** — output that grew without the reader gaining anything.
- **Rabbit holes** — a detour that stopped serving the requested outcome.
- **Avoidable interruptions** — stopping to ask what could have been decided, or prepared
  before asking. Ranked hardest, because your attention is the scarcest thing in the system.
- **Poor consolidation** — three separate asks that should have arrived as one.
- **Reassurance-seeking** — checking in where authorization already existed.
- **Agent-to-agent friction** — consults sent without evidence, advisors spawned twice,
  findings requested and then ignored.

A healthy session gets no intervention. That is a first-class result, not a failed consult.

## Install

```sh
./scripts/install.sh
```

That installs the Codex agent into `~/.codex/agents/` and the Claude slash command into
`~/.claude/commands/`. Override the destinations:

```sh
CODEX_HOME=/path/to/.codex CLAUDE_HOME=/path/to/.claude ./scripts/install.sh
```

The scripts stay in this repo and run from here. They need Node 18+ and no dependencies.

## Files

```text
codex/agents/
  rex.toml              persona, judgment, output contract

claude/commands/
  rex.md                how Rex is reached, and what goes on the wire

scripts/
  session-digest.mjs    session transcript -> metrics-only digest
  rex-consult.sh        build the prompt and call codex exec
  log-intervention.mjs  append one row to Rex's memory
  usage-accounting.mjs  local transcript usage and pricing
  report-query.mjs      natural-language query and follow-up context
  report-assessment.mjs evidence-bound comparisons and findings
  report-content.mjs    explicit opt-in repeated-question scan
  report-view.mjs       shared browser and terminal report model
  report-browser.mjs    browser delivery and terminal fallback
  report-runner.mjs     on-demand report orchestration
  rex-report.mjs        command-line report entry point
  rex-report.sh         report flow with read-only Rex judgment
  rex-report-judge.sh   evidence prompt and Codex invocation
```

There is no `claude/agents/rex.md`, deliberately. Rex is not a subagent of the model he
diagnoses.

## Usage

```sh
# 1. Digest the session (--current resolves this session's transcript)
node scripts/session-digest.mjs --current -o /tmp/rex-digest.md

# 2. Consult him
scripts/rex-consult.sh /tmp/rex-digest.md "why did that take two hours?"

# 3. Log what he said
node scripts/log-intervention.mjs --session <id> \
  --finding "..." --advice "..." --acted yes
```

For a cross-session report, give Rex a natural-language request:

```sh
node scripts/rex-report.mjs "Show all my usage across every project for the last month"
node scripts/rex-report.mjs "only ShareView"
node scripts/rex-report.mjs "show the sessions behind that finding"
node scripts/rex-report.mjs "Show Rex source inventory since installed"
```

The on-demand runner opens a private browser report. Its context file carries follow-up
scope; `--context <path>` can select a separate conversation. If an integrated terminal
report UI is unavailable, an explicit terminal request opens the browser and says why.
The report contains measured totals, a priced lower bound when the full cost is unknown,
the supported source and coverage gaps, comparisons, measured behavior signals and
intervention follow-through. Daily groups use UTC; relative calendar dates use the local
timezone shown in the report. An explicit request for transcript content analysis opts in
to that mode; without supplied attributable evidence it reports insufficient evidence,
and ordinary reports contain no transcript text. The runner does not infer actual billed
spending from API-equivalent rates or human work time from session elapsed time.
For behavior, comparison, and intervention requests through `/rex`, the installed command
uses `scripts/rex-report.sh` to prepare a private structured evidence file, consult Rex via
read-only Codex, validate his cited sessions, and then deliver the browser report. If the
Codex call is unavailable, the measured report still opens and says judgment was unavailable.
The direct Node command above delivers deterministic metrics without a model consult.
The source inventory request uses the same browser report path. It discovers available
Claude, Codex, Rex installation, ShareView memory, and live claim sources; labels events
and snapshots; and shows each source's rows, coverage gaps, and limits. Its selected
installation milestone is shown with candidate dates because file mtimes are imperfect
evidence. Claude and Codex token counts retain their separate provider conventions and
are never added into a cross-provider total. The report omits prompt text, settings
values, and secret grant content.

`codex exec` has no `--agent` flag and does not read `~/.codex/agents/`, so `rex-consult.sh`
extracts the persona from `rex.toml` and puts it in the prompt. The installed `rex.toml` is
for interactive Codex clients that expose custom agents; editing it changes Rex either way.
`claude/commands/rex.md` carries the rest, including the three rules that are easy to get
wrong: a quoted heredoc rather than command-line interpolation, `< /dev/null` or it hangs
forever, and an `mktemp` answer file so a failed run cannot serve the previous answer.

## How consults are passed

Rex is handed the situation as evidence, not as a persuasive summary — the same three-part
payload the sheldon-debbie agents use:

1. **The user's message, verbatim**, in a fenced block, so Rex can tell what was actually
   asked from how the calling agent framed it.
2. **Sources by address.** Paths to the digest and the intervention log. Named, never
   summarized — handing Rex a summary of the evidence hands him the session's own framing of
   its behavior, which is the one thing he exists to see past.
3. **The caller's account.** Only what no readable source contains, in four lines or fewer.

## The digest

`session-digest.mjs` reads one Claude Code transcript and emits **metrics only** — no prompt
text, no assistant prose, no tool arguments, no file contents. Transcripts hold everything a
session touched; a digest that quoted them would be a liability and would also defeat the
purpose.

It reports session shape (turns, tool calls, questions put to the human, interruptions),
output volume (median and maximum prose length), detour indicators, the split between agent
work and human waiting, the tool mix, and — the part that makes a diagnosis possible — **run
shape**: the longest stretches of acting without deciding, run-length encoded as the tools
that ran, the files they touched and the shell verbs they invoked, each marked with whether
it ended in a write.

That last part exists because the first calibration run failed without it. Given counters
alone, Rex correctly refused to diagnose a 106-call run: the numbers could not separate
productive execution from a detour, and he would not guess. A run that ends in an edit and
one that produces nothing are the same count and different behavior.

**A pause is not one thing.** Tool waiting, a necessary human decision, an avoidable
interruption and a detour all produce elapsed time, and only two of them are a problem.
Elapsed time alone does not measure human effort, and the digest says so in its own body so
the distinction reaches Rex every time.

## Usage accounting foundation

```sh
node scripts/usage-report.mjs --from 2026-09-01 --to 2026-10-01
node scripts/usage-report.mjs --requests
```

The report scans local Claude Code transcripts across projects, resumed sessions, and
subagents. Dates use UTC; `--to` is exclusive. It returns JSON totals and breakdowns by
day, model, project, and session. `--requests` includes individual request records for
future report queries. No prompt, tool argument, or assistant text enters the report.

Token totals are deduplicated by API request ID. `apiEquivalentUsd` applies the dated
first-party Claude API rate snapshot listed in the report; it is not a Claude subscription
charge or an invoice. If pricing or source coverage is incomplete, that total is `null`
and `knownApiEquivalentUsd` is only the priced lower bound. The `coverage` field states
what was missing. The browser report builds on this accounting data.

## The intervention log

Rex cold-starts on every consult and remembers nothing. `interventions.jsonl` — at
`$XDG_DATA_HOME/rex/`, or `~/.local/share/rex/`, or wherever `REX_LOG` points — is his
memory. One row per consult records what he found, what he advised, and whether it was
acted on; a separate row records each decision.

A finding can carry `habit`, a stable lowercase slug Rex reuses for the same behavior.
It can also carry `--metric interruptionsPer100HumanTurns` when that measurable rate is the
finding's actual basis; later intervention reports can compare it before and after while
keeping causation unknown. Older rows without a metric remain valid and yield unknown later
evidence.
Older rows without it remain readable but do not count as sightings. On a second keyed
sighting without a decision, Rex asks Dave once whether to make a stated one-line rule or
drop the habit; the caller logs that exact question as `advice`. An unanswered question is
repeated verbatim. A separate row with `--habit <slug> --decision rule|drop` records Dave's
answer; `--rule` can hold the rule text or its location. A dropped habit is omitted on later
consults, and a recurrence after `rule` is reported in one line without fresh counsel.

Log healthy or declined findings with `--finding none` and no habit, so they never trigger
the question. A log holding only bad sessions cannot show whether Rex is right about the
good ones. Rex remains read-only; the calling session writes the log and carries a chosen
rule into the project's own process.

## Read-only, always

Rex has no write path anywhere. He runs under `codex exec --sandbox read-only`, he does not
edit files, and he does not file issues — including the issues he recommends. When he finds
something worth building, he offers a plan and offers to have it executed; carrying that
forward is the calling session's job, under your project's own process and your judgment.

This is the same boundary Sheldon, Debbie and Radar hold. An advisor that can act on its own
findings is not an advisor.

## History

Two earlier versions of Rex existed: a persistent Codex session behind a Python wrapper, and
an MCP integration with issue-filing rights and its own GitHub identity. Neither lasted.
The wrapper accumulated more machinery than judgment, and its telemetry recorded Rex's own
runtime rather than anything about the engineer's attention.

This version remains on demand, with no service running between consults or reports. The
scripts have no runtime dependencies. The earlier tree is tagged `v2-archive`.

## Issues

Issues for Rex are filed in [sempervire/dev-tools](https://github.com/sempervire/dev-tools/issues),
with a `Repo: rex` line in the body.

## License

MIT. See [LICENSE](LICENSE).
