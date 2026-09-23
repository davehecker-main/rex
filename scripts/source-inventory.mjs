import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { discover, coverage } from './sources/common.mjs';
import { claudeSources } from './sources/claude.mjs';
import { codexSources } from './sources/codex.mjs';

const systemCommand = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 3000, maxBuffer: 100_000 });
  return { status: result.status, stdout: result.stdout ?? '' };
};

export function collectSourceInventory({
  claudeRoot = join(homedir(), '.claude'), codexRoot = join(homedir(), '.codex'),
  shareViewRoot = join(homedir(), 'Developer', 'ShareView'), rexRoot = join(homedir(), 'Developer', 'rex'),
  from, to, command,
} = {}) {
  const run = command ?? ((name) => name === 'chattr state' ? systemCommand('chattr', ['state']) :
    systemCommand('git', ['-C', rexRoot, 'log', '--reverse', '--format=%cI', '--', 'scripts/install.sh']));
  const sources = [...claudeSources(claudeRoot, from, to), ...codexSources(codexRoot, from, to)];
  const projectKey = shareViewRoot.replaceAll(/[^a-zA-Z0-9]/g, '-');
  const memory = discover(join(claudeRoot, 'projects', projectKey, 'memory'));
  sources.push({ id: 'shareview.memory', kind: 'snapshot', dataHeld: 'memory file counts by type',
    limit: 'Current file inventory; content omitted and historical deletions unavailable.', coverage: coverage(memory),
    facts: { files: memory.files.length, byExtension: memory.files.reduce((counts, file) => {
      const extension = extname(file) || '(none)'; counts[extension] = (counts[extension] ?? 0) + 1; return counts;
    }, {}) } });
  const live = run('chattr state');
  sources.push({ id: 'chattr.state', kind: 'snapshot', dataHeld: 'live claims and sessions',
    limit: 'Current snapshot only; claims do not establish historical execution.',
    coverage: { status: live.status === 0 ? 'readable' : 'unparseable', files: 0, missing: live.status === 0 ? 0 : 1,
      dangling: 0, unreadable: 0, unparseable: live.status === 0 ? 0 : 1, rows: null, rowsInWindow: null },
    facts: { claims: live.status === 0 ? live.stdout.split('\n').filter((line) => /\bclaim\b/i.test(line)).length : null } });
  const candidates = [];
  for (const [source, path] of [
    ['install.sh mtime', join(rexRoot, 'scripts', 'install.sh')],
    ['installed Claude command mtime', join(claudeRoot, 'commands', 'rex.md')],
    ['installed Codex agent mtime', join(codexRoot, 'agents', 'rex.toml')],
  ]) {
    try { candidates.push({ source, at: statSync(path).mtime.toISOString() }); }
    catch { /* An absent installation artifact is a coverage gap, not a guessed date. */ }
  }
  const git = run('git install history');
  const firstCommit = git.status === 0 ? git.stdout.trim().split('\n').find(Boolean) : null;
  if (firstCommit && Number.isFinite(Date.parse(firstCommit))) candidates.push({ source: 'first installer commit', at: firstCommit });
  sources.push({ id: 'rex.install', kind: 'snapshot', dataHeld: 'install and repository milestones',
    limit: 'Git history and file mtimes are candidate installation dates, not definitive proof of activation.',
    coverage: { status: candidates.length ? 'readable' : 'missing', files: candidates.length,
      missing: candidates.length ? 0 : 1, dangling: 0, unreadable: 0, unparseable: 0,
      rows: candidates.length, rowsInWindow: null }, facts: { candidates: candidates.length } });
  const chosen = candidates.find((row) => row.source === 'installed Claude command mtime') ??
    candidates.find((row) => row.source === 'installed Codex agent mtime') ??
    candidates.find((row) => row.source === 'install.sh mtime') ?? null;
  const claude = sources.find((row) => row.id === 'claude.projects');
  const codex = sources.find((row) => row.id === 'codex.sessions');
  return { window: { from: from ?? null, toExclusive: to ?? null }, sources,
    providerTokens: { claude: claude.facts.tokens ?? null, codex: codex.facts.tokens ?? null },
    installMilestones: { candidates, chosen, limit: 'File mtimes can change on reinstall; choose explicitly for since-installed reporting.' },
    unavailable: ['dollars actually paid', 'human attention', 'avoidable waiting', 'delegation speedup', 'Rex causal effect'] };
}
