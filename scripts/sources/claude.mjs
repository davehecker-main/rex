import { join } from 'node:path';
import { readdirSync, readFileSync, statSync } from 'node:fs';
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
    limit: 'Local transcript rows; deduplicated request accounting comes from the Claude accounting collector.',
    facts: (rows) => {
      const metrics = { questions: 0, agentLaunches: 0, toolErrors: 0, classifierDenials: 0,
        hookRuns: 0, hookDurationMs: 0 };
      for (const row of rows) {
        if (row.type === 'system' && row.subtype === 'stop_hook_summary') {
          metrics.hookRuns += Number(row.hookCount) || 0;
          for (const hook of row.hookInfos ?? []) metrics.hookDurationMs += Number(hook.durationMs) || 0;
        }
        if (row.type === 'system' && /classifier.*den/i.test(row.subtype ?? '')) metrics.classifierDenials++;
        for (const block of Array.isArray(row.message?.content) ? row.message.content : []) {
          if (block.type === 'tool_use' && block.name === 'AskUserQuestion') metrics.questions++;
          if (block.type === 'tool_use' && ['Task', 'Agent'].includes(block.name)) metrics.agentLaunches++;
          if (block.type === 'tool_result' && block.is_error === true) metrics.toolErrors++;
        }
      }
      return metrics;
    } });
  try {
    const usage = collectUsage({ root, from, to });
    projects.facts = { ...projects.facts, requests: usage.summary.requests, humanTurns: usage.summary.humanTurns,
      toolCalls: usage.summary.toolCalls, interruptions: usage.summary.interruptions,
      subagentRequests: usage.summary.subagentRequests,
      tokens: usage.summary.tokens };
  } catch { projects.coverage.status = 'unparseable'; }
  const settings = snapshot('settings', 'settings.json', 'current permission and hook policy', 'Policy snapshot, not observed behavior.');
  const policy = (path) => {
    try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
  };
  const current = policy(join(root, 'settings.json'));
  const rules = (data) => new Set(Object.values(data?.permissions ?? {}).flat().filter((value) => typeof value === 'string'));
  settings.facts = { permissionRules: current ? rules(current).size : null,
    hookEvents: current ? Object.keys(current.hooks ?? {}).length : null };
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
  let changedPermissionRules = 0;
  let changedHookEvents = 0;
  for (const path of backup.coverage.files ? backupFiles.flatMap((item) => item.files) : []) {
    const previous = policy(path);
    const before = rules(previous); const after = rules(current);
    changedPermissionRules += [...before].filter((rule) => !after.has(rule)).length +
      [...after].filter((rule) => !before.has(rule)).length;
    const priorHooks = new Set(Object.keys(previous?.hooks ?? {}));
    const activeHooks = new Set(Object.keys(current?.hooks ?? {}));
    changedHookEvents += [...priorHooks].filter((event) => !activeHooks.has(event)).length +
      [...activeHooks].filter((event) => !priorHooks.has(event)).length;
  }
  backup.facts.changedPermissionRules = changedPermissionRules;
  backup.facts.changedHookEvents = changedHookEvents;
  const stats = snapshot('stats-cache', 'stats-cache.json', 'cached daily statistics', 'Cached snapshot can be stale; compare its mtime before using figures.');
  try { stats.facts.mtime = statSync(join(root, 'stats-cache.json')).mtime.toISOString(); }
  catch { stats.facts.mtime = null; }
  stats.facts.stale = stats.facts.mtime ? Date.now() - Date.parse(stats.facts.mtime) > 24 * 3600_000 : null;
  const state = snapshot('state', 'state', 'titles, grants and interruption state', 'Current state and secret grant metadata; values are suppressed.');
  const stateFiles = discover(join(root, 'state'));
  state.facts = { titles: stateFiles.files.filter((path) => path.includes('/session-title/')).length,
    secretGrantFiles: stateFiles.files.filter((path) => path.includes('/secret-grants/')).length,
    interruptionFiles: stateFiles.files.filter((path) => path.includes('/interruption-log/')).length };
  const telemetry = event('telemetry', 'telemetry', 'failed event spools and timing', 'Failed-event spool, not an event census.',
    (r) => r.timestamp ?? r.event_data?.client_timestamp);
  telemetry.facts = { failedEventRows: telemetry.coverage.rowsInWindow };
  const jobs = recordsSource({ id: 'claude.jobs', path: join(root, 'jobs'), extensions: ['timeline.jsonl'],
    kind: 'event', dataHeld: 'job lifecycle events', limit: 'Timeline events, not a complete execution census.',
    from, to, timestamp: (row) => row.at ?? row.timestamp,
    facts: (rows) => ({ events: rows.length, completed: rows.filter((row) => row.state === 'done').length,
      failed: rows.filter((row) => row.state === 'failed').length }) });
  const jobState = snapshot('job-state', 'jobs', 'current job state', 'Current snapshot; timeline events are counted separately.');
  return [projects,
    event('history', 'history.jsonl', 'prompt and command history', 'History may omit sessions and is not a complete prompt census.', (r) => r.timestamp),
    stats,
    settings, backup,
    state, telemetry, jobs, jobState,
    snapshot('feedback', 'feedback/drafts', 'feedback draft counts', 'Draft content is private and omitted.', null),
  ];
}
