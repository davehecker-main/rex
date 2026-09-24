#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { runReportRequest } from './report-runner.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  if (!process.argv[index + 1]) throw new Error(`${name} requires a value`);
  return process.argv[index + 1];
}

function readContext(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function main() {
  const statePath = option('--context') ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'rex', 'report-context.json');
  const root = option('--root') ?? join(homedir(), '.claude');
  const codexRoot = option('--codex-root') ?? undefined;
  const rexRoot = option('--rex-root') ?? undefined;
  const shareViewRoot = option('--shareview-root') ?? undefined;
  const file = option('--request-file');
  const queryFile = option('--query-file');
  const prepareFile = option('--prepare');
  const judgmentFile = option('--judgment-file');
  const excluded = new Set(['--context', '--root', '--codex-root', '--rex-root', '--shareview-root', '--request-file', '--query-file', '--prepare', '--judgment-file']);
  const words = [];
  for (let i = 2; i < process.argv.length; i++) {
    if (excluded.has(process.argv[i])) { i++; continue; }
    if (process.argv[i].startsWith('--')) throw new Error(`unknown option: ${process.argv[i]}`);
    words.push(process.argv[i]);
  }
  const request = file ? readFileSync(file, 'utf8') : words.length ? words.join(' ') :
    process.stdin.isTTY ? await new Promise((resolve) => {
      process.stdout.write('What would you like Rex to report? ');
      process.stdin.once('data', (chunk) => resolve(String(chunk)));
    }) : await new Promise((resolve) => {
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { input += chunk; });
      process.stdin.on('end', () => resolve(input));
    });
  const queryOverride = queryFile ? JSON.parse(readFileSync(queryFile, 'utf8')) : null;
  const judgment = judgmentFile ? JSON.parse(readFileSync(judgmentFile, 'utf8')) : null;
  const result = runReportRequest(request, { root, codexRoot, rexRoot, shareViewRoot, previous: readContext(statePath), queryOverride,
    judgment, deliver: !prepareFile });
  if (result.status === 'clarification') {
    process.stdout.write(`${result.question}\n`);
    if (prepareFile) process.exitCode = 3;
    return;
  }
  if (prepareFile) {
    const evidence = { request, query: result.query, report: result.report,
      baseline: result.baseline, assessment: result.assessment,
      sourceInventory: result.view.sourceInventory,
      contentSources: result.query.contentAnalysis ? join(root, 'projects') : null };
    writeFileSync(prepareFile, JSON.stringify(evidence), { mode: 0o600 });
    process.stdout.write(`Prepared Rex evidence: ${prepareFile}\n`);
    return;
  }
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(result.context), { mode: 0o600 });
  if (result.delivery.notice) process.stdout.write(`${result.delivery.notice}\n`);
  process.stdout.write(`Rex report: ${result.delivery.url ?? 'integrated terminal'}\n`);
  process.stdout.write(`Follow-ups use context: ${statePath}\n`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
