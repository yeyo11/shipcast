import { merge, percentile, type Histogram } from './histogram.ts';
import type { CallCount, HourRange, StoredCheck, TelemetryStore, TimingCount } from './store.ts';

/**
 * The KPIs of docs/plans/performance-refactor.md ("Instrumentation and the before/after
 * comparison"), read from the stored hours of one window: what the before/after report prints, side
 * by side, so every number in it comes from the tables, not from an estimate. Calls made for the
 * probe's own page loads are left out of every count.
 */
export interface WindowNumbers {
  range: HourRange;
  /** Hours the window holds numbers for, of the hours it spans */
  hoursWithData: number;
  hours: number;
  callsPerDay: number;
  callsPerDayByProvider: Record<string, number>;
  githubCallsPerDay: number;
  /** Of GitHub's GETs, the share answered 304 */
  github304Share: number;
  /** Server-side p95 of each server function, ms */
  fnP95: Record<string, number>;
  /** Provider calls made per run of each server function */
  callsPerFnRun: Record<string, number>;
  /** Browser load p95 per probed page, ms */
  pageLoadP95: Record<string, number>;
  /** Runs, average and p95 duration, and provider calls per run, of each job queue */
  jobs: Record<string, { runsPerDay: number; avgMs: number; p95Ms: number | undefined; failures: number; callsPerRun: number }>;
  /** Highest share of its quota each provider reported */
  peakQuota: Record<string, number>;
  /** Latest value and share of runs that were ok, of each check */
  checks: Record<string, { runs: number; okShare: number; worst: number; last: number }>;
}

