import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, relative, sep } from 'node:path';

// Snapshot of first-party API rates, USD per million tokens, checked 2026-09-23.
// https://platform.claude.com/docs/en/about-claude/pricing
const RATE_CARD = {
  asOf: '2026-09-23',
  source: 'https://platform.claude.com/docs/en/about-claude/pricing',
  models: {
    'claude-opus-5-5': [4, 20, 5, 8, .2],
    'claude-opus-5': [5, 25, 6.25, 10, .5],
    'claude-opus-4-8': [5, 25, 6.25, 10, .5],
    'claude-opus-4-7': [5, 25, 6.25, 10, .5],
    'claude-opus-4-6': [5, 25, 6.25, 10, .5],
    'claude-opus-4-5': [5, 25, 6.25, 10, .5],
    'claude-sonnet-5': [2, 10, 2.5, 4, .2],
    'claude-sonnet-4-6': [3, 15, 3.75, 6, .3],
    'claude-sonnet-4-5': [3, 15, 3.75, 6, .3],
    'claude-haiku-4-5': [1, 5, 1.25, 2, .1],
    'claude-fable-5-1': [10, 50, 12.5, 20, .25],
    'claude-fable-5': [10, 50, 12.5, 20, 1],
  },
};

export const rateCard = RATE_CARD;

const count = (n) => Number.isSafeInteger(n) && n >= 0;
const pricedFields = ['input', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead'];
const tokenFields = [...pricedFields, 'cacheWriteUnknown'];
const emptyTokens = () => Object.fromEntries(tokenFields.map((key) => [key, 0]));

export function priceUsage(model, usage, context = {}) {
  const rates = RATE_CARD.models[model];
  if (!rates) return { status: 'unknown-model', usd: null };
  if (context.speed && context.speed !== 'standard') return { status: 'unknown-speed', usd: null };
  if (context.inference_geo && !['not_available', 'global'].includes(context.inference_geo)) {
    return { status: 'unknown-geography', usd: null };
  }
  if (usage?.service_tier && usage.service_tier !== 'standard') {
    return { status: 'unknown-service-tier', usd: null };
  }
  const writes = usage?.cache_creation;
  if (usage?.cache_creation_input_tokens && !writes) {
    return { status: 'unknown-cache-split', usd: null };
  }
  const tokens = {
    input: usage?.input_tokens,
    output: usage?.output_tokens,
    cacheWrite5m: writes?.ephemeral_5m_input_tokens ?? (usage?.cache_creation_input_tokens === 0 ? 0 : undefined),
    cacheWrite1h: writes?.ephemeral_1h_input_tokens ?? (usage?.cache_creation_input_tokens === 0 ? 0 : undefined),
    cacheRead: usage?.cache_read_input_tokens,
  };
  if (!Object.values(tokens).every(count)) return { status: 'incomplete-usage', usd: null };
  if (tokens.cacheWrite5m + tokens.cacheWrite1h !== usage.cache_creation_input_tokens) {
    return { status: 'inconsistent-cache-split', usd: null };
  }
  const usd = pricedFields.reduce((sum, field, i) => sum + tokens[field] * rates[i], 0) / 1e6;
  return { status: 'priced', usd, tokens };
}

function transcriptFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path);
    }
  };
  walk(join(root, 'projects'));
  return files.sort();
}

const time = (value) => {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : null;
};

function group(requests, key) {
  const map = new Map();
  for (const request of requests) {
    const name = request[key];
    const value = map.get(name) ?? { key: name, requests: 0, tokens: emptyTokens(), knownApiEquivalentUsd: 0, unpricedRequests: 0 };
    value.requests++;
    for (const field of tokenFields) value.tokens[field] += request.tokens[field];
    if (request.price.status === 'priced') value.knownApiEquivalentUsd += request.price.usd;
    else value.unpricedRequests++;
    map.set(name, value);
  }
  return [...map.values()].sort((a, b) => String(a.key).localeCompare(String(b.key)));
}

