---
description: Consult Rex, the therapist for how this session is working, running on Codex
---

# /rex

Use `/rex` for either a session consult or an on-demand report. A report request asks for
usage, cost, history, comparisons, behavior patterns, interventions, or a report follow-up.
Pass the user's natural-language request verbatim to the report runner. A consult asks how
the current session is *working*: `/rex why did this take so long?`. With no argument,
prepare the current-session digest and consult him.

`codex/agents/rex.toml` owns his judgment and output format. This file owns how he is
reached, what goes on the wire, and how the answer comes back.

## Report requests and follow-ups

For a report request, write the user's exact words to a private temporary request file using
the host's file-writing tool, then run `scripts/rex-report.sh <path>`.
Do not interpolate the request into shell code. The runner remembers the last report's query
in a private context file, so follow-ups such as “only ShareView,” “compare that with the
previous month,” and “show the sessions behind that finding” retain scope.

The command prepares private structured evidence. For behavior, comparison, and intervention
requests, it asks Rex through read-only `codex exec` to judge that evidence and validates
his session references before adding the judgment to the report. If the host cannot launch
Codex, it delivers the measured report and clearly says judgment was unavailable. The
prepared evidence never includes raw transcript text; an explicit content-analysis request
allows Rex to read selected local transcript sources. The command opens a private HTML
report in the browser. A terminal preference falls back to
the browser because this host does not expose an integrated terminal report UI. Relay only
the report URL or launch confirmation and any limitation printed by the runner; do not paste
the full report into chat. If the runner asks for clarification, ask the user that question
and then pass the answer with the prior context. Do not silently replace an unsupported
request with a narrower usage query.

The built-in resolver handles common time and follow-up language. For other clear phrasing,
you may resolve the user's words into a structured query JSON file and pass
`--query-file <path>` alongside `--request-file` when invoking the underlying Node runner.
The fields are `kind` (`usage`,
`behavior`, `comparison`, `intervention`, `sessions`), `period` and `comparePeriod` as
inclusive ISO `from` and exclusive ISO `to`, `projects` as available encoded directory
keys, `models` as exact model IDs, `surface` (`browser` or `terminal`), and optional
`currentSession`, `findingId`, `contentAnalysis`, and `timeZone`. Omit filters the user did
not ask for. The runner validates source keys and requires explicit content opt-in in the
verbatim request. Show the interpreted scope in the report and ask only when a material
ambiguity remains. Never silently narrow a broad request to the subset the resolver knows.

The report shows source and coverage, UTC daily buckets and the calendar timezone used to
resolve relative dates, metered request totals, token and API-equivalent cost assumptions,
unknown values, comparisons, findings, and supporting sessions. It never presents API
equivalent estimates as actual spending. Content analysis needs an explicit request; the
ordinary path reads metrics and does not expose transcript text. If no supported semantic
evidence is available, the report says so.

The report runner may write report artifacts and its context file. It does not change any
source project. The ordinary consult path below remains read-only.

## Rex runs on Codex, and that is the point

He is not a subagent of the model he is diagnosing. A coding agent cannot see the habit it is
currently inside, so Rex runs on a different model, reading evidence rather than memory.

Reach him with the repo's own script, which builds the prompt and calls `codex exec`:

```sh
scripts/rex-consult.sh /tmp/rex-digest.md "why did that take two hours?"
```

**`codex exec` has no `--agent` flag and does not read `~/.codex/agents/`.** The installed
`rex.toml` is there for interactive Codex clients that expose custom agents; for the CLI the
script extracts `developer_instructions` from it and puts the persona in the prompt. Editing
`rex.toml` is what changes Rex either way.

The script handles the four things that are easy to get wrong, and any hand-rolled call must
handle them too:

- **Never interpolate the argument into the command line.** A quoted heredoc to a file, then
  `"$(cat "$PROMPT")"`. Backticks and `$(...)` in a user's message execute otherwise.
