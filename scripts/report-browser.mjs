import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { renderReportHtml, renderReportTerminal } from './report-view.mjs';

export function chooseReportSurface({ preference, terminalSupported = false } = {}) {
  if (preference && !['browser', 'terminal'].includes(preference)) throw new TypeError(`unknown report surface: ${preference}`);
  if (preference === 'terminal' && terminalSupported) return { surface: 'terminal', notice: null };
  if (preference === 'terminal') return { surface: 'browser', notice: 'Integrated terminal report UI unavailable; opened browser report.' };
  return { surface: 'browser', notice: null };
}

function systemOpen(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const result = spawnSync(command, args, { stdio: 'ignore' });
  if (result.error || result.status !== 0) throw new Error(`could not open report in browser: ${result.error?.message ?? result.status}`);
}

export function deliverReport(view, {
  preference, terminalSupported = false, outputDir,
  openBrowser = systemOpen, writeTerminal = (text) => process.stdout.write(text),
} = {}) {
  const selection = chooseReportSurface({ preference, terminalSupported });
  if (selection.surface === 'terminal') {
    writeTerminal(renderReportTerminal(view));
    return selection;
  }
  const directory = mkdtempSync(join(outputDir ?? tmpdir(), 'rex-report-'));
  const path = join(directory, 'report.html');
  writeFileSync(path, renderReportHtml(view), { mode: 0o600 });
  const url = pathToFileURL(path).href;
  openBrowser(url);
  return { ...selection, path, url };
}
