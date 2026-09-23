const DAY = 86_400_000;

function localParts(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant);
  return Object.fromEntries(parts.map(({ type, value }) => [type, Number(value)]));
}

function dateString(date) {
  return date.toISOString().slice(0, 10);
}

function shiftDate(ymd, days) {
  return dateString(new Date(Date.parse(`${ymd}T12:00:00Z`) + days * DAY));
}

function zonedMidnight(ymd, timeZone) {
  const target = Date.parse(`${ymd}T00:00:00Z`);
  if (!Number.isFinite(target)) throw new Error(`Invalid calendar date: ${ymd}`);
  let candidate = target;
  for (let i = 0; i < 3; i++) {
    const part = localParts(candidate, timeZone);
    const local = Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second);
    candidate += target - local;
  }
  return new Date(candidate).toISOString();
}

function nextMonth(ymd, amount) {
  const [year, month] = ymd.split('-').map(Number);
  return dateString(new Date(Date.UTC(year, month - 1 + amount, 1)));
}

function period(from, to, timeZone) {
  return { from: zonedMidnight(from, timeZone), to: zonedMidnight(to, timeZone) };
}

function calendarPeriod(text, today, timeZone) {
  const year = Number(today.slice(0, 4));
  const monthStart = `${today.slice(0, 7)}-01`;
  const weekday = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
  const weekStart = shiftDate(today, -weekday);
  if (/\b(?:all available history|all history|entire history|everything ever)\b/i.test(text)) {
    return { history: 'all-available', value: null };
  }
  if (/\bthis week\b/i.test(text)) return { history: 'period', value: period(weekStart, shiftDate(weekStart, 7), timeZone), unit: 'week' };
  if (/\blast week\b/i.test(text)) return { history: 'period', value: period(shiftDate(weekStart, -7), weekStart, timeZone), unit: 'week' };
  if (/\bthis month\b/i.test(text)) return { history: 'period', value: period(monthStart, nextMonth(monthStart, 1), timeZone), unit: 'month' };
  if (/\b(?:last|previous) month\b/i.test(text)) return { history: 'period', value: period(nextMonth(monthStart, -1), monthStart, timeZone), unit: 'month' };
  if (/\bthis year\b/i.test(text)) return { history: 'period', value: period(`${year}-01-01`, `${year + 1}-01-01`, timeZone), unit: 'year' };
  if (/\blast year\b/i.test(text)) return { history: 'period', value: period(`${year - 1}-01-01`, `${year}-01-01`, timeZone), unit: 'year' };
  const days = text.match(/\b(?:last|past)\s+(\d{1,3})\s+days\b/i);
  if (days) return { history: 'period', value: period(shiftDate(today, -Number(days[1]) + 1), shiftDate(today, 1), timeZone), unit: 'days' };
  const dates = [...text.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)].map((match) => match[1]);
  if (dates.length === 2) return { history: 'period', value: period(dates[0], shiftDate(dates[1], 1), timeZone), unit: 'dates' };
  if (dates.length === 1) return { history: 'period', value: period(dates[0], shiftDate(dates[0], 1), timeZone), unit: 'day' };
  return null;
}

function previousPeriod(query, timeZone) {
  if (!query.period) return null;
  const from = query.period.from;
  const to = query.period.to;
  if (query.periodUnit === 'month') {
    const start = localParts(from, timeZone);
    const ymd = `${start.year}-${String(start.month).padStart(2, '0')}-01`;
    return period(nextMonth(ymd, -1), ymd, timeZone);
  }
  const duration = Date.parse(to) - Date.parse(from);
  return { from: new Date(Date.parse(from) - duration).toISOString(), to: from };
}

function detectProjects(text, projects, previous) {
  if (/\b(?:every|all) projects\b/i.test(text)) return { value: [] };
  const matches = projects.filter(({ name, key }) =>
    [name, key].some((label) => new RegExp(`(^|[^\\w])${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w]|$)`, 'i').test(text)));
  if (matches.length) return { value: matches.map(({ key }) => key) };
  const named = text.match(/\b(?:only|for|in)\s+([A-Z][\w-]+)\b/);
  if (named && !/^(?:all|every|last|this|usage|tokens|cost|the|my|browser)$/i.test(named[1])) {
    return { question: `Which project did you mean by “${named[1]}”?` };
  }
  return { value: previous?.projects ?? [] };
}

