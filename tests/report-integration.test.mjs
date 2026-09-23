import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReportRequest } from '../scripts/report-runner.mjs';

const root = mkdtempSync(join(tmpdir(), 'rex-integration-'));
const claudeRoot = join(root, 'claude');
const outputDir = join(root, 'output');
const priceable = (id, session, model = 'claude-opus-5') => ({
  type: 'assistant', uuid: id, requestId: id, sessionId: session, timestamp: '2026-09-22T10:00:00Z',
  message: { id, model, usage: { input_tokens: 10, output_tokens: 20,
    cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    service_tier: 'standard' } },
});
function fixture() {
  mkdirSync(outputDir, { recursive: true });
  for (const [project, rows] of [
    ['-Users-david-Developer-ShareView', [priceable('one', 'session-a'), priceable('one', 'session-a'),
      { ...priceable('missing', 'session-c'), message: { id: 'missing', model: 'claude-opus-5', content: [] } }]],
    ['-Users-david-Developer-Rex', [priceable('two', 'session-b', 'claude-sonnet-5')]],
  ]) {
    const directory = join(claudeRoot, 'projects', project);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'sessions.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n'));
  }
}

test('request opens report artifact, follow-up keeps scope and filters, drill-down cites a finding', () => {
  try {
    fixture();
    const opened = [];
    const options = { root: claudeRoot, outputDir, now: '2026-09-23T18:00:00Z',
      timeZone: 'America/Los_Angeles', openBrowser: (url) => opened.push(url) };
    const first = runReportRequest('Compare ShareView and Rex this week with last week for tokens and cost', options);
    assert.equal(first.status, 'delivered');
    assert.equal(first.view.scope.projects.length, 2);
    assert.equal(first.view.summary.requests, 2);
    assert.equal(first.view.cost.status, 'incomplete');
    assert.ok(first.view.comparison);
    assert.match(readFileSync(first.delivery.path, 'utf8'), /Comparison/);
    assert.equal(opened.length, 1);
    const next = runReportRequest('only ShareView', { ...options, previous: first.context });
    assert.deepEqual(next.view.scope.projects, ['ShareView']);
    assert.equal(next.view.summary.requests, 1);
    assert.equal(next.view.scope.sessions, 2);
    assert.equal(next.view.scope.models.length, 0);
    assert.equal(next.view.assessment.health.status, 'unknown');
    const drill = runReportRequest('show the sessions behind that finding', { ...options, previous: next.context });
    assert.equal(drill.status, 'delivered');
    assert.deepEqual(drill.view.finding.sessions, ['session-a', 'session-c']);
    assert.match(readFileSync(drill.delivery.path, 'utf8'), /session-c/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('model filter changes totals and explicit opt-in is visible but never reads content silently', () => {
  try {
    fixture();
    const options = { root: claudeRoot, outputDir, now: '2026-09-23T18:00:00Z',
      timeZone: 'America/Los_Angeles', openBrowser: () => {} };
    const filtered = runReportRequest('Show opus 5 usage across every project', options);
    assert.equal(filtered.view.summary.requests, 1);
    assert.deepEqual(filtered.view.scope.models, ['claude-opus-5']);
    assert.equal(filtered.view.assessment.contentAnalysis.status, 'not-requested');
    const opted = runReportRequest('Analyze transcript content for recurring habits', options);
    assert.equal(opted.view.assessment.contentAnalysis.status, 'insufficient-evidence');
    assert.deepEqual(opted.view.assessment.semanticFindings, []);
    assert.match(readFileSync(opted.delivery.path, 'utf8'), /explicit opt-in/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('command accepts free-text request and persists follow-up context while opening browser', () => {
  try {
    fixture();
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const opener = join(bin, process.platform === 'darwin' ? 'open' : 'xdg-open');
    writeFileSync(opener, '#!/bin/sh\nprintf "%s" "$1" > "$REX_OPEN_CAPTURE"\n');
    chmodSync(opener, 0o700);
    const capture = join(root, 'opened');
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`,
      XDG_DATA_HOME: join(root, 'state'), REX_OPEN_CAPTURE: capture };
    const cli = join(process.cwd(), 'scripts', 'rex-report.mjs');
    const first = spawnSync(process.execPath, [cli, '--root', claudeRoot,
      'Show all my usage across every project'], { encoding: 'utf8', env });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Rex report: file:/);
    assert.match(readFileSync(capture, 'utf8'), /^file:/);
    const second = spawnSync(process.execPath, [cli, '--root', claudeRoot, 'only ShareView'],
      { encoding: 'utf8', env });
    assert.equal(second.status, 0, second.stderr);
    const context = JSON.parse(readFileSync(join(root, 'state', 'rex', 'report-context.json'), 'utf8'));
    assert.deepEqual(context.query.projects, ['-Users-david-Developer-ShareView']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('current-session request needs a host session ID and limits the report to it', () => {
  try {
    fixture();
    const options = { root: claudeRoot, outputDir, now: '2026-09-23T18:00:00Z',
      timeZone: 'America/Los_Angeles', openBrowser: () => {} };
    const before = process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    assert.equal(runReportRequest('Show this current session usage', options).status, 'clarification');
    process.env.CLAUDE_CODE_SESSION_ID = 'session-b';
    try {
      const selected = runReportRequest('Show this current session usage', options);
      assert.equal(selected.view.summary.requests, 1);
      assert.deepEqual(selected.view.sections.find((section) => section.id === 'session').rows.map((row) => row.key), ['session-b']);
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = before;
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('host may resolve free phrasing to a validated query without narrowing scope', () => {
  try {
    fixture();
    const options = { root: claudeRoot, outputDir, now: '2026-09-23T18:00:00Z',
      timeZone: 'America/Los_Angeles', openBrowser: () => {} };
    const ordinary = runReportRequest('Tell me what all the models have been up to', options);
    assert.equal(ordinary.status, 'clarification');
    const resolved = runReportRequest('Tell me what all the models have been up to', {
      ...options, queryOverride: { kind: 'usage', projects: [], models: [], period: null } });
    assert.equal(resolved.view.summary.requests, 2);
    assert.deepEqual(resolved.view.scope.projects, []);
    assert.throws(() => runReportRequest('Analyze my usage', { ...options,
      queryOverride: { kind: 'behavior', contentAnalysis: true } }), /explicit opt-in/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('intervention question reads selected log entries and reports unknown effects honestly', () => {
  try {
    fixture();
    const log = join(root, 'interventions.jsonl');
    writeFileSync(log, JSON.stringify({ at: '2026-08-15T10:00:00Z', finding: 'Batch questions',
      advice: 'Consolidate asks', acted: 'unknown' }) + '\n');
    const result = runReportRequest('Did the changes Rex recommended last month help?', {
      root: claudeRoot, interventionLog: log, outputDir, now: '2026-09-23T18:00:00Z',
      timeZone: 'America/Los_Angeles', openBrowser: () => {},
    });
    assert.equal(result.query.kind, 'intervention');
    assert.deepEqual(result.query.projects, []);
    assert.equal(result.assessment.interventions.length, 1);
    assert.equal(result.assessment.interventions[0].followThrough, 'unknown');
    assert.equal(result.assessment.interventions[0].laterEvidence.status, 'unknown');
    assert.match(readFileSync(result.delivery.path, 'utf8'), /Batch questions/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
