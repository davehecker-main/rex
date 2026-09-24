const number = (value) => Number.isFinite(value) ? value.toLocaleString('en-US') : 'unknown';
const money = (value) => Number.isFinite(value) ? `$${value.toFixed(value < .01 ? 4 : 2)}` : 'unknown';
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const tokenTotal = (tokens = {}) => Object.values(tokens).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
const metric = (row) => ({
  key: String(row.key ?? 'unknown'), requests: row.requests ?? 0,
  tokens: tokenTotal(row.tokens), knownApiEquivalentUsd: row.knownApiEquivalentUsd ?? 0,
  unpricedRequests: row.unpricedRequests ?? 0, humanTurns: row.humanTurns ?? null,
  assistantTurns: row.assistantTurns ?? null, toolCalls: row.toolCalls ?? null,
  interruptions: row.interruptions ?? null,
});

export function buildReportView(report, { compareTo, assessment, query, projectNames = [], findings = [], finding = null } = {}) {
  if (!report?.basis || !report?.summary || !report?.coverage || !report?.groups) {
    throw new TypeError('report requires basis, summary, coverage, and groups');
  }
  const { basis, summary, coverage, groups } = report;
  const sections = [
    ['date', 'By day', groups.byDate], ['model', 'By model', groups.byModel],
    ['project', 'By project', groups.byProject], ['session', 'Supporting sessions', groups.bySession],
  ].map(([id, title, rows]) => ({ id, title, rows: (rows ?? []).map(metric) }));
  const gaps = [
    ['Missing source directory', coverage.missingSource], ['Unreadable directories', coverage.unreadableDirs],
    ['Unreadable files', coverage.unreadableFiles], ['Malformed lines', coverage.malformedLines],
    ['Rows without usage', coverage.rowsWithoutUsage], ['Undated rows', coverage.undatedRows],
    ['Unpriced requests', coverage.unpricedRequests],
    ...Object.entries(coverage.unpricedByReason ?? {}).map(([reason, value]) => [`Unpriced: ${reason}`, value]),
  ].filter(([, value]) => value > 0).map(([label, value]) => ({ label, value }));
  const view = {
    title: 'Rex usage report',
    scope: { source: basis.source, from: basis.from, toExclusive: basis.toExclusive,
      timezone: 'UTC', calendarTimeZone: query?.timeZone ?? 'UTC',
      sessions: sections[3].rows.length, files: coverage.files ?? 0,
      projects: query?.projects?.map((key) => projectNames.find((item) => item.key === key)?.name ?? key) ?? [],
      models: query?.models ?? [], history: query?.history ?? 'all-available',
      interventionPeriod: query?.kind === 'intervention' ? query.period : null,
      behaviorMeaning: basis.behaviorMeaning ?? null },
    summary: { requests: summary.requests ?? 0, tokens: tokenTotal(summary.tokens),
      humanTurns: summary.humanTurns ?? 0, assistantTurns: summary.assistantTurns ?? 0,
      toolCalls: summary.toolCalls ?? 0, interruptions: summary.interruptions ?? 0,
      subagentRequests: summary.subagentRequests ?? 0 },
    cost: { status: summary.apiEquivalentUsd == null ? 'incomplete' : 'complete',
      apiEquivalentUsd: summary.apiEquivalentUsd ?? null,
      knownApiEquivalentUsd: summary.knownApiEquivalentUsd ?? 0,
      actualSpendingUsd: null, meaning: basis.costMeaning, priceAsOf: basis.priceAsOf,
      priceSource: basis.priceSource },
    coverage: { gaps, duplicateRows: coverage.duplicateRows ?? 0,
      assistantRows: coverage.assistantRows ?? 0 },
    sections,
    comparison: null,
    assessment: assessment ?? null,
    findings,
    finding,
  };
  if (compareTo) {
    view.comparison = {
      label: `${compareTo.basis?.from ?? 'start'} to ${compareTo.basis?.toExclusive ?? 'end'} (exclusive), UTC`,
      requestsDelta: view.summary.requests - (compareTo.summary?.requests ?? 0),
      tokensDelta: view.summary.tokens - tokenTotal(compareTo.summary?.tokens),
      apiEquivalentUsdDelta: summary.apiEquivalentUsd == null || compareTo.summary?.apiEquivalentUsd == null
        ? null : summary.apiEquivalentUsd - compareTo.summary.apiEquivalentUsd,
    };
  }
  return view;
}

