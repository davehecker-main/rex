import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { discover, coverage, recordsSource, parseRecords, within } from './common.mjs';

const modelName = (value) => typeof value === 'string' && /^(gpt|o[1-9]|codex)[a-z0-9.-]*$/i.test(value) ? value : 'other';
const effortName = (value) => ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value) ? value : 'other';

export function collectCodexTokens(root, from, to) {
  const tokens = { input: 0, output: 0, reasoningOutputSubset: 0 };
  const seen = new Set(); let missingIds = 0; let files = 0;
  for (const dir of ['sessions', 'archived_sessions']) {
    for (const file of discover(join(root, dir), ['.jsonl']).files) {
      files++;
      let rows;
      try { rows = parseRecords(file).records; } catch { continue; }
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row.type !== 'token_usage_record' || !within(row.timestamp, from, to)) continue;
        const payload = row.payload ?? {};
        const id = payload.response_id && (payload.session_id || payload.thread_id)
          ? `${payload.session_id ?? payload.thread_id}:${payload.response_id}` : null;
        if (!id) missingIds++;
        const key = id ?? `${file}:${i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const usage = payload.usage ?? {};
        tokens.input += Number(usage.input_tokens) || 0;
        tokens.output += Number(usage.output_tokens) || 0;
        tokens.reasoningOutputSubset += Number(usage.reasoning_output_tokens) || 0;
      }
    }
  }
  return { tokens: files ? tokens : null, coverage: { files, recordsWithoutDedupeId: missingIds } };
}

export function codexSources(root, from, to) {
  const event = (id, path, dataHeld, limit, facts) => recordsSource({
    id: `codex.${id}`, path: join(root, path), extensions: ['.jsonl', '.json'], kind: 'event',
    dataHeld, limit, from, to, timestamp: (r) => r.timestamp ?? r.ts, facts,
  });
  const sessionFacts = (rows) => {
    let completedTurns = 0; let aborts = 0; let launches = 0;
    let durationMs = 0; let firstTokenLatencyMs = 0; let latencySamples = 0;
    const origins = {}; const observedModels = {}; const observedEfforts = {};
    for (const row of rows) {
      if (row.type === 'event_msg' && row.payload?.type === 'task_complete') {
        completedTurns++;
        durationMs += Number(row.payload.duration_ms) || 0;
        if (Number.isFinite(row.payload.time_to_first_token_ms)) {
          firstTokenLatencyMs += row.payload.time_to_first_token_ms;
          latencySamples++;
        }
      }
      if (row.type === 'event_msg' && /abort|cancel/.test(row.payload?.type ?? '')) aborts++;
      if (row.type === 'session_meta') {
        launches++;
        const origin = row.payload?.source || row.payload?.originator || 'unknown';
        const rawCategory = typeof origin === 'string' ? origin : origin?.subagent ? 'spawned' : origin?.type ?? 'unknown';
        const category = rawCategory === 'vscode' ? 'ide' :
          /^(cli|exec|ide|guardian|spawned|mcp|unknown)$/i.test(rawCategory) ? rawCategory.toLowerCase() : 'other';
        origins[category] = (origins[category] ?? 0) + 1;
      }
      if (row.type === 'turn_context') {
        const model = modelName(row.payload?.model); observedModels[model] = (observedModels[model] ?? 0) + 1;
        const effort = effortName(row.payload?.effort); observedEfforts[effort] = (observedEfforts[effort] ?? 0) + 1;
      }
    }
    return { completedTurns, aborts, launches, origins, observedModels, observedEfforts,
      durationMs, firstTokenLatencyMs, latencySamples };
  };
  const sessions = event('sessions', 'sessions', 'tokens, turns, origins and aborts',
    'Session facts exclude tokens. Use the deduplicated Codex provider token table; MCP is an invocation source, not necessarily a separate user session.', sessionFacts);
  const archived = event('archived-sessions', 'archived_sessions', 'archived session events',
    'Archives can overlap live sessions. Session facts exclude tokens; use the deduplicated Codex provider token table.', sessionFacts);
  const history = event('history', 'history.jsonl', 'prompt history', 'History is not a complete session census.', (rows) => ({ entries: rows.length }));
  const configFound = discover(join(root, 'config.toml'));
  let configuredModel = null; let configuredEffort = null;
  try {
    const toml = readFileSync(join(root, 'config.toml'), 'utf8');
    const model = toml.match(/^model\s*=\s*"([^"]+)"/m)?.[1];
    const effort = toml.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1];
    if (model) configuredModel = modelName(model);
    if (effort) configuredEffort = effortName(effort);
  } catch { /* Config coverage already records the missing path. */ }
  const config = { id: 'codex.config', kind: 'snapshot', dataHeld: 'configured model and effort',
    limit: 'Configured snapshot, not observed model or effort; values omitted.',
    coverage: coverage(configFound), facts: { configuredModelPresent: configuredModel !== null,
      configuredEffortPresent: configuredEffort !== null,
      observedModelMatchesConfig: configuredModel && configuredModel !== 'other'
        ? Boolean(sessions.facts.observedModels[configuredModel]) : null,
      observedEffortMatchesConfig: configuredEffort && configuredEffort !== 'other'
        ? Boolean(sessions.facts.observedEfforts[configuredEffort]) : null } };
  const sqlite = [
    ['logs', 'logs_2.sqlite', 'log severity counts'], ['goals', 'goals_1.sqlite', 'goal rows'],
    ['queue', 'queue_1.sqlite', 'queue rows'], ['memories', 'memories_1.sqlite', 'memory rows'],
  ].map(([id, filename, dataHeld]) => sqliteSource(`codex.${id}`, join(root, filename), dataHeld));
  return [sessions, archived, history, ...sqlite, config];
}

function sqliteSource(id, path, dataHeld) {
  const found = discover(path);
  let rows = 0; let unparseable = 0; let tables = 0;
  const facts = {};
  for (const file of found.files) {
    let db;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
      if (!names.length) unparseable++;
      tables += names.length;
      for (const { name } of names) {
        const quoted = `"${name.replaceAll('"', '""')}"`;
        rows += Number(db.prepare(`SELECT COUNT(*) AS n FROM ${quoted}`).get().n);
      }
      const namesSet = new Set(names.map((row) => row.name));
      if (id === 'codex.logs' && namesSet.has('logs')) {
        const severities = {};
        for (const row of db.prepare('SELECT level, COUNT(*) AS n FROM logs GROUP BY level').all()) {
          const level = /^(trace|debug|info|warn|error)$/i.test(row.level) ? row.level.toLowerCase() : 'other';
          severities[level] = (severities[level] ?? 0) + Number(row.n);
        }
        facts.severities = severities;
      }
      if (id === 'codex.goals' && namesSet.has('thread_goals')) {
        const statuses = {};
        for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM thread_goals GROUP BY status').all()) {
          const status = /^(active|paused|blocked|usage_limited|budget_limited|complete)$/.test(row.status) ? row.status : 'other';
          statuses[status] = (statuses[status] ?? 0) + Number(row.n);
        }
        facts.statuses = statuses;
      }
      if (id === 'codex.queue' && namesSet.has('queued_items')) {
        facts.queuedItems = Number(db.prepare('SELECT COUNT(*) AS n FROM queued_items').get().n);
      }
      if (id === 'codex.memories') facts.memoryRows = rows;
    } catch { unparseable++; }
    finally { db?.close(); }
  }
  return { id, kind: 'snapshot', dataHeld, limit: 'Current read-only SQLite snapshot; row counts only, contents omitted.',
    coverage: coverage(found, { rows, unparseable }), facts: { tables, ...facts } };
}
