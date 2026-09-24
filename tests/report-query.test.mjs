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

test('previous month follow-up is relative to the report month, not today', () => {
  const prior = resolveReportQuery('Show ShareView usage last month', context).query;
  const result = resolveReportQuery('compare that with the previous month', { ...context, previous: prior });
  assert.deepEqual(result.query.period, prior.period);
  assert.deepEqual(result.query.comparePeriod, { from: '2026-07-01T07:00:00.000Z', to: '2026-08-01T07:00:00.000Z' });
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

test('ambiguous finding follow-up asks for an ID and an explicit ID selects it', () => {
  const prior = { ...resolveReportQuery('Show usage this week', context).query,
    findingId: null, findingIds: ['rex-1', 'coverage'] };
  assert.equal(resolveReportQuery('show sessions behind that finding', { ...context, previous: prior }).status, 'clarification');
  const selected = resolveReportQuery('show sessions behind finding rex-1', { ...context, previous: prior });
  assert.equal(selected.status, 'resolved');
  assert.equal(selected.query.findingId, 'rex-1');
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
  assert.equal(resolveReportQuery('Show Claude Opus 6 usage', context).status, 'clarification');
  assert.equal(resolveReportQuery('Show GPT-5 usage', context).status, 'clarification');
  assert.equal(resolveReportQuery('Show Gemini 2.5 usage', context).status, 'clarification');
  assert.equal(resolveReportQuery('Show Claude Opus 5.1 usage', context).status, 'clarification');
  assert.equal(resolveReportQuery('Show Nova-7 usage', context).status, 'clarification');
  assert.equal(resolveReportQuery('Show o3 usage', context).status, 'clarification');
  assert.equal(resolveReportQuery('Show Titan usage', context).status, 'clarification');
  assert.equal(resolveReportQuery('Show Claude Mythos usage', context).status, 'clarification');
  assert.equal(resolveReportQuery('show titan tokens', context).status, 'clarification');
  assert.deepEqual(resolveReportQuery('Show ShareView usage', context).query.projects, ['-Users-david-Developer-ShareView']);
  assert.deepEqual(resolveReportQuery('Show Claude Opus 5 usage', context).query.models, ['claude-opus-5']);
});

test('does not invent a range for an unqualified request', () => {
  const result = resolveReportQuery('How much did I use?', context);
  assert.equal(result.status, 'resolved');
  assert.equal(result.query.period, null);
  assert.equal(result.query.history, 'all-available');
});

test('Rex as advisor is not silently treated as the Rex project', () => {
  const result = resolveReportQuery('Did the changes Rex recommended last month help?', context);
  assert.equal(result.status, 'resolved');
  assert.equal(result.query.kind, 'intervention');
  assert.deepEqual(result.query.projects, []);
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

test('worked-example request asks for discovered source inventory since installation', () => {
  const request = 'Write me a report of my usage since you were installed recently. The purpose of the report is not just to inform about usage, but to demonstrate every data type that is available to rex, not limited to the rex-generated logging. I am interested in efficiency, interruptions, permissions, token use, use of multi agents, limiting bloat, and other data that is aligned.';
  const resolved = resolveReportQuery(request, context);
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.query.kind, 'source-inventory');
  assert.equal(resolved.query.history, 'since-installed');
  assert.equal(resolved.query.period, null);
  assert.deepEqual(resolved.query.projects, []);
});

test('short form "report since you were installed" still recognizes the since-installed window without source wording', () => {
  const resolved = resolveReportQuery('report since you were installed', context);
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.query.history, 'since-installed');
  assert.equal(resolved.query.period, null);
});

test('a request that states its own scope replaces an inherited project, model, and period', () => {
  const prior = resolveReportQuery('Compare ShareView this week with last week for opus 5 tokens and cost.', context).query;
  for (const request of ['Show all my usage across every project for the last month.',
    'Show all my usage across all projects for the last month.', 'Show my usage for the last month.']) {
    const result = resolveReportQuery(request, { ...context, previous: prior });
    assert.deepEqual(result.query.projects, [], request);
    assert.deepEqual(result.query.models, [], request);
    assert.equal(result.query.comparePeriod, null, request);
  }
  const history = resolveReportQuery('Review all available history and tell me which habits keep wasting time.', { ...context, previous: prior });
  assert.deepEqual(history.query.projects, []);
  assert.equal(history.query.period, null);
  const intervention = resolveReportQuery('Did the changes Rex recommended last month help?', { ...context, previous: prior });
  assert.deepEqual(intervention.query.projects, []);
  assert.deepEqual(resolveReportQuery('Show all my usage.', { ...context, previous: prior }).query.projects, []);
  assert.deepEqual(resolveReportQuery('only ShareView', { ...context, previous: prior }).query.period, prior.period);
});

test('content opt-in does not carry into an unrelated later request', () => {
  const opted = resolveReportQuery('Analyze the session content for this week', context).query;
  assert.equal(opted.contentAnalysis, true);
  assert.equal(resolveReportQuery('Show my usage across all projects for this week.', { ...context, previous: opted }).query.contentAnalysis, false);
  assert.equal(resolveReportQuery('Show my usage', { ...context, previous: opted }).query.contentAnalysis, false);
  assert.equal(resolveReportQuery('open this in the browser', { ...context, previous: opted }).query.contentAnalysis, true);
});

test('drill-down keeps the prior scope and never matches project names against common words or finding IDs', () => {
  const projects = [...context.projects, { name: 'sessions', key: '-private-tmp-guard-live-two-sessions' },
    { name: '1', key: '-private-tmp-handoff-issue-1' }, { name: 'evidence', key: '-private-tmp-evidence' }];
  const prior = { ...resolveReportQuery('Show ShareView usage this week', { ...context, projects }).query,
    findingId: null, findingIds: ['rex-1', 'metric-toolCalls'] };
  for (const request of ['show the sessions behind finding rex-1', 'show the evidence behind finding rex-1']) {
    const result = resolveReportQuery(request, { ...context, projects, previous: prior });
    assert.equal(result.status, 'resolved', request);
    assert.equal(result.query.kind, 'sessions');
    assert.deepEqual(result.query.projects, prior.projects, request);
  }
  const single = resolveReportQuery('show the sessions behind that finding', { ...context, projects, previous: { ...prior, findingId: 'rex-1' } });
  assert.deepEqual(single.query.projects, prior.projects);
  assert.deepEqual(resolveReportQuery('Show usage for my sessions this week', { ...context, projects }).query.projects, []);
});
