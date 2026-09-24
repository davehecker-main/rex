import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { collectUsage, rateCard } from './usage-accounting.mjs';
import { resolveReportQuery } from './report-query.mjs';
import { assessReport } from './report-assessment.mjs';
import { buildReportView } from './report-view.mjs';
import { deliverReport } from './report-browser.mjs';
import { collectSemanticEvidence, collectContentReferences } from './report-content.mjs';
import { collectSourceInventory } from './source-inventory.mjs';

export function discoverProjects(root) {
  let entries;
  try { entries = readdirSync(join(root, 'projects'), { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => ({
    key: entry.name, name: entry.name.split('-').filter(Boolean).at(-1) ?? entry.name,
  }));
}

function interventions(path) {
  try { return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function validateOverride(value, request, projects, timeZone) {
  if (!value || typeof value !== 'object' || !['usage', 'behavior', 'comparison', 'intervention', 'sessions', 'source-inventory'].includes(value.kind)) {
    throw new Error('structured query needs a supported kind');
  }
  const selectedProjects = value.projects ?? [];
  const selectedModels = value.models ?? [];
  if (!Array.isArray(selectedProjects) || selectedProjects.some((key) => !projects.some((item) => item.key === key))) {
    throw new Error('structured query names an unavailable project');
  }
  if (!Array.isArray(selectedModels) || selectedModels.some((model) => typeof model !== 'string')) {
    throw new Error('structured query models must be strings');
  }
  for (const period of [value.period, value.comparePeriod].filter(Boolean)) {
    if (!period.from || !period.to || !Number.isFinite(Date.parse(period.from)) ||
      !Number.isFinite(Date.parse(period.to)) || Date.parse(period.from) >= Date.parse(period.to)) {
      throw new Error('structured query periods need ordered ISO bounds');
    }
  }
  if (value.contentAnalysis && !/\b(?:analy[sz]e|inspect|review|read)\b.{0,80}\b(?:transcript|conversation|session|chat)\b.{0,40}\b(?:content|text|messages?)\b|\b(?:deep|semantic)\s+content\s+analysis\b/i.test(request)) {
    throw new Error('content analysis requires an explicit opt-in in the user request');
  }
  return { kind: value.kind, history: value.history === 'since-installed' && value.kind === 'source-inventory' ? 'since-installed' : value.period ? 'period' : 'all-available',
    period: value.period ?? null, periodUnit: null, comparePeriod: value.comparePeriod ?? null,
    projects: selectedProjects, models: selectedModels, timeZone: value.timeZone ?? timeZone,
    contentAnalysis: value.contentAnalysis === true, surface: value.surface ?? 'default',
    findingId: value.findingId ?? null, currentSession: value.currentSession === true };
}

function findings(report, assessment) {
  const entries = (assessment.rexJudgment?.findings ?? []).map((finding, index) => ({
    id: `rex-${index + 1}`, label: finding.label, sessions: finding.sessions,
    status: finding.status, caveat: finding.caveat,
  }));
  entries.push(...assessment.patterns.map((pattern) => ({
    id: `metric-${pattern.metric}`, label: `Repeated ${pattern.metric} in available metrics`,
    sessions: pattern.evidence.sessions, status: pattern.status,
    caveat: pattern.caveat,
  })));
  for (const [index, finding] of assessment.semanticFindings.entries()) {
    entries.push({ id: `content-${index + 1}`, label: finding.label,
      sessions: [...new Set(finding.evidence.map((item) => item.session))],
      status: 'content-observation', caveat: finding.caveat ?? 'Interpretation requires context.' });
  }
  if (report.coverage.rowsWithoutUsage || report.coverage.unreadableFiles || report.coverage.malformedLines) {
    entries.push({ id: 'coverage', label: 'Some usage is unavailable',
      sessions: report.groups.bySession.map((entry) => entry.key), status: 'coverage-gap',
      caveat: 'Supporting sessions identify available records; missing data cannot be reconstructed.' });
  }
  return entries;
}

function validateJudgment(value, report, contentAnalysis, contentReferences) {
  if (!value || typeof value !== 'object' || typeof value.summary !== 'string' || !Array.isArray(value.findings)) {
    throw new Error('Rex judgment needs a summary and findings array');
  }
  const sessions = new Set(report.groups.bySession.map((row) => row.key));
  for (const finding of value.findings) {
    if (typeof finding.label !== 'string' || typeof finding.caveat !== 'string' ||
      !['metric-observation', 'established-behavior'].includes(finding.status) ||
      !Array.isArray(finding.sessions) || !finding.sessions.length ||
      !Array.isArray(finding.evidence) || !finding.evidence.length) {
      throw new Error('Rex finding needs a label, status, caveat, sessions, and evidence');
    }
    if (finding.status === 'established-behavior' && !contentAnalysis) {
      throw new Error('established behavior requires content opt-in');
    }
    if (finding.sessions.some((session) => !sessions.has(session)) ||
      finding.evidence.some((item) => !sessions.has(item.session))) {
      throw new Error('Rex finding cites an unknown session');
    }
    if (finding.evidence.some((item) => typeof item.reference !== 'string' || !item.reference)) {
      throw new Error('Rex finding needs attributable evidence references');
    }
    if (finding.status === 'established-behavior' &&
      finding.evidence.some((item) => !contentReferences.has(`${item.session}:${item.reference}`))) {
      throw new Error('Rex finding cites an unknown transcript reference');
    }
  }
  return { summary: value.summary, findings: value.findings };
}

export function runReportRequest(request, {
  root = join(homedir(), '.claude'), previous = null, now = new Date().toISOString(),
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  outputDir, openBrowser, terminalSupported = false, writeTerminal,
  interventionLog = process.env.REX_LOG ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'rex', 'interventions.jsonl'),
  semanticEvidence = [],
  queryOverride = null,
  judgment = null,
  deliver = true,
  codexRoot, rexRoot, shareViewRoot, stateRoot, command,
} = {}) {
  const projects = discoverProjects(root);
  const queryResult = queryOverride ? { status: 'resolved', query: validateOverride(queryOverride, request, projects, timeZone) } :
    resolveReportQuery(request, { previous: previous?.query ?? previous,
      now, timeZone, projects, models: Object.keys(rateCard.models) });
  if (queryResult.status !== 'resolved') return queryResult;
  const query = queryResult.query;
  if (query.currentSession && !process.env.CLAUDE_CODE_SESSION_ID) {
    return { status: 'clarification', question: 'Which session should I report? The host did not provide a current Claude session ID.' };
  }
  const sourceInventory = query.kind === 'source-inventory' ? collectSourceInventory({
    claudeRoot: root, codexRoot, rexRoot, shareViewRoot, stateRoot, command,
    from: query.history === 'since-installed' ? 'since-installed' : query.period?.from,
    to: query.period?.to,
  }) : null;
  const options = { root, from: sourceInventory?.window.from ?? query.period?.from, to: query.period?.to,
    projects: query.projects, models: query.models,
    session: query.currentSession ? process.env.CLAUDE_CODE_SESSION_ID : undefined };
  let report = collectUsage(options);
  let baseline = query.comparePeriod ? collectUsage({ ...options,
    from: query.comparePeriod.from, to: query.comparePeriod.to }) : null;
  let logged = [];
  if (query.kind === 'intervention') {
    logged = interventions(interventionLog).filter((row) => row.finding && row.finding !== 'none' &&
      (!query.period || (row.at >= query.period.from && row.at < query.period.to)));
    const dates = logged.map((row) => row.at).filter((at) => Number.isFinite(Date.parse(at))).sort();
    if (dates.length) {
      baseline = collectUsage({ ...options, from: undefined, to: dates[0] });
      report = collectUsage({ ...options, from: dates.at(-1), to: now });
    }
  }
  const contentEvidence = query.contentAnalysis ? (semanticEvidence.length ? semanticEvidence :
    collectSemanticEvidence({ root, from: options.from, to: options.to,
      projects: query.projects, session: options.session })) : [];
  const assessment = assessReport(report, { baseline,
    projectComparison: query.kind === 'comparison' && query.projects.length === 2 ? query.projects : undefined,
    interventions: logged,
    contentAnalysis: query.contentAnalysis, semanticEvidence: contentEvidence });
  const effectiveJudgment = judgment ?? (query.kind === 'sessions' ? previous?.judgment : null);
  if (effectiveJudgment) {
    const references = query.contentAnalysis ? collectContentReferences({ root, from: options.from,
      to: options.to, projects: query.projects, session: options.session }) : new Set();
    assessment.rexJudgment = validateJudgment(effectiveJudgment, report, query.contentAnalysis, references);
    if (assessment.rexJudgment.findings.some((item) => item.status === 'established-behavior')) {
      assessment.contentAnalysis.status = 'supported';
    }
  }
  const reportFindings = findings(report, assessment);
  const selectedFinding = query.kind === 'sessions'
    ? reportFindings.find((entry) => entry.id === query.findingId) : null;
  const view = buildReportView(report, { compareTo: baseline, assessment,
    query, projectNames: projects, findings: reportFindings, finding: selectedFinding,
    sourceInventory });
  const delivery = deliver ? deliverReport(view, { preference: query.surface === 'default' ? undefined : query.surface,
    terminalSupported, outputDir, openBrowser, writeTerminal }) : null;
  const context = { query: { ...query, findingIds: reportFindings.map((entry) => entry.id),
    findingId: reportFindings.length === 1 ? reportFindings[0].id : query.kind === 'sessions' ? query.findingId : null },
    reportPath: delivery?.path ?? null, judgment: assessment.rexJudgment ?? null };
  return { status: deliver ? 'delivered' : 'prepared', query, report, baseline, assessment, view, delivery, context };
}