export function collectUsage({ root = join(homedir(), '.claude'), from, to, project } = {}) {
  const start = from ? time(from) : null;
  const end = to ? time(to) : null;
  if (from && start === null) throw new Error(`invalid from date: ${from}`);
  if (to && end === null) throw new Error(`invalid to date: ${to}`);
  if (start !== null && end !== null && start >= end) throw new Error('from must precede to');
  const coverage = { files: 0, unreadableFiles: 0, malformedLines: 0, assistantRows: 0, rowsWithoutUsage: 0, undatedRows: 0, duplicateRows: 0, unpricedRequests: 0, unpricedByReason: {} };
  const byId = new Map();
  const eventSeen = new Set();
  const eventRows = [];
  let files;
  try { files = transcriptFiles(root); }
  catch (error) {
    if (error.code === 'ENOENT') files = [];
    else throw error;
  }
  for (const path of files) {
    const rel = relative(join(root, 'projects'), path).split(sep);
    const projectName = rel[0];
    if (project && projectName !== project) continue;
    coverage.files++;
    let lines;
    try { lines = readFileSync(path, 'utf8').split('\n'); }
    catch { coverage.unreadableFiles++; continue; }
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      let row;
      try { row = JSON.parse(lines[i]); }
      catch { coverage.malformedLines++; continue; }
      const at = time(row.timestamp);
      if (at === null) { if (row.type === 'assistant' || row.type === 'user') coverage.undatedRows++; continue; }
      if ((start !== null && at < start) || (end !== null && at >= end)) continue;
      if (row.type === 'assistant' || row.type === 'user') {
        const eventId = row.uuid ? `${row.sessionId ?? projectName}:${row.uuid}` : `${path}:${i}`;
        if (!eventSeen.has(eventId)) {
          eventRows.push({ row, session: row.sessionId ?? rel[1]?.replace(/\.jsonl$/, '') ?? 'unknown', project: projectName,
            date: new Date(at).toISOString().slice(0, 10) });
          eventSeen.add(eventId);
        }
      }
      if (row.type !== 'assistant') continue;
      coverage.assistantRows++;
      if (!row.message?.usage) { coverage.rowsWithoutUsage++; continue; }
      const id = row.requestId ?? row.message.id ?? (row.uuid ? `${row.sessionId ?? basename(path)}:${row.uuid}` : `${path}:${i}`);
      const candidate = { id, session: row.sessionId ?? rel[1]?.replace(/\.jsonl$/, '') ?? 'unknown', project: projectName,
        date: new Date(at).toISOString().slice(0, 10), at, model: row.message.model ?? 'unknown',
        subagent: rel.includes('subagents') || row.isSidechain === true,
        usage: row.message.usage, score: (row.message.usage.output_tokens ?? 0) };
      if (byId.has(id)) coverage.duplicateRows++;
      if (!byId.has(id) || candidate.score > byId.get(id).score) byId.set(id, candidate);
    }
  }
  const requests = [...byId.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)).map((r) => {
    const price = priceUsage(r.model, r.usage, r.usage);
    const tokens = {
      input: r.usage.input_tokens ?? 0, output: r.usage.output_tokens ?? 0,
      cacheWrite5m: r.usage.cache_creation?.ephemeral_5m_input_tokens ?? 0,
      cacheWrite1h: r.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      cacheRead: r.usage.cache_read_input_tokens ?? 0,
      cacheWriteUnknown: Math.max(0, (r.usage.cache_creation_input_tokens ?? 0) -
        (r.usage.cache_creation?.ephemeral_5m_input_tokens ?? 0) -
        (r.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0)),
    };
    if (price.status !== 'priced') {
      coverage.unpricedRequests++;
      coverage.unpricedByReason[price.status] = (coverage.unpricedByReason[price.status] ?? 0) + 1;
    }
    return { requestId: r.id, session: r.session, project: r.project, date: r.date, model: r.model,
      subagent: r.subagent, tokens, price: { status: price.status, usd: price.usd } };
  });
  const tokens = emptyTokens();
  let knownApiEquivalentUsd = 0;
  for (const request of requests) {
    for (const field of tokenFields) tokens[field] += request.tokens[field];
    if (request.price.status === 'priced') knownApiEquivalentUsd += request.price.usd;
  }
  const behavior = { humanTurns: 0, assistantTurns: 0, toolCalls: 0, interruptions: 0, assistantProseCharacters: 0 };
  const sessionBehavior = new Map();
  const seenTurns = new Set();
  const seenTools = new Set();
  for (const { row, session } of eventRows) {
    const target = sessionBehavior.get(session) ?? { humanTurns: 0, assistantTurns: 0, toolCalls: 0, interruptions: 0, assistantProseCharacters: 0 };
    if (row.type === 'user') {
      const content = row.message?.content;
      const text = typeof content === 'string' ? content :
        Array.isArray(content) && !content.some((block) => block.type === 'tool_result')
          ? content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('') : null;
      if (text !== null && !row.isMeta) {
        if (/\[Request interrupted/i.test(text)) target.interruptions++;
        else target.humanTurns++;
      }
    } else {
      const turnId = `${session}:${row.message?.id ?? row.requestId ?? row.uuid}`;
      if (!seenTurns.has(turnId)) { target.assistantTurns++; seenTurns.add(turnId); }
      for (const block of row.message?.content ?? []) {
        if (block.type === 'text') target.assistantProseCharacters += block.text?.length ?? 0;
        if (block.type === 'tool_use') {
          const toolId = `${session}:${block.id ?? `${row.uuid}:${target.toolCalls}`}`;
          if (!seenTools.has(toolId)) { target.toolCalls++; seenTools.add(toolId); }
        }
      }
    }
    sessionBehavior.set(session, target);
  }
  for (const metrics of sessionBehavior.values()) {
    for (const key of Object.keys(behavior)) behavior[key] += metrics[key];
  }
  const bySession = group(requests, 'session');
  for (const entry of bySession) Object.assign(entry, sessionBehavior.get(entry.key));
  const incomplete = coverage.unpricedRequests || coverage.rowsWithoutUsage || coverage.malformedLines ||
    coverage.unreadableFiles || coverage.undatedRows;
  return {
    basis: { source: 'Claude Code local transcripts', priceAsOf: RATE_CARD.asOf, priceSource: RATE_CARD.source,
      costMeaning: 'first-party API-equivalent estimate at snapshot rates, not a Claude subscription charge',
      from: from ?? null, toExclusive: to ?? null },
    summary: { requests: requests.length, subagentRequests: requests.filter((r) => r.subagent).length,
      ...behavior, tokens, knownApiEquivalentUsd, apiEquivalentUsd: incomplete ? null : knownApiEquivalentUsd },
    coverage,
    groups: { byDate: group(requests, 'date'), byModel: group(requests, 'model'), byProject: group(requests, 'project'), bySession },
    requests,
  };
}
