import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
  assert.equal('tokens' in source(report, 'codex.sessions').facts, false);
  assert.equal(source(report, 'codex.logs').coverage.status, 'unparseable');
  assert.equal(report.providerTokens.codex.output, 4);
  assert.equal('total' in report.providerTokens, false);
});

test('lists candidate install milestones and labels live claims as a snapshot', () => {
  const options = fixture();
  file(join(options.rexRoot, 'scripts', 'install.sh'), '#!/bin/sh\n');
  options.command = (command) => command === 'chattr state'
    ? { status: 0, stdout: JSON.stringify({ ok: true, claims: [{ note: 'DO_NOT_REPORT' }, {}], peers: [], broadcasts: [], unacked: [] }) }
    : { status: 0, stdout: '2026-09-20T00:00:00Z\n' };
  const report = collectSourceInventory(options);
  assert.equal(source(report, 'chattr.state').kind, 'snapshot');
  assert.equal(source(report, 'chattr.state').facts.claims, 2);
  assert.equal(JSON.stringify(report).includes('DO_NOT_REPORT'), false);
  assert.ok(report.installMilestones.candidates.some((row) => row.source === 'install.sh mtime'));
});

test('reads job timelines, numeric history timestamps, and installed-date window', () => {
  const options = fixture();
  file(join(options.claudeRoot, 'jobs', 'a', 'timeline.jsonl'),
    '{"at":"2026-09-21T10:00:00Z","state":"done","text":"DO_NOT_REPORT"}\n');
  file(join(options.claudeRoot, 'history.jsonl'), JSON.stringify({ timestamp: Date.parse('2026-09-21'), display: 'DO_NOT_REPORT' }) + '\n');
  file(join(options.claudeRoot, 'commands', 'rex.md'), 'installed');
  const report = collectSourceInventory({ ...options, from: 'since-installed' });
  assert.equal(source(report, 'claude.jobs').coverage.rowsInWindow, 0);
  assert.equal(report.window.from, report.installMilestones.chosen.at);
  assert.equal(JSON.stringify(report).includes('DO_NOT_REPORT'), false);
  const dated = collectSourceInventory(options);
  assert.equal(source(dated, 'claude.jobs').coverage.rowsInWindow, 1);
  assert.equal(source(dated, 'claude.jobs').facts.completed, 1);
  assert.equal(source(dated, 'claude.history').coverage.rowsInWindow, 1);
});

test('deduplicates Codex archive tokens and classifies nested subagents', () => {
  const options = fixture();
  const meta = { timestamp: '2026-09-21T10:00:00Z', type: 'session_meta', payload: { source: { subagent: { other: 'private' } } } };
  const context = { timestamp: '2026-09-21T10:00:00Z', type: 'turn_context', payload: { model: 'gpt-6-sol', effort: 'high' } };
  const usage = (id, n) => ({ timestamp: '2026-09-21T10:00:00Z', type: 'token_usage_record',
    payload: { session_id: 's1', response_id: id, usage: { input_tokens: n, output_tokens: n / 2, reasoning_output_tokens: 1 } } });
  file(join(options.codexRoot, 'sessions', 'a.jsonl'), [meta, context, usage('r1', 10)].map(JSON.stringify).join('\n'));
  file(join(options.codexRoot, 'archived_sessions', 'b.jsonl'), [usage('r1', 10), usage('r2', 20)].map(JSON.stringify).join('\n'));
  file(join(options.codexRoot, 'sessions', 'origins.jsonl'), [
    { timestamp: '2026-09-21T10:00:00Z', type: 'session_meta', payload: { source: 'vscode' } },
    { timestamp: '2026-09-21T10:00:00Z', type: 'session_meta', payload: { source: 'mcp' } },
  ].map(JSON.stringify).join('\n'));
  file(join(options.codexRoot, 'config.toml'), 'model = "gpt-6-sol"\nmodel_reasoning_effort = "high"\nsecret = "DO_NOT_REPORT"\n');
  const report = collectSourceInventory(options);
  assert.deepEqual(report.providerTokens.codex, { input: 30, output: 15, reasoningOutputSubset: 2 });
  assert.equal(source(report, 'codex.sessions').facts.origins.spawned, 1);
  assert.equal(source(report, 'codex.sessions').facts.origins.ide, 1);
  assert.equal(source(report, 'codex.sessions').facts.origins.mcp, 1);
  assert.equal('tokens' in source(report, 'codex.sessions').facts, false);
  assert.equal('tokens' in source(report, 'codex.archived-sessions').facts, false);
  assert.equal(source(report, 'codex.config').facts.observedModelMatchesConfig, true);
  assert.equal(source(report, 'codex.config').facts.observedEffortMatchesConfig, true);
  assert.equal(JSON.stringify(report).includes('DO_NOT_REPORT'), false);
});

test('summarizes settings changes and SQLite metadata without values', () => {
  const options = fixture();
  file(join(options.claudeRoot, 'settings.json'), JSON.stringify({ permissions: { allow: ['new secret DO_NOT_REPORT'] }, hooks: { Stop: [1] } }));
  file(join(options.claudeRoot, 'settings.json.bak'), JSON.stringify({ permissions: { allow: ['old secret DO_NOT_REPORT'] }, hooks: {} }));
  const report = collectSourceInventory(options);
  assert.equal(source(report, 'claude.settings-backups').facts.changedPermissionRules, 2);
  assert.equal(source(report, 'claude.settings-backups').facts.changedHookEvents, 1);
  assert.equal(source(report, 'claude.settings').facts.hookEvents, 1);
  assert.equal(JSON.stringify(report).includes('DO_NOT_REPORT'), false);
});

