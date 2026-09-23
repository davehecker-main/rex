import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReportQuery, collectorOptions } from '../scripts/report-query.mjs';

const context = {
  now: '2026-09-23T18:00:00Z',
  timeZone: 'America/Los_Angeles',
  projects: [{ name: 'ShareView', key: '-Users-david-Developer-ShareView' }, { name: 'Rex', key: '-Users-david-Developer-rex' }],
  models: ['claude-opus-5', 'claude-sonnet-5'],
};

test('resolves last month across projects into collector-ready exclusive bounds', () => {
  const result = resolveReportQuery('Show all my usage across every project for the last month.', context);
  assert.equal(result.status, 'resolved');
  assert.deepEqual(result.query.projects, []);
  assert.equal(result.query.period.from, '2026-08-01T07:00:00.000Z');
  assert.equal(result.query.period.to, '2026-09-01T07:00:00.000Z');
  assert.equal(result.query.timeZone, 'America/Los_Angeles');
  assert.equal(result.query.contentAnalysis, false);
  assert.equal(result.query.kind, 'usage');
});

test('all available history and recurring habits keep content analysis off by default', () => {
  const result = resolveReportQuery('Review all available history and tell me which habits keep wasting time.', context);
  assert.equal(result.status, 'resolved');
  assert.equal(result.query.period, null);
  assert.equal(result.query.kind, 'behavior');
  assert.equal(result.query.contentAnalysis, false);
  assert.equal(result.query.history, 'all-available');
});

test('compares this week with last week and maps a named project and model', () => {
  const result = resolveReportQuery('Compare ShareView this week with last week for opus 5 tokens and cost.', context);
  assert.equal(result.status, 'resolved');
  assert.deepEqual(result.query.projects, ['-Users-david-Developer-ShareView']);
  assert.deepEqual(result.query.models, ['claude-opus-5']);
  assert.equal(result.query.kind, 'comparison');
  assert.deepEqual(result.query.period, { from: '2026-09-21T07:00:00.000Z', to: '2026-09-28T07:00:00.000Z' });
  assert.deepEqual(result.query.comparePeriod, { from: '2026-09-14T07:00:00.000Z', to: '2026-09-21T07:00:00.000Z' });
});

test('follow-ups preserve scope and resolve previous month from prior period', () => {
  const prior = resolveReportQuery('Show ShareView usage this month', context).query;
  const result = resolveReportQuery('compare that with the previous month', { ...context, previous: prior });
  assert.equal(result.status, 'resolved');
  assert.deepEqual(result.query.projects, prior.projects);
  assert.deepEqual(result.query.period, prior.period);
  assert.deepEqual(result.query.comparePeriod, { from: '2026-08-01T07:00:00.000Z', to: '2026-09-01T07:00:00.000Z' });
});

test('follow-up filters project and opens browser without losing report scope', () => {
  const prior = resolveReportQuery('Show all usage last month', context).query;
  const narrowed = resolveReportQuery('only ShareView', { ...context, previous: prior });
  assert.equal(narrowed.status, 'resolved');
  assert.deepEqual(narrowed.query.projects, ['-Users-david-Developer-ShareView']);
  assert.deepEqual(narrowed.query.period, prior.period);
  const opened = resolveReportQuery('open this in the browser', { ...context, previous: narrowed.query });
  assert.equal(opened.query.surface, 'browser');
  assert.deepEqual(opened.query.period, prior.period);
  assert.deepEqual(opened.query.projects, narrowed.query.projects);
});

test('presentation and project follow-ups preserve a behavior or comparison report kind', () => {
  const prior = resolveReportQuery('Compare ShareView this week with last week', context).query;
  const narrowed = resolveReportQuery('only Rex', { ...context, previous: prior }).query;
  assert.equal(narrowed.kind, 'comparison');
  assert.deepEqual(narrowed.comparePeriod, prior.comparePeriod);
  assert.equal(resolveReportQuery('open this in the browser', { ...context, previous: narrowed }).query.kind, 'comparison');
});

test('session drill-down requires a prior finding reference', () => {
  const first = resolveReportQuery('show the sessions behind that finding', context);
  assert.equal(first.status, 'clarification');
  const prior = { ...resolveReportQuery('Show usage this week', context).query, findingId: 'finding-7' };
  const follow = resolveReportQuery('show the sessions behind that finding', { ...context, previous: prior });
  assert.equal(follow.status, 'resolved');
  assert.equal(follow.query.kind, 'sessions');
  assert.equal(follow.query.findingId, 'finding-7');
  assert.deepEqual(follow.query.period, prior.period);
});

test('content analysis requires explicit opt-in and persists in follow-up context', () => {
  const ordinary = resolveReportQuery('Which habits keep wasting time?', context);
  assert.equal(ordinary.query.contentAnalysis, false);
  const opted = resolveReportQuery('Analyze transcript content for recurring habits, including quoted evidence', context);
  assert.equal(opted.query.contentAnalysis, true);
  const next = resolveReportQuery('only ShareView', { ...context, previous: opted.query });
  assert.equal(next.query.contentAnalysis, true);
  const off = resolveReportQuery('switch to metrics only', { ...context, previous: next.query });
  assert.equal(off.query.contentAnalysis, false);
});

test('clarifies material ambiguity and unsupported named project', () => {
  assert.equal(resolveReportQuery('Show usage for Atlas last month', context).status, 'clarification');
  assert.equal(resolveReportQuery('compare that with last month', context).status, 'clarification');
  assert.equal(resolveReportQuery('Show all my usage sometime recently', context).status, 'clarification');
});

test('does not invent a range for an unqualified request', () => {
  const result = resolveReportQuery('How much did I use?', context);
  assert.equal(result.status, 'resolved');
  assert.equal(result.query.period, null);
  assert.equal(result.query.history, 'all-available');
});

test('collector options retain explicit project filtering and exclusive periods', () => {
  const query = resolveReportQuery('Show ShareView last month', context).query;
  assert.deepEqual(collectorOptions(query, '/some/claude/root'), [{
    root: '/some/claude/root', from: '2026-08-01T07:00:00.000Z',
    to: '2026-09-01T07:00:00.000Z', project: '-Users-david-Developer-ShareView',
  }]);
});

test('calendar bounds follow daylight saving changes', () => {
  const result = resolveReportQuery('Show usage 2026-03-08', context);
  assert.deepEqual(result.query.period, {
    from: '2026-03-08T08:00:00.000Z', to: '2026-03-09T07:00:00.000Z',
  });
});
