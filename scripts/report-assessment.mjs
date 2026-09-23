const measuredFields = ['requests', 'humanTurns', 'assistantTurns', 'toolCalls', 'interruptions', 'assistantProseCharacters'];
const gapFields = ['unreadableFiles', 'malformedLines', 'rowsWithoutUsage', 'undatedRows'];

function sessionIds(report, project) {
  const withRequests = (report.requests ?? [])
    .filter((request) => project === undefined || request.project === project)
    .map((request) => request.session);
  const sessionRows = project === undefined ? (report.groups?.bySession ?? []).map((entry) => entry.key) : [];
  return [...new Set([...withRequests, ...sessionRows])].sort();
}

function measurements(report, project) {
  const requests = (report.requests ?? []).filter((request) => project === undefined || request.project === project);
  const sessions = sessionIds(report, project);
  const sessionSet = new Set(sessions);
  const bySession = (report.groups?.bySession ?? []).filter((entry) => sessionSet.has(entry.key));
  const metrics = Object.fromEntries(measuredFields.map((key) => [key, 0]));
  metrics.requests = requests.length;
  for (const entry of bySession) {
    for (const field of measuredFields.slice(1)) metrics[field] += entry[field] ?? 0;
  }
  const allPriced = requests.every((request) => request.price?.status === 'priced');
  metrics.knownApiEquivalentUsd = requests.reduce((sum, request) => sum + (request.price?.usd ?? 0), 0);
  metrics.apiEquivalentUsd = allPriced && !hasGaps(report) ? metrics.knownApiEquivalentUsd : null;
  metrics.interruptionsPer100HumanTurns = metrics.humanTurns > 0
    ? 100 * metrics.interruptions / metrics.humanTurns : null;
  return { metrics, sessions };
}

function hasGaps(report) {
  return gapFields.some((field) => (report.coverage?.[field] ?? 0) > 0);
}

function comparison(dimension, current, baseline, labels) {
  const a = measurements(current.report, current.project);
  const b = measurements(baseline.report, baseline.project);
  const metrics = {};
  for (const key of [...measuredFields, 'knownApiEquivalentUsd', 'apiEquivalentUsd', 'interruptionsPer100HumanTurns']) {
    const now = a.metrics[key];
    const before = b.metrics[key];
    metrics[key] = {
      current: now, baseline: before,
      delta: now === null || before === null ? null : now - before,
    };
  }
  return {
    dimension, labels, metrics,
    evidence: { currentSessions: a.sessions, baselineSessions: b.sessions },
    caveat: 'Session counts and usage are measured; no human work time or causal effect is inferred.',
  };
}

function observedPatterns(report) {
  const sessions = (report.groups?.bySession ?? []).filter((entry) => (entry.interruptions ?? 0) > 0);
  if (sessions.length < 2) return [];
  return [{
    metric: 'interruptions', status: 'metric-observation',
    evidence: { sessions: sessions.map((entry) => entry.key).sort() },
    measurements: { total: sessions.reduce((sum, entry) => sum + entry.interruptions, 0), sessions: sessions.length },
    caveat: 'Counts alone do not establish whether the interruptions were avoidable.',
  }];
}

function interventionEvidence(row, current, baseline) {
  const unknown = (reason) => ({ status: 'unknown', reason });
  if (!baseline || row.metric !== 'interruptionsPer100HumanTurns') {
    return unknown('No supported before/after metric was supplied.');
  }
  const at = Date.parse(row.at ?? '');
  const earlier = (baseline.requests ?? []).map((request) => Date.parse(request.date)).filter(Number.isFinite);
  const later = (current.requests ?? []).map((request) => Date.parse(request.date)).filter(Number.isFinite);
  if (!Number.isFinite(at) || !earlier.length || !later.length ||
      earlier.some((timestamp) => timestamp >= at) || later.some((timestamp) => timestamp <= at)) {
    return unknown('The available request dates do not bracket this intervention.');
  }
  const before = measurements(baseline).metrics[row.metric];
  const now = measurements(current).metrics[row.metric];
  if (before === null || now === null || hasGaps(baseline) || hasGaps(current)) {
    return unknown('The comparison lacks complete measurable coverage.');
  }
  return {
    status: now < before ? 'suggests-improvement' : now > before ? 'observed-increase' : 'no-observed-change',
    metric: row.metric, baseline: before, current: now,
    evidence: { baselineSessions: sessionIds(baseline), currentSessions: sessionIds(current) },
    caveat: 'A before/after comparison cannot establish causation.',
  };
}

function assessmentOfInterventions(rows, current, baseline) {
  return rows.filter((row) => row.finding && row.finding !== 'none').map((row) => ({
    at: row.at ?? null, session: row.session ?? null,
    finding: row.finding, advice: row.advice ?? null,
    followThrough: ({ yes: 'acted', no: 'confirmed-inaction', partial: 'partial' })[row.acted] ?? 'unknown',
    laterEvidence: interventionEvidence(row, current, baseline),
  }));
}

function semanticResults(report, optIn, evidence) {
  if (!optIn) return { contentAnalysis: { status: 'not-requested' }, semanticFindings: [] };
  const knownSessions = new Set(sessionIds(report));
  const accepted = evidence.filter((finding) => typeof finding.label === 'string' &&
    Array.isArray(finding.evidence) && finding.evidence.length > 0 &&
    finding.evidence.every((item) => knownSessions.has(item.session) &&
      typeof item.reference === 'string' && item.reference.length > 0));
  return {
    contentAnalysis: { status: accepted.length ? 'supported' : 'insufficient-evidence' },
    semanticFindings: accepted,
  };
}

export function assessReport(report, {
  baseline, projectComparison, interventions = [], contentAnalysis = false, semanticEvidence = [],
} = {}) {
  const comparisons = [];
  if (baseline) comparisons.push(comparison('period', { report }, { report: baseline }, {
    current: [report.basis?.from ?? null, report.basis?.toExclusive ?? null],
    baseline: [baseline.basis?.from ?? null, baseline.basis?.toExclusive ?? null],
  }));
  if (projectComparison?.length === 2) {
    const [first, second] = projectComparison;
    comparisons.push(comparison('project', { report, project: first }, { report, project: second },
      { current: first, baseline: second }));
  }
  const currentMetrics = measurements(report);
  const health = !currentMetrics.sessions.length || hasGaps(report)
    ? { status: 'unknown', basis: 'Insufficient session or source coverage.' }
    : currentMetrics.metrics.interruptions === 0
      ? { status: 'healthy', basis: 'No recorded interruption signal in available metrics; other habits and semantic behavior were not assessed.' }
      : { status: 'inconclusive', basis: 'Recorded interruptions need context before judging behavior.' };
  return {
    comparisons,
    patterns: observedPatterns(report),
    timeSinks: { status: 'unknown', reason: 'Transcripts do not measure active human work time; overlapping sessions cannot be summed.' },
    health,
    interventions: assessmentOfInterventions(interventions, report, baseline),
    ...semanticResults(report, contentAnalysis, semanticEvidence),
  };
}
