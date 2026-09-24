import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, utimesSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = new URL("../scripts/install.sh", import.meta.url).pathname;

function run(home) {
  return spawnSync("sh", [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: join(home, ".codex"),
      CLAUDE_HOME: join(home, ".claude"),
      XDG_DATA_HOME: join(home, ".local", "share"),
    },
  });
}

function record(home) {
  return readFileSync(join(home, ".local", "share", "rex", "installed-at"), "utf8").trim();
}

test("fresh install seeds the record from now", () => {
  const home = mkdtempSync(join(tmpdir(), "rex-install-fresh-"));
  const before = Date.now();
  const result = run(home);
  assert.equal(result.status, 0, result.stderr);
  const at = Date.parse(record(home));
  assert.ok(at >= before - 1000 && at <= Date.now() + 1000, "record should be ~now");
});

test("upgrade seeds the record from the earliest pre-existing installed-file mtime, not now", () => {
  const home = mkdtempSync(join(tmpdir(), "rex-install-upgrade-"));
  const claudeCommands = join(home, ".claude", "commands");
  const codexAgents = join(home, ".codex", "agents");
  mkdirSync(claudeCommands, { recursive: true });
  mkdirSync(codexAgents, { recursive: true });
  const oldTime = new Date("2020-01-01T00:00:00Z");
  const newerTime = new Date("2021-06-15T00:00:00Z");
  writeFileSync(join(claudeCommands, "rex.md"), "stale command\n");
  utimesSync(join(claudeCommands, "rex.md"), oldTime, oldTime);
  writeFileSync(join(codexAgents, "rex.toml"), "stale agent\n");
  utimesSync(join(codexAgents, "rex.toml"), newerTime, newerTime);

  const result = run(home);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(record(home), "2020-01-01T00:00:00Z");
});

test("second run never touches an existing record", () => {
  const home = mkdtempSync(join(tmpdir(), "rex-install-idempotent-"));
  assert.equal(run(home).status, 0);
  const first = record(home);
  assert.equal(run(home).status, 0);
  assert.equal(record(home), first);
});
