# Rex

<img src="assets/rex.jpg" alt="Rex" width="360">

**A coding agent cannot diagnose the habit it is currently inside.**

Rex is a therapist for a coding agent. He reads a metrics digest of a working session and
names the habit that cost you the most time, attention or clarity — then recommends the
smallest useful correction. He treats *how* the agent works, not what it builds.

He runs on a different model from the agent he is diagnosing, and that is the entire design.
An agent asked to review its own session reviews its own summary of that session. Rex reads
the evidence instead.

Companion to [sheldon-debbie](https://github.com/davehecker-main/sheldon-debbie) and
[radar](https://github.com/davehecker-main/radar). Sheldon rules on what is true. Debbie
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

The two scripts stay in this repo and run from here. They need Node 18+ and no dependencies.

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
```

There is no `claude/agents/rex.md`, deliberately. Rex is not a subagent of the model he
diagnoses.

## Usage

```sh
# 1. Digest the session
node scripts/session-digest.mjs ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl \
  -o /tmp/rex-digest.md

# 2. Consult him
scripts/rex-consult.sh /tmp/rex-digest.md "why did that take two hours?"

# 3. Log what he said
node scripts/log-intervention.mjs --session <id> \
  --finding "..." --advice "..." --acted yes
```

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
output volume (median and maximum prose length), detour indicators (the longest run of tool
calls with no decision between them, and repeated shell commands), the split between agent
work and human waiting, and the tool mix.

**A pause is not one thing.** Tool waiting, a necessary human decision, an avoidable
interruption and a detour all produce elapsed time, and only two of them are a problem.
Elapsed time alone does not measure human effort, and the digest says so in its own body so
the distinction reaches Rex every time.

## The intervention log

Rex cold-starts on every consult and remembers nothing. `interventions.jsonl` — at
`$XDG_DATA_HOME/rex/`, or `~/.local/share/rex/`, or wherever `REX_LOG` points — is his
memory. One row per consult: what he found, what he advised, whether it was acted on.

This is what makes "the same habit, again" visible. A repeat finding that never got acted on
is the most useful thing in the log, and Rex is instructed to say so when he sees one.

Log the healthy verdicts too, with `--finding none`. A log holding only the sessions that
went badly cannot tell you whether Rex is right about the ones that went well.

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

This version is a definition, not a system: two files to install, two scripts with no
dependencies, and nothing running between consults. The earlier tree is tagged `v2-archive`.

## License

MIT. See [LICENSE](LICENSE).
