import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReportView, renderReportHtml, renderReportTerminal } from '../scripts/report-view.mjs';
import { chooseReportSurface, deliverReport } from '../scripts/report-browser.mjs';

const sample = () => ({
  basis: { source: 'Claude Code local transcripts', from: '2026-09-01', toExclusive: '2026-10-01',
    priceAsOf: '2026-09-23', priceSource: 'https://example.test/prices',
    costMeaning: 'API-equivalent estimate, not subscription spend' },
  summary: { requests: 2, subagentRequests: 1, humanTurns: 1, assistantTurns: 2, toolCalls: 3,
    interruptions: 0, assistantProseCharacters: 50, tokens: { input: 10, output: 20,
      cacheWrite5m: 3, cacheWrite1h: 4, cacheRead: 5, cacheWriteUnknown: 0 },
    knownApiEquivalentUsd: .012, apiEquivalentUsd: null },
  coverage: { files: 2, unreadableFiles: 0, malformedLines: 1, assistantRows: 3,
    rowsWithoutUsage: 1, undatedRows: 0, duplicateRows: 1, unpricedRequests: 1,
    unpricedByReason: { 'unknown-model': 1 } },
  groups: {
    byDate: [{ key: '2026-09-22', requests: 2, tokens: { input: 10, output: 20 }, knownApiEquivalentUsd: .012, unpricedRequests: 1 }],
    byModel: [{ key: 'model-x', requests: 2, tokens: { input: 10, output: 20 }, knownApiEquivalentUsd: .012, unpricedRequests: 1 }],
    byProject: [{ key: 'project-<script>alert(1)</script>', requests: 2, tokens: { input: 10, output: 20 }, knownApiEquivalentUsd: .012, unpricedRequests: 1 }],
    bySession: [{ key: 'session-1', requests: 2, tokens: { input: 10, output: 20 }, knownApiEquivalentUsd: .012, unpricedRequests: 1,
      humanTurns: 1, assistantTurns: 2, toolCalls: 3, interruptions: 0 }],
  },
  requests: [{ requestId: 'secret-transcript-marker', session: 'session-1', project: 'project-<script>alert(1)</script>', date: '2026-09-22', model: 'model-x' }],
});

test('shared view exposes scope, totals, uncertainty, groups, and supporting sessions without requests', () => {
  const view = buildReportView(sample());
  assert.equal(view.scope.timezone, 'UTC');
  assert.equal(view.scope.sessions, 1);
  assert.equal(view.cost.status, 'incomplete');
  assert.equal(view.cost.actualSpendingUsd, null);
  assert.deepEqual(view.sections.map((x) => x.id), ['date', 'model', 'project', 'session']);
  assert.equal(view.sections[3].rows[0].key, 'session-1');
  assert.doesNotMatch(JSON.stringify(view), /secret-transcript-marker/);
});

test('HTML and terminal use the same view and disclose gaps without raw content', () => {
  const view = buildReportView(sample());
  const html = renderReportHtml(view);
  const terminal = renderReportTerminal(view);
  for (const output of [html, terminal]) {
    assert.match(output, /session-1/);
    assert.match(output, /unknown-model/);
    assert.match(output, /not subscription spend/);
    assert.doesNotMatch(output, /secret-transcript-marker/);
  }
  assert.match(html, /project-&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /type="search"/);
  assert.match(html, /class="chart"/);
  assert.match(html, /href="#session-0"/);
  assert.match(html, /<details id="session-0"/);
  assert.match(html, /human turns: 1/);
  assert.match(terminal, /Supporting sessions/);
});

test('comparison is explicit and cannot turn an unknown full cost into a known delta', () => {
  const view = buildReportView(sample(), { compareTo: sample() });
  assert.equal(view.comparison.requestsDelta, 0);
  assert.equal(view.comparison.apiEquivalentUsdDelta, null);
  assert.match(renderReportHtml(view), /Comparison/);
});

test('browser is the safe default and explicit terminal falls back when unsupported', () => {
  assert.deepEqual(chooseReportSurface({}), { surface: 'browser', notice: null });
  assert.equal(chooseReportSurface({ preference: 'terminal', terminalSupported: true }).surface, 'terminal');
  assert.equal(chooseReportSurface({ preference: 'terminal', terminalSupported: false }).surface, 'browser');
  assert.match(chooseReportSurface({ preference: 'terminal', terminalSupported: false }).notice, /unavailable/);
});

test('delivery creates a private browser artifact or writes a terminal report', () => {
  const root = mkdtempSync(join(tmpdir(), 'rex-view-test-'));
  try {
    const opened = [];
    const browser = deliverReport(buildReportView(sample()), { outputDir: root, openBrowser: (url) => opened.push(url) });
    assert.equal(browser.surface, 'browser');
    assert.equal(opened.length, 1);
    assert.match(readFileSync(browser.path, 'utf8'), /Supporting sessions/);
    assert.equal(statSync(browser.path).mode & 0o777, 0o600);
    const written = [];
    const terminal = deliverReport(buildReportView(sample()), { preference: 'terminal', terminalSupported: true,
      writeTerminal: (text) => written.push(text) });
    assert.equal(terminal.surface, 'terminal');
    assert.match(written[0], /Supporting sessions/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
