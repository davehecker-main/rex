import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { discover, coverage, recordsSource } from './common.mjs';

export function codexSources(root, from, to) {
  const event = (id, path, dataHeld, limit, facts) => recordsSource({
    id: `codex.${id}`, path: join(root, path), extensions: ['.jsonl', '.json'], kind: 'event',
    dataHeld, limit, from, to, timestamp: (r) => r.timestamp ?? r.ts, facts,
  });
  const sessionFacts = (rows) => {
    const tokens = { input: 0, output: 0, reasoningOutputSubset: 0 };
    let completedTurns = 0; let aborts = 0; let launches = 0;
    let durationMs = 0; let firstTokenLatencyMs = 0; let latencySamples = 0;
    const origins = {};
    for (const row of rows) {
      if (row.type === 'token_usage_record') {
        const usage = row.payload?.usage ?? {};
        tokens.input += Number(usage.input_tokens) || 0;
        tokens.output += Number(usage.output_tokens) || 0;
        tokens.reasoningOutputSubset += Number(usage.reasoning_output_tokens) || 0;
      }
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
        const rawCategory = typeof origin === 'string' ? origin : origin?.type ?? 'unknown';
        const category = /^(cli|exec|ide|guardian|spawned|unknown)$/i.test(rawCategory) ? rawCategory.toLowerCase() : 'other';
        origins[category] = (origins[category] ?? 0) + 1;
      }
    }
    return { tokens, completedTurns, aborts, launches, origins, durationMs, firstTokenLatencyMs, latencySamples };
  };
  const sessions = event('sessions', 'sessions', 'tokens, turns, origins and aborts',
    'Codex usage convention; cached input is included in input, reasoning output in output. Do not add Claude tokens.', sessionFacts);
  const archived = event('archived-sessions', 'archived_sessions', 'archived session events',
    'Archives can overlap live sessions; do not add provider totals without deduplication.', sessionFacts);
  const history = event('history', 'history.jsonl', 'prompt history', 'History is not a complete session census.', (rows) => ({ entries: rows.length }));
  const configFound = discover(join(root, 'config.toml'));
  const config = { id: 'codex.config', kind: 'snapshot', dataHeld: 'configured model and effort',
    limit: 'Configured snapshot, not observed model or effort; values omitted.',
    coverage: coverage(configFound), facts: {} };
  const sqlite = [
    ['logs', 'logs_2.sqlite', 'log severity counts'], ['goals', 'goals_1.sqlite', 'goal rows'],
    ['queue', 'queue_1.sqlite', 'queue rows'], ['memories', 'memories_1.sqlite', 'memory rows'],
  ].map(([id, filename, dataHeld]) => sqliteSource(`codex.${id}`, join(root, filename), dataHeld));
  return [sessions, archived, history, ...sqlite, config];
}

function sqliteSource(id, path, dataHeld) {
  const found = discover(path);
  let rows = 0; let unparseable = 0; let tables = 0;
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
    } catch { unparseable++; }
    finally { db?.close(); }
  }
  return { id, kind: 'snapshot', dataHeld, limit: 'Current read-only SQLite snapshot; row counts only, contents omitted.',
    coverage: coverage(found, { rows, unparseable }), facts: { tables } };
}
