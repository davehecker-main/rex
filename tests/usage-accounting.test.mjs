import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectUsage, priceUsage, rateCard } from '../scripts/usage-accounting.mjs';

const usage = (output = 20) => ({
  input_tokens: 10,
  output_tokens: output,
  cache_creation_input_tokens: 30,
  cache_read_input_tokens: 40,
  cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 10 },
  service_tier: 'standard',
});
const row = (id, requestId, output = 20, extra = {}) => ({
  type: 'assistant', uuid: id, requestId, sessionId: 'session-a',
  timestamp: '2026-09-22T10:00:00.000Z',
  message: { id: `msg-${requestId}`, model: 'claude-opus-5', usage: usage(output) },
  ...extra,
});
const writeRows = (path, rows) => writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

test('counts one request across repeated content rows, resumed copies, and subagents', () => {
  const root = mkdtempSync(join(tmpdir(), 'rex-accounting-'));
  try {
    const project = join(root, 'projects', 'project-a');
    const subagents = join(project, 'session-a', 'subagents');
    mkdirSync(subagents, { recursive: true });
    writeRows(join(project, 'session-a.jsonl'), [row('u1', 'req-1', 5), row('u2', 'req-1', 20)]);
    writeRows(join(project, 'resumed.jsonl'), [row('u2', 'req-1', 20)]);
    writeRows(join(subagents, 'agent-1.jsonl'), [row('u3', 'req-2', 10, { isSidechain: true })]);
    const result = collectUsage({ root });
    assert.equal(result.summary.requests, 2);
    assert.equal(result.summary.tokens.output, 30);
    assert.equal(result.summary.subagentRequests, 1);
    assert.equal(result.coverage.duplicateRows, 2);
    assert.equal(result.coverage.files, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('filters by request timestamp and reports malformed and unpriced rows as coverage gaps', () => {
  const root = mkdtempSync(join(tmpdir(), 'rex-accounting-'));
  try {
    const project = join(root, 'projects', 'project-a');
    mkdirSync(project, { recursive: true });
    const unknown = row('u4', 'req-4', 2);
    unknown.message.model = 'claude-unknown';
    writeFileSync(join(project, 'session-a.jsonl'), [JSON.stringify(row('u1', 'req-1')), '{bad', JSON.stringify(unknown)].join('\n'));
    const result = collectUsage({ root, from: '2026-09-22', to: '2026-09-23' });
    assert.equal(result.summary.requests, 2);
    assert.equal(result.coverage.malformedLines, 1);
    assert.equal(result.coverage.unpricedRequests, 1);
    assert.equal(result.summary.apiEquivalentUsd, null);
    assert.ok(result.summary.knownApiEquivalentUsd > 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('prices input, output, cache writes, and cache reads without double counting cache tokens', () => {
  const result = priceUsage('claude-opus-5', usage(), { speed: 'standard', inference_geo: 'not_available' });
  assert.equal(result.status, 'priced');
  assert.equal(result.usd, (10 * 5 + 20 * 25 + 20 * 6.25 + 10 * 10 + 40 * .5) / 1e6);
  assert.equal(priceUsage('claude-opus-5', { ...usage(), cache_creation: undefined }).status, 'unknown-cache-split');
  assert.equal(priceUsage('unknown-model', usage()).status, 'unknown-model');
});

test('preserves unsplit cache-write tokens when their price is unknown', () => {
  const root = mkdtempSync(join(tmpdir(), 'rex-accounting-'));
  try {
    const project = join(root, 'projects', 'project-a');
    mkdirSync(project, { recursive: true });
    const incomplete = row('u1', 'req-1');
    delete incomplete.message.usage.cache_creation;
    writeRows(join(project, 'session-a.jsonl'), [incomplete]);
    const result = collectUsage({ root });
    assert.equal(result.summary.tokens.cacheWriteUnknown, 30);
    assert.equal(result.coverage.unpricedByReason['unknown-cache-split'], 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('counts session turns, tool calls and interruptions once across overlapping transcripts', () => {
  const root = mkdtempSync(join(tmpdir(), 'rex-accounting-'));
  try {
    const project = join(root, 'projects', 'project-a');
    mkdirSync(project, { recursive: true });
    const user = { type: 'user', uuid: 'human-1', sessionId: 'session-a', timestamp: '2026-09-22T09:00:00Z', message: { content: 'hello' } };
    const interrupt = { ...user, uuid: 'interrupt-1', message: { content: '[Request interrupted by user]' } };
    const assistant = { ...row('assistant-1', 'req-1'), message: {
      ...row('assistant-1', 'req-1').message,
      content: [{ type: 'text', text: 'Done.' }, { type: 'tool_use', id: 'tool-1', name: 'Bash' }],
    } };
    writeRows(join(project, 'session-a.jsonl'), [user, assistant, interrupt]);
    writeRows(join(project, 'resume.jsonl'), [user, assistant]);
    const result = collectUsage({ root });
    assert.equal(result.summary.humanTurns, 1);
    assert.equal(result.summary.assistantTurns, 1);
    assert.equal(result.summary.toolCalls, 1);
    assert.equal(result.summary.interruptions, 1);
    assert.equal(result.summary.assistantProseCharacters, 5);
    assert.equal(result.groups.bySession[0].toolCalls, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('keeps aggregate cost unknown when a transcript contains missing usage', () => {
  const root = mkdtempSync(join(tmpdir(), 'rex-accounting-'));
  try {
    const project = join(root, 'projects', 'project-a');
    mkdirSync(project, { recursive: true });
    writeRows(join(project, 'session-a.jsonl'), [row('u1', 'req-1'), {
      type: 'assistant', uuid: 'u2', requestId: 'req-2', sessionId: 'session-a',
      timestamp: '2026-09-22T11:00:00Z', message: { id: 'msg-2', model: 'claude-opus-5', content: [] },
    }]);
    const result = collectUsage({ root });
    assert.equal(result.coverage.rowsWithoutUsage, 1);
    assert.equal(result.summary.apiEquivalentUsd, null);
    assert.equal(result.summary.requests, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('uses an inclusive start and exclusive end for overlapping session dates', () => {
  const root = mkdtempSync(join(tmpdir(), 'rex-accounting-'));
  try {
    const project = join(root, 'projects', 'project-a');
    mkdirSync(project, { recursive: true });
    const first = row('u1', 'req-1');
    first.timestamp = '2026-09-22T00:00:00Z';
    const last = row('u2', 'req-2');
    last.timestamp = '2026-09-23T00:00:00Z';
    last.sessionId = 'session-b';
    writeRows(join(project, 'session-a.jsonl'), [first, last]);
    const result = collectUsage({ root, from: '2026-09-22', to: '2026-09-23' });
    assert.equal(result.summary.requests, 1);
    assert.equal(result.requests[0].requestId, 'req-1');
    assert.equal(result.groups.bySession.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('dates API-equivalent rates and never presents an unknown model as actual spend', () => {
  assert.equal(rateCard.asOf, '2026-09-23');
  assert.match(rateCard.source, /^https:\/\/platform\.claude\.com\//);
  assert.equal(priceUsage('unknown-model', usage()).usd, null);
  assert.equal(priceUsage('claude-opus-5', usage(), { speed: 'fast' }).usd, null);
});

test('dated model IDs are normalized once for pricing, model filters, and grouping; unknown models stay unknown', () => {
  const root = mkdtempSync(join(tmpdir(), 'rex-accounting-'));
  try {
    const project = join(root, 'projects', 'project-a');
    mkdirSync(project, { recursive: true });
    const dated = row('u1', 'req-1'); dated.message.model = 'claude-haiku-4-5-20251001';
    const unknown = row('u2', 'req-2'); unknown.message.model = 'claude-unknown-20251001';
    writeRows(join(project, 'session-a.jsonl'), [dated, unknown]);
    const all = collectUsage({ root });
    assert.deepEqual(all.groups.byModel.map((entry) => entry.key).sort(), ['claude-haiku-4-5', 'claude-unknown-20251001']);
    assert.equal(all.coverage.unpricedRequests, 1);
    const haiku = collectUsage({ root, models: ['claude-haiku-4-5'] });
    assert.equal(haiku.summary.requests, 1);
    assert.equal(haiku.summary.apiEquivalentUsd, priceUsage('claude-haiku-4-5', usage()).usd);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a dated model filter matches rows the same way as the rate-card ID', () => {
  const root = mkdtempSync(join(tmpdir(), 'rex-accounting-'));
  try {
    const project = join(root, 'projects', 'project-a');
    mkdirSync(project, { recursive: true });
    const dated = row('u1', 'req-1'); dated.message.model = 'claude-haiku-4-5-20251001';
    writeRows(join(project, 'session-a.jsonl'), [dated, row('u2', 'req-2')]);
    assert.equal(collectUsage({ root, models: ['claude-haiku-4-5-20251001'] }).summary.requests, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
