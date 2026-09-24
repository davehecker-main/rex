import test from 'node:test';
import assert from 'node:assert/strict';
import { assessReport } from '../scripts/report-assessment.mjs';

const request = (id, session, project, date, output = 10) => ({
  requestId: id, session, project, date, model: 'claude-opus-5', subagent: false,
  tokens: { input: 10, output, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, cacheWriteUnknown: 0 },
  price: { status: 'priced', usd: 0.001 },
});
const report = (requests, sessions, from, to, coverage = {}) => ({
  basis: { source: 'Claude Code local transcripts', from, toExclusive: to },
  summary: { requests: requests.length, apiEquivalentUsd: requests.length * 0.001 },
  coverage: { unreadableFiles: 0, malformedLines: 0, rowsWithoutUsage: 0, undatedRows: 0, ...coverage },
  groups: { bySession: sessions },
  requests,
});
const earlier = report(
  [request('old-1', 'old-a', 'project-a', '2026-08-02'), request('old-2', 'old-b', 'project-b', '2026-08-03')],
  [{ key: 'old-a', humanTurns: 2, interruptions: 1, toolCalls: 4, assistantProseCharacters: 100 },
    { key: 'old-b', humanTurns: 2, interruptions: 1, toolCalls: 4, assistantProseCharacters: 100 }],
  '2026-08-01', '2026-09-01',
);
const current = report(
  [request('new-1', 'new-a', 'project-a', '2026-09-02'), request('new-2', 'new-b', 'project-b', '2026-09-03')],
  [{ key: 'new-a', humanTurns: 2, interruptions: 0, toolCalls: 3, assistantProseCharacters: 50 },
    { key: 'new-b', humanTurns: 2, interruptions: 0, toolCalls: 2, assistantProseCharacters: 40 }],
  '2026-09-01', '2026-10-01',
);

test('compares periods and projects with measured deltas and session evidence', () => {
  const result = assessReport(current, { baseline: earlier, projectComparison: ['project-a', 'project-b'] });
  const period = result.comparisons.find((item) => item.dimension === 'period');
  assert.deepEqual(period.evidence.currentSessions, ['new-a', 'new-b']);
  assert.deepEqual(period.evidence.baselineSessions, ['old-a', 'old-b']);
  assert.equal(period.metrics.interruptions.current, 0);
  assert.equal(period.metrics.interruptions.baseline, 2);
  assert.equal(period.metrics.interruptions.delta, -2);
  assert.equal(period.metrics.requests.delta, 0);
  const project = result.comparisons.find((item) => item.dimension === 'project');
  assert.deepEqual(project.evidence.currentSessions, ['new-a']);
  assert.deepEqual(project.evidence.baselineSessions, ['new-b']);
  assert.equal(project.metrics.toolCalls.current, 3);
  assert.equal(project.metrics.toolCalls.baseline, 2);
  assert.equal(result.timeSinks.status, 'unknown');
  assert.equal(JSON.stringify(result).includes('humanMinutes'), false);
});

test('observed recurring metric patterns cite sessions without claiming semantic behavior', () => {
  const result = assessReport(earlier);
  const observed = result.patterns.find((pattern) => pattern.metric === 'interruptions');
  assert.equal(observed.status, 'metric-observation');
  assert.deepEqual(observed.evidence.sessions, ['old-a', 'old-b']);
  assert.equal(observed.measurements.total, 2);
  assert.deepEqual(result.semanticFindings, []);
  assert.equal(result.contentAnalysis.status, 'not-requested');
});

test('intervention follow-through separates unknown, confirmed inaction, and observed change without causation', () => {
  const interventions = [
    { at: '2026-08-15T00:00:00Z', session: 'old-a', finding: 'Interruptions', advice: 'Batch asks', acted: 'unknown', metric: 'interruptionsPer100HumanTurns' },
    { at: '2026-08-15T00:00:00Z', session: 'old-b', finding: 'Interruptions', advice: 'Batch asks', acted: 'no' },
  ];
  const result = assessReport(current, { baseline: earlier, interventions });
  assert.equal(result.interventions[0].followThrough, 'unknown');
  assert.equal(result.interventions[1].followThrough, 'confirmed-inaction');
  assert.equal(result.interventions[0].laterEvidence.status, 'suggests-improvement');
  assert.equal(result.interventions[0].laterEvidence.baseline, 50);
  assert.equal(result.interventions[0].laterEvidence.current, 0);
  assert.match(result.interventions[0].laterEvidence.caveat, /cannot establish causation/i);
  assert.equal(result.interventions[1].laterEvidence.status, 'unknown');
});

test('does not infer intervention effect when periods do not bracket it or the metric is unsupported', () => {
  const result = assessReport(current, { baseline: earlier, interventions: [
    { at: '2026-10-05T00:00:00Z', finding: 'Late', acted: 'yes', metric: 'interruptionsPer100HumanTurns' },
    { at: '2026-08-15T00:00:00Z', finding: 'Unmeasurable', acted: 'partial', metric: 'reopenedDecisions' },
  ] });
  assert.equal(result.interventions[0].laterEvidence.status, 'unknown');
  assert.equal(result.interventions[1].laterEvidence.status, 'unknown');
});

test('healthy period is explicit while incomplete or empty periods remain unknown', () => {
  assert.equal(assessReport(current).health.status, 'healthy');
  assert.equal(assessReport(report([], [], '2026-09-01', '2026-10-01')).health.status, 'unknown');
  assert.equal(assessReport(report(current.requests, current.groups.bySession, '2026-09-01', '2026-10-01', { unreadableFiles: 1 })).health.status, 'unknown');
});

test('semantic findings require opt-in and attributable evidence', () => {
  const finding = { label: 'Repeated question', evidence: [{ session: 'new-a', reference: 'turn-17' }] };
  assert.deepEqual(assessReport(current, { semanticEvidence: [finding] }).semanticFindings, []);
  const optedIn = assessReport(current, { contentAnalysis: true, semanticEvidence: [finding] });
  assert.equal(optedIn.contentAnalysis.status, 'supported');
  assert.deepEqual(optedIn.semanticFindings, [finding]);
  const insufficient = assessReport(current, { contentAnalysis: true, semanticEvidence: [{ label: 'Guess', evidence: [] }] });
  assert.equal(insufficient.contentAnalysis.status, 'insufficient-evidence');
  assert.deepEqual(insufficient.semanticFindings, []);
});
