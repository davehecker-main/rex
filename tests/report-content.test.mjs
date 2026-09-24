import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectSemanticEvidence } from '../scripts/report-content.mjs';

test('explicit content scan cites repeated questions without leaking their text', () => {
  const root = mkdtempSync(join(tmpdir(), 'rex-content-'));
  try {
    const project = join(root, 'projects', 'project-a');
    mkdirSync(project, { recursive: true });
    const question = 'Why did the deployment wait for permission again?';
    const rows = ['a', 'b'].map((session, index) => ({ type: 'user', uuid: `u-${index}`,
      sessionId: session, timestamp: '2026-09-22T10:00:00Z', message: { content: question } }));
    writeFileSync(join(project, 'a.jsonl'), rows.map(JSON.stringify).join('\n'));
    const found = collectSemanticEvidence({ root, projects: ['project-a'] });
    assert.equal(found.length, 1);
    assert.deepEqual(found[0].evidence.map((entry) => entry.session), ['a', 'b']);
    assert.doesNotMatch(JSON.stringify(found), /deployment wait/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