const scopeText = (scope) => `${scope.from ?? 'first available'} to ${scope.toExclusive ?? 'latest available'} (exclusive), ${scope.timezone}; calendar selection ${scope.calendarTimeZone}, daily groups UTC`;
const costText = (cost) => cost.status === 'complete'
  ? money(cost.apiEquivalentUsd) : `unknown total; ${money(cost.knownApiEquivalentUsd)} from priced requests`;
function interventionText(item) {
  const evidence = item.laterEvidence ?? { status: 'unknown', reason: 'No later evidence was supplied.' };
  const start = `${item.finding}: follow-through ${item.followThrough}; later evidence ${evidence.status}`;
  if (evidence.status === 'unknown') return `${start}; reason: ${evidence.reason ?? 'Unknown'}`;
  const before = evidence.evidence?.baselineSessions?.join(', ') || 'unknown sessions';
  const after = evidence.evidence?.currentSessions?.join(', ') || 'unknown sessions';
  return `${start}; ${evidence.metric}: baseline ${number(evidence.baseline)} (${before}), current ${number(evidence.current)} (${after}); ${evidence.caveat ?? ''}`;
}
const columns = ['Key', 'Metered requests', 'Tokens', 'Known API equivalent', 'Unpriced'];
const cells = (row) => [row.key, number(row.requests), number(row.tokens), money(row.knownApiEquivalentUsd), number(row.unpricedRequests)];

export function renderReportTerminal(view) {
  const lines = [view.title, '='.repeat(view.title.length),
    `Scope: ${scopeText(view.scope)}`, `Source: ${view.scope.source}; ${number(view.scope.files)} files; ${number(view.scope.sessions)} sessions`,
    `Metered requests: ${number(view.summary.requests)} (${number(view.summary.subagentRequests)} subagent); tokens: ${number(view.summary.tokens)}`,
    `Human turns: ${number(view.summary.humanTurns)}; assistant turns: ${number(view.summary.assistantTurns)}; tool calls: ${number(view.summary.toolCalls)}; interruptions: ${number(view.summary.interruptions)}`,
    `Estimated API equivalent: ${costText(view.cost)}`, `Actual spending: unavailable`,
    `Assumption: ${view.cost.meaning}; rate snapshot ${view.cost.priceAsOf} (${view.cost.priceSource})`,
    `Coverage: ${view.coverage.gaps.length ? view.coverage.gaps.map((gap) => `${gap.label} ${number(gap.value)}`).join('; ') : 'no recorded gaps'}; duplicate rows ${number(view.coverage.duplicateRows)}`,
  ];
  lines.push(`Projects: ${view.scope.projects?.length ? view.scope.projects.join(', ') : 'all available'}; models: ${view.scope.models?.length ? view.scope.models.join(', ') : 'all available'}`);
  if (view.scope.interventionPeriod) lines.push(`Interventions selected: ${view.scope.interventionPeriod.from} to ${view.scope.interventionPeriod.to} (exclusive)`);
  if (view.scope.behaviorMeaning) lines.push(`Behavior scope: ${view.scope.behaviorMeaning}`);
  if (view.comparison) lines.push(`Comparison: ${view.comparison.label}; requests ${view.comparison.requestsDelta >= 0 ? '+' : ''}${number(view.comparison.requestsDelta)}; tokens ${view.comparison.tokensDelta >= 0 ? '+' : ''}${number(view.comparison.tokensDelta)}; estimated cost delta ${view.comparison.apiEquivalentUsdDelta === null ? 'unknown' : money(view.comparison.apiEquivalentUsdDelta)}`);
  if (view.assessment) {
    lines.push('', 'Assessment', `Health: ${view.assessment.health.status} — ${view.assessment.health.basis}`,
      `Time sinks: ${view.assessment.timeSinks.status} — ${view.assessment.timeSinks.reason}`,
      `Content analysis: ${view.assessment.contentAnalysis.status}${view.assessment.contentAnalysis.status === 'insufficient-evidence' ? ' (explicit opt-in; no supported semantic evidence supplied)' : ''}`);
    if (view.assessment.rexJudgment) {
      lines.push(`Rex: ${view.assessment.rexJudgment.summary}`);
      for (const item of view.assessment.rexJudgment.findings) lines.push(`Rex finding: ${item.label} (${item.status}); sessions ${item.sessions.join(', ')}; ${item.caveat}`);
    }
    for (const item of view.findings) lines.push(`Finding ${item.id}: ${item.label}; sessions ${item.sessions.join(', ')}; ${item.caveat}`);
    for (const item of view.assessment.semanticFindings) lines.push(`Content finding: ${item.label}; evidence ${item.evidence.map((entry) => `${entry.session}:${entry.reference}`).join(', ')}; ${item.caveat ?? ''}`);
    for (const item of view.assessment.interventions) lines.push(`Intervention: ${interventionText(item)}`);
    if (view.finding) lines.push(`Supporting sessions for ${view.finding.id}: ${view.finding.sessions.join(', ')}`);
  }
  for (const section of view.sections) {
    lines.push('', section.title, columns.join(' | '));
    for (const row of section.rows) lines.push(cells(row).join(' | '));
    if (!section.rows.length) lines.push('No records');
  }
  return lines.join('\n') + '\n';
}

