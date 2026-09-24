import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { discover, coverage } from './sources/common.mjs';
import { claudeSources } from './sources/claude.mjs';
import { codexSources, collectCodexTokens } from './sources/codex.mjs';

const systemCommand = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 3000, maxBuffer: 100_000 });
  return { status: result.status, stdout: result.stdout ?? '' };
};

export function collectSourceInventory({
  claudeRoot = join(homedir(), '.claude'), codexRoot = join(homedir(), '.codex'),
  shareViewRoot = join(homedir(), 'Developer', 'ShareView'), rexRoot = join(homedir(), 'Developer', 'rex'),
  stateRoot = join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'rex'),
  from, to, command,
} = {}) {
  const run = command ?? ((name) => name === 'chattr state' ? systemCommand('chattr', ['state']) :
    systemCommand('git', ['-C', rexRoot, 'log', '--reverse', '--format=%cI', '--', 'scripts/install.sh']));
  const candidates = [];
  const missingCandidates = [];
  // The installer writes this once and never overwrites it, so it survives reinstalls that
  // reset every mtime candidate below. Prefer it whenever it is present and parseable.
  const installRecordPath = join(stateRoot, 'installed-at');
  const recordFound = discover(installRecordPath);
  if (recordFound.files.length) {
    let raw = null;
    try { raw = readFileSync(installRecordPath, 'utf8').trim(); } catch { /* becomes a gap below */ }
    if (raw && Number.isFinite(Date.parse(raw))) candidates.push({ source: 'install record', at: new Date(raw).toISOString() });
    else missingCandidates.push({ source: 'install record', status: 'unparseable' });
  } else missingCandidates.push({ source: 'install record', status: recordFound.dangling ? 'dangling' : 'missing' });
  for (const [source, path] of [
    ['install.sh mtime', join(rexRoot, 'scripts', 'install.sh')],
    ['installed Claude command mtime', join(claudeRoot, 'commands', 'rex.md')],
    ['installed Codex agent mtime', join(codexRoot, 'agents', 'rex.toml')],
  ]) {
    const found = discover(path);
    if (found.files.length) candidates.push({ source, at: statSync(path).mtime.toISOString() });
    else missingCandidates.push({ source, status: found.dangling ? 'dangling' : 'missing' });
  }
  const git = run('git install history');
  const firstCommit = git.status === 0 ? git.stdout.trim().split('\n').find(Boolean) : null;
  if (firstCommit && Number.isFinite(Date.parse(firstCommit))) candidates.push({ source: 'first installer commit', at: firstCommit });
  else missingCandidates.push({ source: 'first installer commit', status: 'missing' });
  // Without a record, mtimes reset on every reinstall but the earliest candidate (usually the
  // first installer commit) does not, so picking the minimum date is what stays stable.
  const chosen = candidates.find((row) => row.source === 'install record') ??
    candidates.reduce((earliest, row) => !earliest || Date.parse(row.at) < Date.parse(earliest.at) ? row : earliest, null);
  const effectiveFrom = from === 'since-installed' ? chosen?.at ?? null : from;
  const sources = [...claudeSources(claudeRoot, effectiveFrom, to), ...codexSources(codexRoot, effectiveFrom, to)];
  const projectKey = shareViewRoot.replaceAll(/[^a-zA-Z0-9]/g, '-');
  const memory = discover(join(claudeRoot, 'projects', projectKey, 'memory'));
  sources.push({ id: 'shareview.memory', kind: 'snapshot', dataHeld: 'memory file counts by type',
    limit: 'Current file inventory; content omitted and historical deletions unavailable.', coverage: coverage(memory),
    facts: { files: memory.files.length, byExtension: memory.files.reduce((counts, file) => {
      const extension = extname(file) || '(none)'; counts[extension] = (counts[extension] ?? 0) + 1; return counts;
    }, {}) } });
  const live = run('chattr state');
  let liveData = null;
  try { const parsed = JSON.parse(live.stdout); if (live.status === 0 && parsed.ok === true) liveData = parsed; }
  catch { /* Invalid response becomes a coverage gap. */ }
  sources.push({ id: 'chattr.state', kind: 'snapshot', dataHeld: 'live claims and sessions',
    limit: 'Current snapshot only; claims do not establish historical execution.',
    coverage: { status: liveData ? 'readable' : 'unparseable', files: 0, missing: liveData ? 0 : 1,
      dangling: 0, unreadable: 0, unparseable: liveData ? 0 : 1, rows: null, rowsInWindow: null },
    facts: { claims: Array.isArray(liveData?.claims) ? liveData.claims.length : null,
      peers: Array.isArray(liveData?.peers) ? liveData.peers.length : null,
      broadcasts: Array.isArray(liveData?.broadcasts) ? liveData.broadcasts.length : null,
      unacked: Array.isArray(liveData?.unacked) ? liveData.unacked.length : null } });
  sources.push({ id: 'rex.install', kind: 'snapshot', dataHeld: 'install and repository milestones',
    limit: 'Git history and file mtimes are candidate installation dates, not definitive proof of activation.',
    coverage: { status: candidates.length ? 'readable' : 'missing', files: candidates.length,
      missing: missingCandidates.filter((row) => row.status === 'missing').length,
      dangling: missingCandidates.filter((row) => row.status === 'dangling').length, unreadable: 0,
      unparseable: missingCandidates.filter((row) => row.status === 'unparseable').length,
      rows: candidates.length, rowsInWindow: null }, facts: { candidates: candidates.length } });
  const claude = sources.find((row) => row.id === 'claude.projects');
  const codex = collectCodexTokens(codexRoot, effectiveFrom, to);
  return { window: { from: effectiveFrom ?? null, toExclusive: to ?? null, requestedFrom: from ?? null }, sources,
    providerTokens: { claude: claude.facts.tokens ?? null, codex: codex.tokens },
    tokenCoverage: { codex: codex.coverage },
    installMilestones: { candidates, missingCandidates, chosen, limit: 'The installer\'s own record is preferred when present; otherwise the earliest candidate is used because file mtimes reset on reinstall.' },
    unavailable: [...(from === 'since-installed' && !chosen ? ['installation date; showing all available history'] : []),
      'dollars actually paid', 'human attention', 'avoidable waiting', 'delegation speedup', 'Rex causal effect'] };
}