test('parses chattr JSON and survives a directory symlink cycle', () => {
  const options = fixture();
  mkdirSync(join(options.claudeRoot, 'state'));
  symlinkSync(join(options.claudeRoot, 'state'), join(options.claudeRoot, 'state', 'loop'));
  options.command = (name) => name === 'chattr state'
    ? { status: 0, stdout: JSON.stringify({ ok: true, peers: [{ id: 'DO_NOT_REPORT' }], claims: [{ note: 'DO_NOT_REPORT' }], unacked: [], broadcasts: [] }) }
    : { status: 1, stdout: '' };
  const report = collectSourceInventory(options);
  assert.equal(source(report, 'chattr.state').facts.claims, 1);
  assert.equal(source(report, 'chattr.state').facts.peers, 1);
  assert.equal(source(report, 'claude.state').coverage.cycles, 1);
  assert.equal(JSON.stringify(report).includes('DO_NOT_REPORT'), false);
});

test('summarizes SQLite severities, goal statuses, queue and memories without contents', () => {
  const options = fixture();
  const schemas = [
    ['logs_2.sqlite', "CREATE TABLE logs(level TEXT, feedback_log_body TEXT); INSERT INTO logs VALUES ('error','DO_NOT_REPORT')"],
    ['goals_1.sqlite', "CREATE TABLE thread_goals(status TEXT, objective TEXT); INSERT INTO thread_goals VALUES ('active','DO_NOT_REPORT')"],
    ['queue_1.sqlite', "CREATE TABLE queued_items(payload_json TEXT); INSERT INTO queued_items VALUES ('DO_NOT_REPORT')"],
    ['memories_1.sqlite', "CREATE TABLE memories(content TEXT); INSERT INTO memories VALUES ('DO_NOT_REPORT')"],
  ];
  for (const [name, sql] of schemas) { const db = new DatabaseSync(join(options.codexRoot, name)); db.exec(sql); db.close(); }
  const report = collectSourceInventory(options);
  assert.equal(source(report, 'codex.logs').facts.severities.error, 1);
  assert.equal(source(report, 'codex.goals').facts.statuses.active, 1);
  assert.equal(source(report, 'codex.queue').facts.queuedItems, 1);
  assert.equal(source(report, 'codex.memories').facts.memoryRows, 1);
  assert.equal(JSON.stringify(report).includes('DO_NOT_REPORT'), false);
});

test('reports cache staleness, safe transcript facts and missing install candidates', () => {
  const options = fixture();
  const transcript = [
    { type: 'assistant', timestamp: '2026-09-21T10:00:00Z', message: { content: [
      { type: 'tool_use', name: 'AskUserQuestion' }, { type: 'tool_use', name: 'Task' },
      { type: 'tool_result', is_error: true, content: 'DO_NOT_REPORT' } ] } },
    { type: 'system', subtype: 'stop_hook_summary', timestamp: '2026-09-21T10:00:00Z', hookCount: 2,
      hookInfos: [{ command: 'DO_NOT_REPORT', durationMs: 17 }] },
    { type: 'system', subtype: 'classifier_denial', timestamp: '2026-09-21T10:00:00Z' },
  ];
  file(join(options.claudeRoot, 'projects', 'p', 'session.jsonl'), transcript.map(JSON.stringify).join('\n'));
  file(join(options.claudeRoot, 'stats-cache.json'), '{}');
  utimesSync(join(options.claudeRoot, 'stats-cache.json'), new Date('2026-01-01'), new Date('2026-01-01'));
  mkdirSync(join(options.claudeRoot, 'commands'));
  symlinkSync('/missing/rex.md', join(options.claudeRoot, 'commands', 'rex.md'));
  const report = collectSourceInventory(options);
  assert.equal(source(report, 'claude.projects').facts.questions, 1);
  assert.equal(source(report, 'claude.projects').facts.agentLaunches, 1);
  assert.equal(source(report, 'claude.projects').facts.toolErrors, 1);
  assert.equal(source(report, 'claude.projects').facts.hookDurationMs, 17);
  assert.equal(source(report, 'claude.projects').facts.classifierDenials, 1);
  assert.equal(source(report, 'claude.projects').facts.contextAttachments, 0);
  assert.match(source(report, 'claude.projects').limit, /automatic refusals/i);
  assert.equal(source(report, 'claude.stats-cache').facts.stale, true);
  assert.ok(report.installMilestones.missingCandidates.some((row) =>
    row.source === 'installed Claude command mtime' && row.status === 'dangling'));
  assert.equal(JSON.stringify(report).includes('DO_NOT_REPORT'), false);
});

test('counts context attachment records without reporting their contents', () => {
  const options = fixture();
  file(join(options.claudeRoot, 'projects', 'p', 'session.jsonl'), JSON.stringify({
    type: 'attachment', timestamp: '2026-09-21T10:00:00Z', attachment: { secret: 'DO_NOT_REPORT' },
  }) + '\n');
  const report = collectSourceInventory(options);
  assert.equal(source(report, 'claude.projects').facts.contextAttachments, 1);
  assert.match(source(report, 'claude.projects').dataHeld, /attachments/);
  assert.equal(JSON.stringify(report).includes('DO_NOT_REPORT'), false);
});
