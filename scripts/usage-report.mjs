#!/usr/bin/env node
import { collectUsage } from './usage-accounting.mjs';

const args = process.argv.slice(2);
const options = {};
let includeRequests = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--requests') { includeRequests = true; continue; }
  if (arg === '--help') {
    console.log('usage: node scripts/usage-report.mjs [--root ~/.claude] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--project encoded-project-dir] [--requests]');
    process.exit(0);
  }
  const key = { '--root': 'root', '--from': 'from', '--to': 'to', '--project': 'project' }[arg];
  if (!key || !args[i + 1]) {
    console.error(`unknown or incomplete option: ${arg}`);
    process.exit(2);
  }
  options[key] = args[++i];
}

try {
  const report = collectUsage(options);
  if (!includeRequests) delete report.requests;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
