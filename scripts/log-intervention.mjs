#!/usr/bin/env node
// Append one row to Rex's intervention log.
//
//   node scripts/log-intervention.mjs --session <id> --finding "<diagnosis>" \
//     --advice "<correction>" --acted <yes|no|partial>
//
// Rex cold-starts on every consult and remembers nothing. This file is his memory:
// what he found, what he advised, and whether anything came of it. A finding of
// "none" is a real row — a log of only the bad sessions cannot show whether he is
// right about the good ones.

import { appendFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";

const LOG =
  process.env.REX_LOG ??
  `${process.env.XDG_DATA_HOME ?? `${homedir()}/.local/share`}/rex/interventions.jsonl`;

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

if (argv.includes("--list")) {
  if (!existsSync(LOG)) {
    console.log(`no log yet at ${LOG}`);
    process.exit(0);
  }
  process.stdout.write(readFileSync(LOG, "utf8"));
  process.exit(0);
}

const finding = arg("finding");
const habit = arg("habit");
const decision = arg("decision");
const rule = arg("rule");
if (decision !== undefined && !["rule", "drop"].includes(decision)) {
  console.error(`--decision must be rule or drop (got "${decision}")`);
  process.exit(2);
}
if (habit !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(habit)) {
  console.error("--habit must be a lowercase slug");
  process.exit(2);
}
if (decision && (!habit || finding || (decision === "drop" && rule))) {
  console.error("a decision requires --habit, no --finding, and --rule only with rule");
  process.exit(2);
}
if (rule && !decision) {
  console.error("--rule requires --decision rule");
  process.exit(2);
}
if (!finding && !decision) {
  console.error(
    'usage: log-intervention.mjs --session <id> --finding "<diagnosis>" [--habit <slug>] --advice "<correction>" --acted <yes|no|partial>\n' +
      '       log-intervention.mjs --habit <slug> --decision rule|drop [--rule "<text or location>"]\n' +
      "       log-intervention.mjs --list",
  );
  process.exit(2);
}

const acted = arg("acted") ?? "unknown";
if (!["yes", "no", "partial", "unknown"].includes(acted)) {
  console.error(`--acted must be yes, no, partial or unknown (got "${acted}")`);
  process.exit(2);
}

const row = {
  at: new Date().toISOString(),
  session: arg("session") ?? null,
  repo: arg("repo") ?? null,
  finding: finding ?? null,
  advice: arg("advice") ?? null,
  acted,
};
if (habit && (decision || finding !== "none")) row.habit = habit;
if (decision) row.decision = decision;
if (rule) row.rule = rule;

mkdirSync(dirname(LOG), { recursive: true });
appendFileSync(LOG, `${JSON.stringify(row)}\n`);
console.log(LOG);
