import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const ms = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e11 ? value * 1000 : value;
  const n = Date.parse(value ?? ''); return Number.isFinite(n) ? n : null;
};
export const within = (value, from, to) => {
  const at = ms(value);
  return at !== null && (!from || at >= ms(from)) && (!to || at < ms(to));
};

export function discover(path, extensions = null) {
  const result = { files: [], missing: 0, dangling: 0, unreadable: 0 };
  function visit(current) {
    let info;
    try { info = lstatSync(current); }
    catch (error) { result[error.code === 'ENOENT' ? 'missing' : 'unreadable']++; return; }
    if (info.isSymbolicLink()) {
      if (!existsSync(current)) { result.dangling++; return; }
      try { info = statSync(current); }
      catch { result.unreadable++; return; }
    }
    if (info.isDirectory()) {
      try { for (const name of readdirSync(current)) visit(join(current, name)); }
      catch { result.unreadable++; }
    } else if (info.isFile() && (!extensions || extensions.some((ext) => current.endsWith(ext)))) {
      result.files.push(current);
    }
  }
  visit(path);
  return result;
}

export function parseRecords(path) {
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return { records: [], unparseable: 0 };
  if (!path.endsWith('.jsonl')) {
    try { const value = JSON.parse(raw); return { records: Array.isArray(value) ? value : [value], unparseable: 0 }; }
    catch { /* NDJSON may use a .json extension. */ }
  }
  const records = []; let unparseable = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); }
    catch { unparseable++; }
  }
  return { records, unparseable };
}

export function coverage(discovery, { rows = 0, rowsInWindow = null, unparseable = 0 } = {}) {
  const status = discovery.dangling || discovery.unreadable || unparseable ? 'unparseable' :
    discovery.missing && !discovery.files.length ? 'missing' : 'readable';
  return { status, files: discovery.files.length, missing: discovery.missing,
    dangling: discovery.dangling, unreadable: discovery.unreadable, unparseable, rows, rowsInWindow };
}

export function recordsSource({ id, path, extensions, kind, dataHeld, limit, from, to, timestamp, facts = () => ({}) }) {
  const discovery = discover(path, extensions);
  const rows = []; let unparseable = 0;
  for (const file of discovery.files) {
    try { const parsed = parseRecords(file); rows.push(...parsed.records); unparseable += parsed.unparseable; }
    catch { discovery.unreadable++; }
  }
  const dated = kind === 'event' ? rows.filter((row) => within(timestamp(row), from, to)) : rows;
  return { id, kind, dataHeld, limit, coverage: coverage(discovery,
    { rows: rows.length, rowsInWindow: kind === 'event' ? dated.length : null, unparseable }), facts: facts(dated, rows) };
}