function table(section) {
  const head = columns.map((column) => `<th scope="col">${escapeHtml(column)}</th>`).join('');
  const rows = section.rows.map((row, i) => {
    const values = cells(row);
    const key = section.id === 'session' ? `<a href="#session-${i}">${escapeHtml(values[0])}</a>` : escapeHtml(values[0]);
    return `<tr data-search="${escapeHtml(row.key.toLowerCase())}"><td>${key}</td>${values.slice(1).map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`;
  }).join('');
  const maxRequests = Math.max(1, ...section.rows.map((row) => row.requests));
  const chart = section.id === 'date' && section.rows.length ? `<div class="chart" aria-label="Requests by day">${section.rows.map((row) => `<div class="bar-row"><span>${escapeHtml(row.key)}</span><meter min="0" max="${maxRequests}" value="${row.requests}">${number(row.requests)}</meter><span>${number(row.requests)}</span></div>`).join('')}</div>` : '';
  const drilldown = section.id === 'session' ? section.rows.map((row, i) => `<details id="session-${i}"><summary>${escapeHtml(row.key)}</summary><p>Requests: ${number(row.requests)}; tokens: ${number(row.tokens)}; human turns: ${number(row.humanTurns)}; assistant turns: ${number(row.assistantTurns)}; tool calls: ${number(row.toolCalls)}; interruptions: ${number(row.interruptions)}; unpriced requests: ${number(row.unpricedRequests)}.</p></details>`).join('') : '';
  return `<section id="${section.id}"><h2>${escapeHtml(section.title)}</h2>${chart}<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${rows || '<tr><td colspan="5">No records</td></tr>'}</tbody></table></div>${drilldown}</section>`;
}