- **`< /dev/null` on every invocation.** Without it `codex exec` inherits a non-TTY stdin,
  decides more prompt is coming, and waits forever at 0% CPU without ever erroring.
- **`mktemp` the answer file and check the exit code.** A failed run exits non-zero without
  writing `-o`, so a fixed path serves the previous consult's answer as this one's.
- **`--sandbox read-only`, always.** Rex has no write path anywhere, by design.

## Build the digest first

Rex reads metrics, never the transcript. Produce the digest before the consult:

```sh
node scripts/session-digest.mjs --current -o /tmp/rex-digest.md
```

`--current` resolves this session's own transcript: exactly, from `CLAUDE_CODE_SESSION_ID`,
falling back to the newest transcript for this working directory. Pass a path instead to
digest a different session. Do not reimplement the path encoding at the call site.

**If the digest cannot be produced, stop and say so.** Do not consult Rex on a session he has
no evidence for; he will tell you the same thing, one round trip later.

## What goes on the wire

Three labelled sections, in this order. The labels let Rex weigh whose words are whose.

### 1. The message, verbatim

The user's words, unaltered — no summarizing, sharpening, or fixing spelling:

The user typed this, verbatim:

````
$ARGUMENTS
````

With no argument, say so and let the digest be the question.

When Claude requested the consult rather than the user, the header is `Claude is asking:`
instead. Never put our own framing under the user's name.

### 2. Sources — addresses, never summaries

    Sources — read these yourself:
    - /tmp/rex-digest.md
    - ~/.local/share/rex/interventions.jsonl

Name paths. Do not characterize what is in them, and do not paste their contents: handing Rex
a summary of the evidence hands him this session's framing of its own behavior, which is the
one thing he exists to see past.

### 3. Claude's account — only what is in no readable source

    Claude's account — our words, not the user's:
    - <what the session was trying to do>
    - <any constraint the digest cannot show>

**At most four lines.** Not our confidence, not our preferred diagnosis, never a précis of
the digest.

## Relaying him back

**His answer must appear in the main conversation thread.** Running the command is not
completion. After `codex exec` returns, emit one response whose body begins with his returned
text, unaltered, header line and all.

- **Paste the block unaltered, including a question for Dave.** A paraphrase is a failed
  consult. Do not answer the question on Dave's behalf.
- **After his block: nothing**, except a factual correction in at most two sentences.
- **The answer prints twice**; the block after `tokens used` is the final one.
- **A healthy verdict is a real result.** When Rex says there is nothing to treat, relay that
  and move on. Do not go looking for a second opinion that flatters the consult.

## Then log it

Every consult appends one row. This is Rex's only memory — he cold-starts and will not recall
this conversation next time:

```sh
node scripts/log-intervention.mjs \
  --session <session-id> \
  --finding "<his diagnosis, one line>" \
  --habit "<his slug>" \
  --advice "<his correction or exact question>" \
  --acted <yes|no|partial>
```

Omit `--habit` when Rex names none. Log healthy verdicts with `--finding none` and no
habit. A finding the caller declines is likewise logged as `none`, so it cannot become a
sighting. For a question, keep
Rex's exact wording in `--advice`; that row lets him repeat it verbatim if unanswered.
For a finding specifically measured by interruptions per 100 human turns, add
`--metric interruptionsPer100HumanTurns`; this lets a later report compare periods. Do not
attach that metric to a different habit or infer that a before/after change was caused by
the intervention.

When Dave answers yes or no, the calling session appends a separate decision row:

```sh
node scripts/log-intervention.mjs --habit <slug> --decision rule \
  --rule "<the one-line rule or where it lives>"
# Or, for no:
node scripts/log-intervention.mjs --habit <slug> --decision drop
```

The calling session carries a `rule` answer into the project's own process. Dave writes any
permission grant himself. Record no inferred answer, and do not let Rex modify the project.

Rex is advisory. He does not edit files, file issues, change project state, or carry work
forward. If he recommends something worth doing, that goes through this project's own process
under the calling session's judgment.
