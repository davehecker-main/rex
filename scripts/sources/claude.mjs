import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { discover, coverage, recordsSource } from './common.mjs';
import { collectUsage } from '../usage-accounting.mjs';

export function claudeSources(root, from, to) {
  const event = (id, path, dataHeld, limit, timestamp = (row) => row.timestamp) =>
    recordsSource({ id: `claude.${id}`, path: join(root, path), extensions: ['.jsonl', '.json'], kind: 'event', dataHeld, limit, from, to, timestamp });
  const snapshot = (id, path, dataHeld, limit, extensions = ['.json']) =>
    recordsSource({ id: `claude.${id}`, path: join(root, path), extensions, kind: 'snapshot', dataHeld, limit, from, to,
      facts: (_dated, all) => ({ documents: all.length }) });
  const projects = recordsSource({ id: 'claude.projects', path: join(root, 'projects'), extensions: ['.jsonl'],
    kind: 'event', dataHeld: 'turns, tools, usage, errors, subagents', from, to,
    timestamp: (row) => row.timestamp,
    limit: 'Local transcript rows; deduplicated request accounting comes from the Claude accounting collector.' });
  try {
    const usage = collectUsage({ root, from, to });
    projects.facts = { requests: usage.summary.requests, humanTurns: usage.summary.humanTurns,
      toolCalls: usage.summary.toolCalls, interruptions: usage.summary.interruptions,
      subagentRequests: usage.summary.subagentRequests,
      tokens: usage.summary.tokens };
  } catch { projects.coverage.status = 'unparseable'; }
  const settings = snapshot('settings', 'settings.json', 'current permission and hook policy', 'Policy snapshot, not observed behavior.');
  let backupNames = [];
  try { backupNames = readdirSync(root).filter((name) => /^settings\.json\.bak/.test(name)); }
  catch { /* Root coverage is represented by the main settings row. */ }
  const backupFiles = backupNames.map((name) => discover(join(root, name)));
  const backup = { id: 'claude.settings-backups', kind: 'snapshot',
    dataHeld: 'previous permission and hook policy', limit: 'Backup snapshots, not observed behavior.',
    coverage: coverage({ files: backupFiles.flatMap((item) => item.files), missing: backupFiles.reduce((n, item) => n + item.missing, 0),
      dangling: backupFiles.reduce((n, item) => n + item.dangling, 0), unreadable: backupFiles.reduce((n, item) => n + item.unreadable, 0) }),
    facts: {} };
  backup.facts = { documents: backup.coverage.files };
  return [projects,
    event('history', 'history.jsonl', 'prompt and command history', 'History may omit sessions and is not a complete prompt census.', (r) => r.timestamp),
    snapshot('stats-cache', 'stats-cache.json', 'cached daily statistics', 'Cached snapshot can be stale; compare its mtime before using figures.'),
    settings, backup,
    snapshot('state', 'state', 'titles, grants and interruption state', 'Current state and secret grant metadata; values are suppressed.'),
    event('telemetry', 'telemetry', 'failed event spools and timing', 'Failed-event spool, not an event census.', (r) => r.timestamp ?? r.event_data?.client_timestamp),
    snapshot('jobs', 'jobs', 'job lifecycles', 'Local job state, not a complete execution log.'),
    snapshot('feedback', 'feedback/drafts', 'feedback draft counts', 'Draft content is private and omitted.', null),
  ];
}