export function renderReportHtml(view) {
  const gaps = view.coverage.gaps.length
    ? view.coverage.gaps.map((gap) => `<li>${escapeHtml(gap.label)}: ${number(gap.value)}</li>`).join('')
    : '<li>No recorded gaps</li>';
  const comparison = view.comparison ? `<section><h2>Comparison</h2><p>Baseline: ${escapeHtml(view.comparison.label)}. Requests: ${number(view.comparison.requestsDelta)}; tokens: ${number(view.comparison.tokensDelta)}; estimated cost difference: ${view.comparison.apiEquivalentUsdDelta === null ? 'unknown' : money(view.comparison.apiEquivalentUsdDelta)}.</p></section>` : '';
  const assessment = view.assessment ? `<section><h2>Assessment</h2>${view.assessment.rexJudgment ? `<h3>Rex's assessment</h3><p>${escapeHtml(view.assessment.rexJudgment.summary)}</p><ul>${view.assessment.rexJudgment.findings.map((item) => `<li>${escapeHtml(item.label)} (${escapeHtml(item.status)}): ${escapeHtml(item.sessions.join(', '))}. ${escapeHtml(item.caveat)}</li>`).join('') || '<li>No supported finding</li>'}</ul>` : ''}<p>Health: ${escapeHtml(view.assessment.health.status)} — ${escapeHtml(view.assessment.health.basis)}</p><p>Time sinks: ${escapeHtml(view.assessment.timeSinks.status)} — ${escapeHtml(view.assessment.timeSinks.reason)}</p><p>Content analysis: ${escapeHtml(view.assessment.contentAnalysis.status)}${view.assessment.contentAnalysis.status === 'insufficient-evidence' ? ' (explicit opt-in; no supported semantic evidence supplied)' : ''}</p><h3>Findings and evidence</h3><ul>${view.findings.map((item) => `<li id="finding-${escapeHtml(item.id)}"><strong>${escapeHtml(item.id)}</strong>: ${escapeHtml(item.label)} (${escapeHtml(item.status)}): sessions ${escapeHtml(item.sessions.join(', '))}. ${escapeHtml(item.caveat)}</li>`).join('') || '<li>No supported metric finding</li>'}</ul><h3>Content findings</h3><ul>${view.assessment.semanticFindings.map((item) => `<li>${escapeHtml(item.label)}: ${escapeHtml(item.evidence.map((entry) => `${entry.session}:${entry.reference}`).join(', '))}. ${escapeHtml(item.caveat ?? '')}</li>`).join('') || '<li>None with attributable evidence</li>'}</ul><h3>Interventions</h3><ul>${view.assessment.interventions.map((item) => `<li>${escapeHtml(interventionText(item))}</li>`).join('') || '<li>None in the available intervention log</li>'}</ul>${view.finding ? `<h3>Supporting sessions for ${escapeHtml(view.finding.id)}</h3><p>${escapeHtml(view.finding.sessions.join(', '))}</p>` : ''}</section>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(view.title)}</title><style>
    :root{color-scheme:light dark;font:16px system-ui,sans-serif}body{max-width:1100px;margin:auto;padding:2rem;line-height:1.5}h1{margin-bottom:.2rem}.sub{color:gray;margin-top:0}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:1rem}.card,section{border:1px solid #9996;border-radius:.6rem;padding:1rem;margin:1rem 0}.card strong{display:block;font-size:1.5rem}.scroll{overflow:auto}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.45rem;border-bottom:1px solid #9996}th{white-space:nowrap}td:first-child{overflow-wrap:anywhere}label{display:block;margin:1rem 0}input{font:inherit;padding:.5rem;width:min(100%,25rem)}details{margin-top:1rem}.chart{margin:1rem 0}.bar-row{display:grid;grid-template-columns:7rem 1fr 3rem;gap:.5rem;align-items:center}.bar-row meter{width:100%}
  </style></head><body><main><h1>${escapeHtml(view.title)}</h1><p class="sub">${escapeHtml(scopeText(view.scope))}</p>
  <p>${escapeHtml(view.scope.source)} · ${number(view.scope.files)} files · ${number(view.scope.sessions)} supporting sessions</p><p>Projects: ${escapeHtml(view.scope.projects?.length ? view.scope.projects.join(', ') : 'all available')}; models: ${escapeHtml(view.scope.models?.length ? view.scope.models.join(', ') : 'all available')}</p>${view.scope.interventionPeriod ? `<p>Interventions selected: ${escapeHtml(view.scope.interventionPeriod.from)} to ${escapeHtml(view.scope.interventionPeriod.to)} (exclusive).</p>` : ''}${view.scope.behaviorMeaning ? `<p>${escapeHtml(view.scope.behaviorMeaning)}</p>` : ''}
  <div class="cards"><div class="card">Metered requests<strong>${number(view.summary.requests)}</strong></div><div class="card">Tokens<strong>${number(view.summary.tokens)}</strong></div><div class="card">Tool calls<strong>${number(view.summary.toolCalls)}</strong></div><div class="card">API equivalent<strong>${escapeHtml(costText(view.cost))}</strong></div></div>
  <section><h2>Scope and assumptions</h2><p>Human turns: ${number(view.summary.humanTurns)}; assistant turns: ${number(view.summary.assistantTurns)}; interruptions: ${number(view.summary.interruptions)}; subagent requests: ${number(view.summary.subagentRequests)}.</p><p>${escapeHtml(view.cost.meaning)}. Rates as of ${escapeHtml(view.cost.priceAsOf)}: <a href="${escapeHtml(view.cost.priceSource)}">pricing source</a>. Actual spending is unavailable.</p><details><summary>Coverage details</summary><ul>${gaps}</ul><p>Duplicate rows: ${number(view.coverage.duplicateRows)}.</p></details></section>
  ${comparison}${assessment}<label>Filter rows <input type="search" id="filter" aria-label="Filter report rows"></label>
  ${view.sections.map(table).join('')}
  <script>document.getElementById('filter').addEventListener('input',e=>{const q=e.target.value.toLowerCase();for(const row of document.querySelectorAll('tr[data-search]'))row.hidden=!row.dataset.search.includes(q)});</script>
  </main></body></html>`;
}
