---
description: Consult Rex, the therapist for how this session is working, running on Codex
---

# /rex

Consult Rex on how this session is *working* — not on whether the code is right. With an
argument, aim him at it: `/rex why did this take so long?`. With none, hand him the current
session's digest and let him find the habit.

`codex/agents/rex.toml` owns his judgment and output format. This file owns how he is
reached, what goes on the wire, and how the answer comes back.

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
node scripts/session-digest.mjs <path-to-session.jsonl> -o /tmp/rex-digest.md
```

Claude Code keeps transcripts under `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`,
where both `/` and `.` encode as `-`. Digest the session under discussion — usually the
current one.

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

- **Paste the block unaltered.** A paraphrase is a failed consult.
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
  --advice "<the correction he recommended>" \
  --acted <yes|no|partial>
```

Log the healthy verdicts too, with `--finding none`. A log holding only the sessions that went
badly cannot tell anyone whether Rex is right about the ones that went well.

Rex is advisory. He does not edit files, file issues, change project state, or carry work
forward. If he recommends something worth doing, that goes through this project's own process
under the calling session's judgment.
