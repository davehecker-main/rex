#!/usr/bin/env node
// Turn one Claude Code session transcript into a digest for Rex.
//
//   node scripts/session-digest.mjs <session.jsonl> [-o digest.md]
//   node scripts/session-digest.mjs --current [-o digest.md]
//
// No prose, by design: no prompt text, no assistant messages, no file contents, no
// shell arguments, no search patterns. What it does carry is shape — which tools ran
// in what order, which files they touched, which shell verbs, and whether a long run
// produced anything. The first calibration run established why: counters alone cannot
// separate a detour from productive execution, and Rex correctly refuses to guess.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { basename, sep } from "node:path";
import { homedir } from "node:os";

const argv = process.argv.slice(2);
const outFlag = argv.indexOf("-o");
const outPath = outFlag === -1 ? null : argv[outFlag + 1];

// Claude Code keeps transcripts under ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl,
// where both "/" and "." become "-". --current resolves the newest one for this directory
// so no caller has to reimplement that encoding.
function currentSession() {
  const encoded = process.cwd().split(sep).join("-").split(".").join("-");
  const dir = `${homedir()}/.claude/projects/${encoded}`;
  let entries;
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    throw new Error(`no transcript directory for this working directory: ${dir}`);
  }
  if (entries.length === 0) throw new Error(`no transcripts in ${dir}`);

  // CLAUDE_CODE_SESSION_ID names the session exactly. Fall back to the newest transcript,
  // which is a guess: several sessions can share one working directory, and the newest
  // file belongs to whichever of them wrote last, not necessarily to the caller.
  const id = process.env.CLAUDE_CODE_SESSION_ID;
  if (id && entries.includes(`${id}.jsonl`)) return `${dir}/${id}.jsonl`;
  return entries
    .map((f) => ({ f: `${dir}/${f}`, t: statSync(`${dir}/${f}`).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0].f;
}

let inPath;
if (argv.includes("--current")) {
  try {
    inPath = currentSession();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
} else {
  inPath = outFlag === -1 ? argv[0] : argv.find((a, i) => i !== outFlag && i !== outFlag + 1);
}

if (!inPath) {
  console.error(
    "usage: session-digest.mjs <session.jsonl> [-o digest.md]\n" +
      "       session-digest.mjs --current [-o digest.md]",
  );
  process.exit(2);
}

const rows = readFileSync(inPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

if (rows.length === 0) {
  console.error(`no parseable rows in ${inPath}`);
  process.exit(1);
}

const ts = (r) => (r.timestamp ? Date.parse(r.timestamp) : NaN);
const contentTypes = (r) =>
  Array.isArray(r.message?.content) ? r.message.content.map((c) => c.type) : [];

// A human turn is a user row whose content is a plain string. A user row carrying
// tool_result blocks is the harness returning a tool call, not a person typing.
const isHumanTurn = (r) =>
  r.type === "user" && typeof r.message?.content === "string" && !r.isMeta;

const humanTurns = rows.filter(isHumanTurn);
const assistantTurns = rows.filter((r) => r.type === "assistant");

// Tool calls, and the questions among them that stopped the session for a human.
const toolCalls = [];
for (const r of assistantTurns) {
  for (const c of r.message?.content ?? []) {
    if (c.type === "tool_use") toolCalls.push({ name: c.name, at: ts(r), input: c.input });
  }
}
const byTool = {};
for (const t of toolCalls) byTool[t.name] = (byTool[t.name] ?? 0) + 1;

const questionsToHuman = toolCalls.filter((t) => t.name === "AskUserQuestion").length;

// Assistant prose volume, as a bloat proxy. Length only; the text never leaves here.
const proseLengths = assistantTurns
  .map((r) =>
    (r.message?.content ?? [])
      .filter((c) => c.type === "text")
      .reduce((n, c) => n + (c.text?.length ?? 0), 0),
  )
  .filter((n) => n > 0);

const median = (xs) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

// Whether a shell command changed something. Read-only work dominates a session, so the
// cost of being loose here is high: a run of greps that happened to redirect stderr would
// read as productive. Hence the explicit list, and a redirect rule that ignores /dev/null,
// file descriptors (`2>`) and `>&2`.
const SHELL_MUTATES =
  /\b(git\s+(commit|push|tag|merge|rebase|reset|checkout|switch|branch|rm|mv|apply|revert|stash|clone|init|worktree)|gh\s+\w+\s+(create|edit|close|comment|merge|delete|reopen|ready|review|upload)|gh\s+api\s+(-X|--method)|npm\s+publish|mkdir\s|chmod\s|rmdir\s|rm\s|mv\s|cp\s|tee\s|sed\s+-i)|(?<![0-9&])>>?\s*(?!\/dev\/null)["'~$\w./]/;

// What a tool call touched, as shape rather than content: the file it acted on, or the
// shell verb it invoked. Never the arguments, the search pattern, or the command itself —
// a shell line carries paths, flags and sometimes secrets, and none of that helps a
// diagnosis of working habits.
function label(t) {
  const i = t.input ?? {};
  const short = (p) =>
    typeof p === "string" ? p.replace(homedir(), "~").split("/").slice(-2).join("/") : null;
  if (t.name === "Bash" && typeof i.command === "string") {
    const whole = i.command.trim();
    // A compound command labeled by its first verb lies: `sleep 30 && gh issue comment`
    // reads as a wait. Label by whichever part actually changed something, when one did.
    const parts = whole.split(/&&|\|\||;/).map((p) => p.trim()).filter(Boolean);
    const cmd = parts.find((p) => SHELL_MUTATES.test(p)) ?? parts[0] ?? whole;
    const words = cmd.split(/\s+/);
    const verb = basename(words[0] ?? "");
    // Two levels for gh, where the noun and the action are separate words and only the
    // action says whether anything changed: `gh issue view` and `gh issue edit` are not
    // the same event. One level elsewhere, where `git` alone says nothing.
    const depth = verb === "gh" ? 2 : /^(git|npm|npx|node|docker|cargo|supabase|vercel)$/.test(verb) ? 1 : 0;
    const sub = words
      .slice(1, 1 + depth)
      .map((w) => w.replace(/[^\w:-].*$/, ""))
      .filter((w) => w && !w.startsWith("-"))
      .join(" ");
    return {
      label: `Bash(${[verb || "?", sub].filter(Boolean).join(" ")})`,
      mutates: SHELL_MUTATES.test(whole),
    };
  }
  const path = short(i.file_path ?? i.path ?? i.notebook_path);
  if (path) return { label: `${t.name}(${path})`, mutates: false };
  const glob = short(i.glob ?? i.pattern_path);
  if (glob) return { label: `${t.name}(${glob})`, mutates: false };
  return { label: t.name, mutates: false };
}

// Segment the session at each assistant message that carries prose. Text is where the
// session stopped to say something — a decision point — so a segment is one stretch of
// acting without deciding. Whether a segment ends in a write is the outcome proxy: a long
// run that produced nothing looks very different from one that ended in an edit.
const segments = [];
let cur = { calls: [], startedAt: NaN };
for (const r of rows) {
  if (isHumanTurn(r)) {
    if (cur.calls.length) segments.push({ ...cur, endedBy: "human turn" });
    cur = { calls: [], startedAt: ts(r) };
    continue;
  }
  if (r.type !== "assistant") continue;
  const content = r.message?.content ?? [];
  if (content.some((c) => c.type === "text")) {
    if (cur.calls.length) segments.push({ ...cur, endedBy: "decision" });
    cur = { calls: [], startedAt: ts(r) };
  }
  for (const c of content) {
    if (c.type !== "tool_use") continue;
    if (!Number.isFinite(cur.startedAt)) cur.startedAt = ts(r);
    const l = label({ name: c.name, input: c.input });
    cur.calls.push({ name: c.name, label: l.label, mutates: l.mutates });
  }
}
if (cur.calls.length) segments.push({ ...cur, endedBy: "session end" });

// What counts as a run having produced something. Edit/Write are the obvious cases, but a
// run that ends in `git commit` or `gh api -X DELETE` produced plenty — the first version
// of this called those runs empty, and Rex caught it on the digest itself.
const WRITERS = new Set(["Edit", "Write", "NotebookEdit"]);
const produced = (c) => WRITERS.has(c.name) || c.mutates;
for (const s of segments) {
  s.wrote = s.calls.some(produced);
  s.lastWrite = [...s.calls].reverse().find(produced)?.label ?? null;
}

const longestSilentRun = segments.reduce((n, s) => Math.max(n, s.calls.length), 0);

// Run-length encode a segment so a 40-call stretch reads as a shape rather than a list.
const encode = (calls) => {
  const out = [];
  for (const c of calls) {
    const last = out[out.length - 1];
    if (last && last.label === c.label) last.n += 1;
    else out.push({ label: c.label, n: 1 });
  }
  return out.map((e) => (e.n > 1 ? `${e.label}×${e.n}` : e.label)).join(" → ");
};

const longRuns = [...segments]
  .map((s, i) => ({ ...s, i }))
  .filter((s) => s.calls.length >= 8)
  .sort((a, b) => b.calls.length - a.calls.length)
  .slice(0, 5)
  .sort((a, b) => a.i - b.i);

// Which files the session kept coming back to. Convergence on one file and a scatter
// across twenty are the same call count and completely different behavior.
const pathCounts = {};
for (const s of segments)
  for (const c of s.calls) {
    const m = /^(?:Read|Edit|Write|NotebookEdit|Glob|Grep)\((.+)\)$/.exec(c.label);
    if (m) pathCounts[m[1]] = (pathCounts[m[1]] ?? 0) + 1;
  }

const verbCounts = {};
for (const s of segments)
  for (const c of s.calls) {
    const m = /^Bash\((.+)\)$/.exec(c.label);
    if (m) verbCounts[m[1]] = (verbCounts[m[1]] ?? 0) + 1;
  }

const topTable = (counts, header, limit = 15) => {
  const rowsOut = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k, n]) => `| ${k} | ${n} |`);
  return rowsOut.length ? `| ${header} | Calls |\n|---|---|\n${rowsOut.join("\n")}` : null;
};

// Repeated Bash commands: the same command run more than once is either a retry loop
// or a fact the session failed to keep hold of.
const bashCommands = toolCalls
  .filter((t) => t.name === "Bash" && typeof t.input?.command === "string")
  .map((t) => t.input.command.trim());
const bashCounts = {};
for (const c of bashCommands) bashCounts[c] = (bashCounts[c] ?? 0) + 1;
const repeatedBash = Object.values(bashCounts).filter((n) => n > 1).length;

// Time split. Human latency is the gap from the last event before a human turn to that
// turn: the session was idle, waiting on a person. Everything else is the agent working.
const ordered = rows.filter((r) => Number.isFinite(ts(r))).sort((a, b) => ts(a) - ts(b));
let humanWaitMs = 0;
for (let i = 1; i < ordered.length; i++) {
  if (isHumanTurn(ordered[i])) humanWaitMs += ts(ordered[i]) - ts(ordered[i - 1]);
}
const spanMs =
  ordered.length > 1 ? ts(ordered[ordered.length - 1]) - ts(ordered[0]) : 0;

const interrupts = rows.filter((r) => {
  const c = r.message?.content;
  const s = typeof c === "string" ? c : "";
  return /\[Request interrupted/i.test(s);
}).length;

const mins = (ms) => Math.round(ms / 60000);

const toolLines =
  Object.entries(byTool)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `| ${name} | ${n} |`)
    .join("\n") || "| — | 0 |";

const runBlocks =
  longRuns
    .map(
      (s) =>
        `**${s.calls.length} calls, ended by ${s.endedBy}, ${
          s.wrote ? `produced: ${s.lastWrite}` : "produced nothing"
        }**\n\n\`\`\`\n${encode(s.calls)}\n\`\`\``,
    )
    .join("\n\n") || "_No run reached 8 calls without a decision between them._";

const digest = `# Session digest — ${basename(inPath)}

No transcript text: no prompts, no assistant messages, no file contents, no shell
arguments, no search patterns. Tool names, the files they touched, and shell verbs only.

## Shape

| Measure | Value |
|---|---|
| Human turns | ${humanTurns.length} |
| Assistant turns | ${assistantTurns.length} |
| Tool calls | ${toolCalls.length} |
| Tool calls per human turn | ${humanTurns.length ? (toolCalls.length / humanTurns.length).toFixed(1) : "—"} |
| Questions put to the human | ${questionsToHuman} |
| Interruptions by the human | ${interrupts} |

## Output volume

| Measure | Value |
|---|---|
| Assistant messages carrying prose | ${proseLengths.length} |
| Median prose characters per message | ${median(proseLengths)} |
| Longest message, characters | ${proseLengths.length ? Math.max(...proseLengths) : 0} |

## Detour indicators

| Measure | Value |
|---|---|
| Longest run of tool calls with no decision between them | ${longestSilentRun} |
| Distinct shell commands run more than once | ${repeatedBash} |

## Time

| Measure | Value |
|---|---|
| Session span | ${mins(spanMs)} min |
| Idle, waiting on the human | ${mins(humanWaitMs)} min |
| Agent working | ${mins(Math.max(0, spanMs - humanWaitMs))} min |

Waiting on a human is not by itself a cost: a necessary decision and an avoidable
interruption produce the same number here. Read it against the question count.

## Tool mix

| Tool | Calls |
|---|---|
${toolLines}

## Run shape

The longest stretches of acting without deciding, in order, run-length encoded. Whether a
run produced anything is the outcome: an edit, a commit, a push, or any other mutating
call. A run that produced nothing looks very different from one that ended in a commit.

${runBlocks}

## Where the work landed

${topTable(pathCounts, "File") ?? "_No file-addressed calls._"}

${topTable(verbCounts, "Shell verb") ?? "_No shell calls._"}

Convergence and scatter are the same call count and different behavior: repeated returns to
one file read differently from a spread across twenty.
`;

if (outPath) {
  writeFileSync(outPath, digest);
  console.log(outPath);
} else {
  process.stdout.write(digest);
}
