import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectSourceInventory } from '../scripts/source-inventory.mjs';

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'rex-inventory-'));
  const claudeRoot = join(root, 'claude');
  const codexRoot = join(root, 'codex');
  const shareViewRoot = join(root, 'shareview');
  const rexRoot = join(root, 'rex');
  for (const path of [claudeRoot, codexRoot, shareViewRoot, rexRoot]) mkdirSync(path);
  return { claudeRoot, codexRoot, shareViewRoot, rexRoot, from: '2026-09-20', to: '2026-09-23', command: () => ({ status: 1, stdout: '' }) };
};
const file = (path, body) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, body); };
const source = (report, id) => report.sources.find((row) => row.id === id);

test('discovers sources and reports missing paths and dangling symlinks without stopping', () => {
  const options = fixture();
  symlinkSync('/missing/latest', join(options.claudeRoot, 'state'));
  const report = collectSourceInventory(options);
  assert.equal(source(report, 'claude.state').coverage.dangling, 1);
  assert.equal(source(report, 'claude.history').coverage.status, 'missing');
  assert.equal(source(report, 'codex.sessions').coverage.status, 'missing');
  assert.equal(report.unavailable.includes('human attention'), true);
});

test('parses NDJSON stored in .json, dates rows, and omits sensitive values', () => {
  const options = fixture();
  file(join(options.claudeRoot, 'telemetry', 'spool.json'),
    '{"event_data":{"client_timestamp":"2026-09-21T10:00:00Z"},"secret":"DO_NOT_REPORT"}\n' +
    '{"event_data":{"client_timestamp":"2026-09-19T10:00:00Z"}}\ninvalid\n');
  file(join(options.claudeRoot, 'settings.json'), '{"permissions":{"allow":["secret grant DO_NOT_REPORT"]}}');
  const report = collectSourceInventory(options);
  assert.equal(source(report, 'claude.telemetry').coverage.rowsInWindow, 1);
  assert.equal(source(report, 'claude.telemetry').coverage.unparseable, 1);
  assert.equal(source(report, 'claude.settings').kind, 'snapshot');
  assert.equal(JSON.stringify(report).includes('DO_NOT_REPORT'), false);
});

test('keeps Codex token convention apart from Claude and treats empty SQLite as a gap', () => {
  const options = fixture();
  file(join(options.codexRoot, 'sessions', '2026', '09', '21', 'run.jsonl'),
    JSON.stringify({ timestamp: '2026-09-21T12:00:00Z', type: 'token_usage_record',
      payload: { usage: { input_tokens: 10, output_tokens: 4, reasoning_output_tokens: 2 } } }) + '\n');
  file(join(options.codexRoot, 'logs_2.sqlite'), '');
  const report = collectSourceInventory(options);
  assert.deepEqual(source(report, 'codex.sessions').facts.tokens, { input: 10, output: 4, reasoningOutputSubset: 2 });
  assert.equal(source(report, 'codex.logs').coverage.status, 'unparseable');
  assert.equal(report.providerTokens.codex.output, 4);
  assert.equal('total' in report.providerTokens, false);
});

test('lists candidate install milestones and labels live claims as a snapshot', () => {
  const options = fixture();
  file(join(options.rexRoot, 'scripts', 'install.sh'), '#!/bin/sh\n');
  options.command = (command) => command === 'chattr state'
    ? { status: 0, stdout: 'claim issue:17 DO_NOT_REPORT\nclaim issue:19' }
    : { status: 0, stdout: '2026-09-20T00:00:00Z\n' };
  const report = collectSourceInventory(options);
  assert.equal(source(report, 'chattr.state').kind, 'snapshot');
  assert.equal(source(report, 'chattr.state').facts.claims, 2);
  assert.equal(JSON.stringify(report).includes('DO_NOT_REPORT'), false);
  assert.ok(report.installMilestones.candidates.some((row) => row.source === 'install.sh mtime'));
});
