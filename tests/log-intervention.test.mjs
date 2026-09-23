import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = new URL("../scripts/log-intervention.mjs", import.meta.url).pathname;

function run(log, ...args) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, REX_LOG: log },
  });
}

function rows(log) {
  return readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
}

test("keyed findings and decision rows coexist with legacy rows", () => {
  const log = join(mkdtempSync(join(tmpdir(), "rex-log-")), "interventions.jsonl");
  assert.equal(run(log, "--finding", "waiting", "--habit", "avoidable-wait").status, 0);
  assert.equal(run(log, "--habit", "avoidable-wait", "--decision", "rule", "--rule", "Batch independent reads").status, 0);
  assert.equal(run(log, "--finding", "older row").status, 0);
  const [finding, decision, legacy] = rows(log);
  assert.equal(finding.habit, "avoidable-wait");
  assert.equal(finding.decision, undefined);
  assert.equal(decision.habit, "avoidable-wait");
  assert.equal(decision.decision, "rule");
  assert.equal(decision.rule, "Batch independent reads");
  assert.equal(decision.finding, null);
  assert.equal(legacy.habit, undefined);
});

test("none never becomes a habit sighting", () => {
  const log = join(mkdtempSync(join(tmpdir(), "rex-log-")), "interventions.jsonl");
  assert.equal(run(log, "--finding", "none", "--habit", "avoidable-wait").status, 0);
  assert.equal(rows(log)[0].habit, undefined);
});

test("invalid decisions and unkeyed decisions do not append", () => {
  const log = join(mkdtempSync(join(tmpdir(), "rex-log-")), "interventions.jsonl");
  assert.equal(run(log, "--habit", "avoidable-wait", "--decision", "maybe").status, 2);
  assert.equal(run(log, "--decision", "drop").status, 2);
  assert.equal(run(log, "--finding", "waiting", "--decision", "drop").status, 2);
  assert.equal(run(log, "--habit", "avoidable-wait", "--decision", "drop").status, 0);
  assert.equal(rows(log).length, 1);
});
