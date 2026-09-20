#!/usr/bin/env node
// Turn one Claude Code session transcript into a metrics-only digest for Rex.
//
//   node scripts/session-digest.mjs <session.jsonl> [-o digest.md]
//
// Metrics only, by design: no prompt text, no assistant prose, no tool arguments,
// no file contents. Rex diagnoses working habits from shape and timing, and a digest
// that carries transcript text would hand him the session's own framing along with it.

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const argv = process.argv.slice(2);
const outFlag = argv.indexOf("-o");
const outPath = outFlag === -1 ? null : argv[outFlag + 1];
const inPath =
  outFlag === -1 ? argv[0] : argv.find((a, i) => i !== outFlag && i !== outFlag + 1);

if (!inPath) {
  console.error("usage: session-digest.mjs <session.jsonl> [-o digest.md]");
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

// Longest run of consecutive tool calls with no assistant prose between them. A long
// run is the shape of a detour: acting repeatedly without stopping to decide anything.
let longestSilentRun = 0;
let run = 0;
for (const r of rows) {
  if (r.type !== "assistant") continue;
  const types = contentTypes(r);
  if (types.includes("text")) {
    longestSilentRun = Math.max(longestSilentRun, run);
    run = 0;
  }
  run += types.filter((t) => t === "tool_use").length;
}
longestSilentRun = Math.max(longestSilentRun, run);

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

const digest = `# Session digest — ${basename(inPath)}

Metrics only. No transcript text is included in this file.

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
`;

if (outPath) {
  writeFileSync(outPath, digest);
  console.log(outPath);
} else {
  process.stdout.write(digest);
}