const HOUR_MS = 3_600_000;
const round = (n: number, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits;

const countable = (c: CallCount) => c.origin !== 'probe';

function hoursIn(range: HourRange): number {
  return Math.max(1, Math.round((Date.parse(range.to) - Date.parse(range.from)) / HOUR_MS));
}

export function windowNumbers(range: HourRange, calls: CallCount[], timings: TimingCount[], checks: StoredCheck[]): WindowNumbers {
  const hours = hoursIn(range);
  const days = hours / 24;
  const counted = calls.filter(countable);
  const hoursWithData = new Set([...counted.map((c) => c.hour), ...timings.map((t) => t.hour)]).size;

  const byProvider: Record<string, number> = {};
  for (const c of counted) byProvider[c.provider] = (byProvider[c.provider] ?? 0) + c.calls;
  const total = Object.values(byProvider).reduce((s, n) => s + n, 0);
  const githubGets = counted.filter((c) => c.provider === 'github' && c.method === 'GET');
  const githubGetCount = githubGets.reduce((s, c) => s + c.calls, 0);
  const github304 = githubGets.filter((c) => c.status === 304).reduce((s, c) => s + c.calls, 0);

  const histograms = (kind: TimingCount['kind']) => {
    const out = new Map<string, { latency: Histogram[]; count: number; totalMs: number; failures: number }>();
    for (const t of timings.filter((x) => x.kind === kind)) {
      const entry = out.get(t.name) ?? { latency: [], count: 0, totalMs: 0, failures: 0 };
      entry.latency.push(t.latency);
      entry.count += t.count;
      entry.totalMs += t.totalMs;
      if (t.outcome === 'error') entry.failures += t.count;
      out.set(t.name, entry);
    }
    return out;
  };
  const callsBy = (prefix: string) => {
    const out: Record<string, number> = {};
    for (const c of counted.filter((x) => x.origin.startsWith(prefix))) out[c.origin.slice(prefix.length)] = (out[c.origin.slice(prefix.length)] ?? 0) + c.calls;
    return out;
  };

  const fnP95: Record<string, number> = {};
  const callsPerFnRun: Record<string, number> = {};
  const fnCalls = callsBy('fn:');
  for (const [name, h] of histograms('fn')) {
    const p95 = percentile(merge(...h.latency), 0.95);
    if (p95 !== undefined) fnP95[name] = round(p95);
    callsPerFnRun[name] = round((fnCalls[name] ?? 0) / Math.max(1, h.count), 2);
  }
  const pageLoadP95: Record<string, number> = {};
  for (const [name, h] of histograms('browser')) {
    const p95 = percentile(merge(...h.latency), 0.95);
    if (p95 !== undefined) pageLoadP95[name] = round(p95);
  }
  const jobs: WindowNumbers['jobs'] = {};
  const jobCalls = callsBy('job:');
  for (const [name, h] of histograms('job')) {
    jobs[name] = {
      runsPerDay: round(h.count / days),
      avgMs: round(h.totalMs / Math.max(1, h.count)),
      p95Ms: percentile(merge(...h.latency), 0.95),
      failures: h.failures,
      callsPerRun: round((jobCalls[name] ?? 0) / Math.max(1, h.count), 1),
    };
  }
  const peakQuota: Record<string, number> = {};
  for (const c of counted) if (c.quotaPeak !== undefined) peakQuota[c.provider] = Math.max(peakQuota[c.provider] ?? 0, round(c.quotaPeak, 3));

  const checkSummary: WindowNumbers['checks'] = {};
  for (const check of checks) {
    const s = (checkSummary[check.name] ??= { runs: 0, okShare: 0, worst: check.value, last: check.value });
    s.runs += 1;
    s.okShare += check.ok ? 1 : 0;
    // Freshness is a share (higher is better); the other checks count problems (lower is better)
    s.worst = check.name === 'freshness' ? Math.min(s.worst, check.value) : Math.max(s.worst, check.value);
    s.last = check.value;
  }
  for (const s of Object.values(checkSummary)) s.okShare = round(s.okShare / s.runs, 3);

  return {
    range,
    hoursWithData,
    hours,
    callsPerDay: round(total / days),
    callsPerDayByProvider: Object.fromEntries(Object.entries(byProvider).map(([p, n]) => [p, round(n / days)])),
    githubCallsPerDay: round((byProvider.github ?? 0) / days),
    github304Share: githubGetCount === 0 ? 0 : round(github304 / githubGetCount, 3),
    fnP95,
    callsPerFnRun,
    pageLoadP95,
    jobs,
    peakQuota,
    checks: checkSummary,
  };
}

export async function readWindow(store: TelemetryStore, range: HourRange): Promise<WindowNumbers> {
  return windowNumbers(range, await store.calls(range), await store.timings(range), await store.checks(range));
}

const change = (before: number | undefined, after: number | undefined): string => {
  if (before === undefined || after === undefined) return '—';
  if (before === 0) return after === 0 ? '0 %' : 'new';
  return `${after >= before ? '+' : ''}${round(((after - before) / before) * 100)} %`;
};
const show = (n: number | undefined, unit = '') => (n === undefined ? '—' : `${n}${unit}`);

function table(title: string, rows: Array<[string, number | undefined, number | undefined, string?]>): string {
  const lines = [`### ${title}`, '', '| | Before | After | Change |', '| --- | --- | --- | --- |'];
  for (const [label, before, after, unit] of rows) lines.push(`| ${label} | ${show(before, unit)} | ${show(after, unit)} | ${change(before, after)} |`);
  return lines.join('\n');
}

const keys = (...records: Array<Record<string, unknown>>) => [...new Set(records.flatMap((r) => Object.keys(r)))].sort();

/** The before/after report in Markdown: one table per KPI, every value from the stored windows */
export function compareReport(before: WindowNumbers, after: WindowNumbers): string {
  const out = [
    `Before: ${before.range.from} to ${before.range.to} (${before.hoursWithData} of ${before.hours} hours with numbers). After: ${after.range.from} to ${after.range.to} (${after.hoursWithData} of ${after.hours} hours).`,
    table('Provider calls per day', [['Total', before.callsPerDay, after.callsPerDay], ...keys(before.callsPerDayByProvider, after.callsPerDayByProvider).map((p): [string, number | undefined, number | undefined] => [p, before.callsPerDayByProvider[p] ?? 0, after.callsPerDayByProvider[p] ?? 0])]),
    table('GitHub', [
      ['Calls per day', before.githubCallsPerDay, after.githubCallsPerDay],
      ['Share of GETs answered 304', round(before.github304Share * 100), round(after.github304Share * 100), ' %'],
    ]),
    table('Server functions, p95 (ms) and provider calls per run', keys(before.fnP95, after.fnP95).flatMap((f): Array<[string, number | undefined, number | undefined, string?]> => [
      [`${f} p95`, before.fnP95[f], after.fnP95[f], ' ms'],
      [`${f} calls per run`, before.callsPerFnRun[f], after.callsPerFnRun[f]],
    ])),
    table('Page load in the browser, p95', keys(before.pageLoadP95, after.pageLoadP95).map((p): [string, number | undefined, number | undefined, string] => [p, before.pageLoadP95[p], after.pageLoadP95[p], ' ms'])),
    table('Jobs', keys(before.jobs, after.jobs).flatMap((j): Array<[string, number | undefined, number | undefined, string?]> => [
      [`${j} runs per day`, before.jobs[j]?.runsPerDay, after.jobs[j]?.runsPerDay],
      [`${j} average`, before.jobs[j]?.avgMs, after.jobs[j]?.avgMs, ' ms'],
      [`${j} provider calls per run`, before.jobs[j]?.callsPerRun, after.jobs[j]?.callsPerRun],
      [`${j} failures`, before.jobs[j]?.failures, after.jobs[j]?.failures],
    ])),
    table('Peak quota use per provider', keys(before.peakQuota, after.peakQuota).map((p): [string, number | undefined, number | undefined, string] => [p, before.peakQuota[p] === undefined ? undefined : round(before.peakQuota[p]! * 100), after.peakQuota[p] === undefined ? undefined : round(after.peakQuota[p]! * 100), ' %'])),
    table('Checks: share of runs ok, worst value', keys(before.checks, after.checks).flatMap((c): Array<[string, number | undefined, number | undefined, string?]> => [
      [`${c} ok`, before.checks[c] && round(before.checks[c].okShare * 100), after.checks[c] && round(after.checks[c].okShare * 100), ' %'],
      [`${c} worst`, before.checks[c]?.worst, after.checks[c]?.worst],
    ])),
  ];
  return out.join('\n\n');
}
