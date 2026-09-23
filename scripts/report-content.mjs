import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function files(directory) {
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) return []; throw error; }
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : [];
  });
}

function userText(row) {
  if (row.type !== 'user' || row.isMeta) return null;
  const content = row.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.every((block) => block.type === 'text')) {
    return content.map((block) => block.text ?? '').join('');
  }
  return null;
}

export function collectSemanticEvidence({ root, from, to, projects = [], session } = {}) {
  const projectRoot = join(root, 'projects');
  let entries;
  try { entries = readdirSync(projectRoot, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const seenRows = new Set();
  const questions = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory() || (projects.length && !projects.includes(entry.name))) continue;
    for (const path of files(join(projectRoot, entry.name))) {
      let content;
      try { content = readFileSync(path, 'utf8'); } catch { continue; }
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        const at = Date.parse(row.timestamp ?? '');
        if (!Number.isFinite(at) || (from && at < Date.parse(from)) || (to && at >= Date.parse(to))) continue;
        if (session && row.sessionId !== session) continue;
        const message = userText(row);
        if (!message) continue;
        const normalized = message.trim().toLowerCase().replace(/\s+/g, ' ');
        if (normalized.length < 20 || !normalized.endsWith('?')) continue;
        const identity = `${row.sessionId ?? path}:${row.uuid ?? row.timestamp}`;
        if (seenRows.has(identity)) continue;
        seenRows.add(identity);
        const hash = createHash('sha256').update(normalized).digest('hex');
        const list = questions.get(hash) ?? [];
        list.push({ session: row.sessionId ?? 'unknown', reference: row.uuid ?? row.timestamp });
        questions.set(hash, list);
      }
    }
  }
  return [...questions.values()].filter((rows) => new Set(rows.map((row) => row.session)).size > 1)
    .map((rows) => ({ label: 'Exact user question repeated across sessions',
      evidence: rows.slice(0, 20),
      caveat: 'The repeated wording is observed; whether repetition was avoidable needs context.' }));
}

export function collectContentReferences({ root, from, to, projects = [], session } = {}) {
  const references = new Set();
  const projectRoot = join(root, 'projects');
  let entries;
  try { entries = readdirSync(projectRoot, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return references; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory() || (projects.length && !projects.includes(entry.name))) continue;
    for (const path of files(join(projectRoot, entry.name))) {
      let content;
      try { content = readFileSync(path, 'utf8'); } catch { continue; }
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        const at = Date.parse(row.timestamp ?? '');
        if (!Number.isFinite(at) || (from && at < Date.parse(from)) || (to && at >= Date.parse(to))) continue;
        if (session && row.sessionId !== session) continue;
        if (row.sessionId && row.uuid) references.add(`${row.sessionId}:${row.uuid}`);
      }
    }
  }
  return references;
}
