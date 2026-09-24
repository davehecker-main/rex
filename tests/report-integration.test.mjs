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

test('logged comparison metric can show measured improvement without claiming causation', () => {
  try {
    fixture();
    const projectFile = join(claudeRoot, 'projects', '-Users-david-Developer-ShareView', 'sessions.jsonl');
    const before = priceable('before-request', 'before-session');
    before.timestamp = '2026-08-10T10:00:00Z';
    const user = (id, session, timestamp, content) => ({ type: 'user', uuid: id, sessionId: session,
      timestamp, message: { content } });
    writeFileSync(projectFile, [before,
      user('before-user', 'before-session', '2026-08-10T09:00:00Z', 'Please investigate'),
      user('before-interrupt', 'before-session', '2026-08-10T11:00:00Z', '[Request interrupted by user]'),
      priceable('after-request', 'session-a'),
      user('after-user', 'session-a', '2026-09-22T09:00:00Z', 'Please investigate again'),
    ].map(JSON.stringify).join('\n'));
    const log = join(root, 'interventions.jsonl');
    writeFileSync(log, JSON.stringify({ at: '2026-08-15T10:00:00Z', finding: 'Interruptions',
      advice: 'Batch asks', acted: 'yes', metric: 'interruptionsPer100HumanTurns' }) + '\n');
    const result = runReportRequest('Did the changes Rex recommended last month help?', {
      root: claudeRoot, interventionLog: log, outputDir, now: '2026-09-23T18:00:00Z',
      timeZone: 'America/Los_Angeles', openBrowser: () => {},
    });
    assert.equal(result.assessment.interventions[0].laterEvidence.status, 'suggests-improvement');
    assert.match(result.assessment.interventions[0].laterEvidence.caveat, /cannot establish causation/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Rex judgment is embedded only with attributable sessions and bounded claims', () => {
  try {
    fixture();
    const options = { root: claudeRoot, outputDir, now: '2026-09-23T18:00:00Z',
      timeZone: 'America/Los_Angeles', openBrowser: () => {} };
    const judgment = { summary: 'Two sessions need attention', findings: [{
      label: 'Interruptions recur', status: 'metric-observation', sessions: ['session-a', 'session-b'],
      evidence: [{ session: 'session-a', reference: 'metric:interruptions' }],
      caveat: 'Counts do not establish avoidability.',
    }] };
    const result = runReportRequest('Review all available history for habits', { ...options, judgment });
    assert.equal(result.assessment.rexJudgment.summary, judgment.summary);
    assert.match(readFileSync(result.delivery.path, 'utf8'), /Two sessions need attention/);
    assert.equal(result.context.query.findingId, null);
    assert.deepEqual(result.context.query.findingIds, ['rex-1', 'coverage']);
    assert.match(readFileSync(result.delivery.path, 'utf8'), /id="finding-rex-1"/);
    assert.throws(() => runReportRequest('Review all available history for habits', { ...options,
      judgment: { ...judgment, findings: [{ ...judgment.findings[0], sessions: ['invented-session'] }] } }), /unknown session/);
    assert.throws(() => runReportRequest('Review all available history for habits', { ...options,
      judgment: { ...judgment, findings: [{ ...judgment.findings[0], status: 'established-behavior' }] } }), /content opt-in/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('opted-in semantic judgment must cite a real transcript message', () => {
  try {
    fixture();
    const projectFile = join(claudeRoot, 'projects', '-Users-david-Developer-ShareView', 'sessions.jsonl');
    const existing = readFileSync(projectFile, 'utf8');
    writeFileSync(projectFile, existing + '\n' + JSON.stringify({ type: 'user', uuid: 'real-turn',
      sessionId: 'session-a', timestamp: '2026-09-22T09:00:00Z', message: { content: 'Why are we here?' } }));
    const options = { root: claudeRoot, outputDir, now: '2026-09-23T18:00:00Z',
      timeZone: 'America/Los_Angeles', openBrowser: () => {} };
    const judgment = { summary: 'A repeated question', findings: [{ label: 'Question loop',
      status: 'established-behavior', sessions: ['session-a'],
      evidence: [{ session: 'session-a', reference: 'invented-turn' }], caveat: 'No elapsed human time inferred.' }] };
    assert.throws(() => runReportRequest('Analyze transcript content for habits', { ...options, judgment }), /unknown transcript reference/);
    judgment.findings[0].evidence[0].reference = 'real-turn';
    const result = runReportRequest('Analyze transcript content for habits', { ...options, judgment });
    assert.equal(result.assessment.contentAnalysis.status, 'supported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('behavior report command invokes read-only Rex judgment before browser delivery', () => {
  try {
    fixture();
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const opener = join(bin, process.platform === 'darwin' ? 'open' : 'xdg-open');
    writeFileSync(opener, '#!/bin/sh\nprintf "%s" "$1" > "$REX_OPEN_CAPTURE"\n');
    chmodSync(opener, 0o700);
    const codex = join(bin, 'codex');
    writeFileSync(codex, '#!/bin/sh\nprintf "%s\\n" "$@" > "$REX_JUDGE_CAPTURE"\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then shift; answer=$1; fi; shift; done\nprintf \'{"summary":"Rex reviewed the measured sessions","findings":[]}\' > "$answer"\n');
    chmodSync(codex, 0o700);
    const request = join(root, 'request.txt');
    writeFileSync(request, 'Review all available history for habits');
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`,
      XDG_DATA_HOME: join(root, 'state'), REX_OPEN_CAPTURE: join(root, 'opened'),
      REX_JUDGE_CAPTURE: join(root, 'judged') };
    const command = join(process.cwd(), 'scripts', 'rex-report.sh');
    const completed = spawnSync('sh', [command, request, '--root', claudeRoot], { encoding: 'utf8', env });
    assert.equal(completed.status, 0, completed.stderr);
    assert.match(readFileSync(join(root, 'judged'), 'utf8'), /--sandbox\nread-only/);
    const context = JSON.parse(readFileSync(join(root, 'state', 'rex', 'report-context.json'), 'utf8'));
    assert.equal(context.judgment.summary, 'Rex reviewed the measured sessions');
    assert.match(readFileSync(context.reportPath, 'utf8'), /Rex reviewed the measured sessions/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('prepared evidence excludes transcript text by default and only exposes a source path after opt-in', () => {
  try {
    fixture();
    const projectFile = join(claudeRoot, 'projects', '-Users-david-Developer-ShareView', 'sessions.jsonl');
    writeFileSync(projectFile, readFileSync(projectFile, 'utf8') + '\n' + JSON.stringify({
      type: 'user', uuid: 'private-turn', sessionId: 'session-a', timestamp: '2026-09-22T09:00:00Z',
      message: { content: 'SECRET_TRANSCRIPT_CONTENT?' },
    }));
    const cli = join(process.cwd(), 'scripts', 'rex-report.mjs');
    const evidencePath = join(root, 'evidence.json');
    const ordinary = spawnSync(process.execPath, [cli, '--root', claudeRoot,
      '--prepare', evidencePath, 'Review all available history for habits'], { encoding: 'utf8' });
    assert.equal(ordinary.status, 0, ordinary.stderr);
    let evidence = readFileSync(evidencePath, 'utf8');
    assert.doesNotMatch(evidence, /SECRET_TRANSCRIPT_CONTENT/);
    assert.equal(JSON.parse(evidence).contentSources, null);
    const opted = spawnSync(process.execPath, [cli, '--root', claudeRoot,
      '--prepare', evidencePath, 'Analyze transcript content for recurring habits'], { encoding: 'utf8' });
    assert.equal(opted.status, 0, opted.stderr);
    evidence = readFileSync(evidencePath, 'utf8');
    assert.doesNotMatch(evidence, /SECRET_TRANSCRIPT_CONTENT/);
    assert.match(JSON.parse(evidence).contentSources, /projects$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