function detectModels(text, models, previous) {
  if (/\b(?:every|all) models\b/i.test(text)) return [];
  const found = models.filter((model) => {
    const short = model.replace(/^claude-/, '').replace(/-/g, '[ -]?');
    return new RegExp(`\\b(?:claude[ -]?)?${short}\\b`, 'i').test(text);
  });
  return found.length ? found : previous?.models ?? [];
}

function clarification(question) {
  return { status: 'clarification', question };
}

export function resolveReportQuery(request, {
  previous = null, now = new Date().toISOString(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  projects = [], models = [],
} = {}) {
  if (typeof request !== 'string' || !request.trim()) return clarification('What would you like Rex to report?');
  const text = request.trim();
  const todayParts = localParts(new Date(now), timeZone);
  const today = `${todayParts.year}-${String(todayParts.month).padStart(2, '0')}-${String(todayParts.day).padStart(2, '0')}`;
  const projectResult = detectProjects(text, projects, previous);
  if (projectResult.question) return clarification(projectResult.question);
  if (/\b(?:sometime|recently|a while ago|around then)\b/i.test(text)) {
    return clarification('Which date range should I use?');
  }
  const selected = calendarPeriod(text, today, timeZone);
  const weekPair = /\bthis week\b.*\b(?:last|previous) week\b/i.test(text);
  const previousComparison = /\b(?:compare|versus|vs\.?|against)\b/i.test(text) &&
    /\b(?:previous|last) month\b/i.test(text) && /\b(?:that|it|this report)\b/i.test(text);
  const reference = /\b(?:that|it|this report|that finding)\b/i.test(text);
  if (reference && !previous && (previousComparison || /\b(?:show|open|compare)\b/i.test(text))) {
    return clarification('Which earlier report should I use?');
  }
  const drillDown = /\b(?:sessions?|evidence)\s+behind\s+(?:that|this)\s+finding\b/i.test(text);
  if (drillDown && !previous?.findingId) return clarification('Which finding should I show sessions for?');
  const comparison = /\b(?:compare|versus|vs\.?|against)\b/i.test(text);
  const hasNewKind = /\b(?:usage|tokens?|cost|habits?|behavior|time sinks?|wasting time|interruptions?|recommend(?:ed|ations?)?|interventions?|changes rex)\b/i.test(text);
  const kind = drillDown ? 'sessions' : comparison ? 'comparison' :
    /\b(?:recommend(?:ed|ations?)?|interventions?|changes rex)\b/i.test(text) ? 'intervention' :
    /\b(?:habits?|behavior|time sinks?|wasting time|interruptions?)\b/i.test(text) ? 'behavior' :
    previous && !hasNewKind ? previous.kind : 'usage';
  const explicitOptIn = /\b(?:analy[sz]e|inspect|review)\s+(?:the\s+)?(?:transcript|session|conversation)\s+content\b|\b(?:deep|semantic)\s+content\s+analysis\b/i.test(text);
  const metricsOnly = /\bmetrics[- ]only\b/i.test(text);
  const query = {
    kind,
    history: selected?.history ?? previous?.history ?? 'all-available',
    period: selected ? selected.value : previous?.period ?? null,
    periodUnit: selected?.unit ?? previous?.periodUnit ?? null,
    comparePeriod: null,
    projects: projectResult.value,
    models: detectModels(text, models, previous),
    timeZone,
    contentAnalysis: metricsOnly ? false : explicitOptIn || previous?.contentAnalysis === true,
    surface: /\b(?:browser|web page)\b/i.test(text) ? 'browser' : /\b(?:terminal|tui)\b/i.test(text) ? 'terminal' : previous?.surface ?? 'default',
    findingId: drillDown ? previous.findingId : previous?.findingId ?? null,
  };
  if (weekPair) {
    query.comparePeriod = calendarPeriod('last week', today, timeZone).value;
  } else if (previousComparison) {
    query.history = previous.history;
    query.period = previous.period;
    query.periodUnit = previous.periodUnit;
    query.comparePeriod = calendarPeriod('last month', today, timeZone).value;
  } else if (comparison) {
    query.comparePeriod = previousPeriod(query, timeZone);
    if (!query.comparePeriod) return clarification('Which periods should I compare?');
  } else if (previous && !selected) {
    query.comparePeriod = previous.comparePeriod ?? null;
  }
  return { status: 'resolved', query };
}

export function collectorOptions(query, root) {
  if (query.projects.length > 1) return query.projects.map((project) => ({ root, from: query.period?.from, to: query.period?.to, project }));
  return [{ root, from: query.period?.from, to: query.period?.to,
    ...(query.projects.length ? { project: query.projects[0] } : {}) }];
}
