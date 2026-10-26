import { Link, useRouter } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { dayLabel, full } from '../charts/data';
import { NoAccounts } from '../illustrations';
import { Empty } from '../PageHead';
import { useToast } from '../Toasts';
import { when } from '../ui';
import { syncAccountNow } from '../../server/channels.functions';
import type { getGrowth } from '../../server/stats.functions';
import { CHANNEL_NAMES, channelIcon } from '../../server/view';

type GrowthData = Awaited<ReturnType<typeof getGrowth>>;
type AccountGrowthView = GrowthData['accounts'][number];
type Measure = 'followers' | 'following' | 'posts';
const MEASURES: Array<{ value: Measure; label: string }> = [
  { value: 'followers', label: 'Followers' },
  { value: 'following', label: 'Following' },
  { value: 'posts', label: 'Posts' },
];

/**
 * How each account grew, from its daily snapshots (docs/decisions/account-snapshots.md), as one
 * table: the latest numbers with their change over the period, a sparkline of the measure chosen,
 * when it was last synced, and Sync now, the same action as on the Channels page. The sparklines
 * are drawn for the eye only; "Show the data" lays every day's number out as a table.
 */
export function Accounts({ data }: { data: GrowthData }) {
  const [measure, setMeasure] = useState<Measure>('followers');
  const [asTable, setAsTable] = useState(false);
  const tableId = useId();
  const buckets = days(data.from, data.to);
  const measureName = MEASURES.find((m) => m.value === measure)?.label ?? measure;
  if (data.accounts.length === 0) {
    return (
      <Empty art={<NoAccounts width={240} />} title="No account numbers yet" action={<Link className="btn" to="/channels">Go to Channels</Link>}>
        Each connected account is read once a day; its followers, following and posts show here from its first reading.
      </Empty>
    );
  }
  return (
    <section className="stats-panel" aria-labelledby="accounts-title">
      <div className="section-head">
        <h2 id="accounts-title" className="stats-panel-title">
          Account growth
        </h2>
        <div className="seg" role="radiogroup" aria-label="Measure in the sparklines">
          {MEASURES.map((m) => (
            <label key={m.value}>
              <input type="radio" name="growth-measure" checked={measure === m.value} onChange={() => setMeasure(m.value)} />
              <span>{m.label}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="stats-scroll" role="region" aria-labelledby="accounts-title" tabIndex={0}>
        <table className="table stats-table accounts-table">
          <thead>
            <tr>
              <th scope="col">Account</th>
              {MEASURES.map((m) => (
                <th key={m.value} scope="col" className="num">
                  {m.label}
                </th>
              ))}
              <th scope="col">
                {measureName}, {dayLabel(data.from)} – {dayLabel(data.to)}
              </th>
              <th scope="col">Last synced</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.accounts.map((a) => (
              <AccountRow key={a.id} account={a} measure={measure} buckets={buckets} />
            ))}
          </tbody>
        </table>
      </div>
      <div className="stats-panel-foot">
        <button type="button" className="btn btn-small" aria-expanded={asTable} aria-controls={tableId} onClick={() => setAsTable((v) => !v)}>
          {asTable ? 'Hide the data' : 'Show the data'}
        </button>
      </div>
      {asTable && <DayTable id={tableId} accounts={data.accounts} measure={measure} measureName={measureName} buckets={buckets} />}
    </section>
  );
}

/** Every day of the period: a missed snapshot shows as a gap rather than squeezing the days together */
function days(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`) && out.length < 800; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

function AccountRow({ account, measure, buckets }: { account: AccountGrowthView; measure: Measure; buckets: string[] }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const byDay = new Map(account.points.map((p) => [p.day, p[measure]]));
  const values = buckets.map((d) => byDay.get(d) ?? null);
  const icon = channelIcon(account.channel);
  const sync = async () => {
    setBusy(true);
    try {
      const result = await syncAccountNow({ data: account.id });
      const details = result.lines.join('\n') || undefined;
      if (result.state === 'completed') toast.done(`${account.label} synced`, details);
      else if (result.state === 'failed') toast.fail(result.lines[0] ?? `${account.label} could not be synced`);
      else toast.done(`Syncing ${account.label}`, 'It is still running: reload the page in a minute to see it.');
      await router.invalidate();
    } catch (error) {
      toast.fail(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <tr>
      <th scope="row">
        <span className="stats-who">
          {icon ? <img className="icon" src={icon} alt="" /> : null}
          <span className="visually-hidden">{CHANNEL_NAMES[account.channel] ?? account.channel}: </span>
          <span className="stats-who-name">{account.label}</span>
        </span>
      </th>
      {MEASURES.map((m) => {
        const now = account.latest?.[m.value];
        const change = account.change[m.value];
        return (
          <td key={m.value} className="num">
            {now === null || now === undefined ? (
              <span className="muted" title={account.channel === 'devto' && m.value === 'following' ? 'dev.to does not say whom an account follows' : 'This network does not count this'}>
                —<span className="visually-hidden">not counted</span>
              </span>
            ) : (
              <>
                {full(now)}
                {change !== null && change !== 0 && (
                  <span className="stats-change">
                    {' '}
                    {change > 0 ? '+' : '−'}
                    {full(Math.abs(change))}
                    <span className="visually-hidden"> in the period</span>
                  </span>
                )}
              </>
            )}
          </td>
        );
      })}
      <td className="stats-spark-cell">{values.some((v) => v !== null) ? <Sparkline values={values} /> : <span className="muted">Not counted</span>}</td>
      <td className="stats-synced">
        {account.syncedAt ? `${when(account.syncedAt)} UTC` : 'Never'}
        {account.stale && <span className="stale"> · over 36 hours ago</span>}
      </td>
      <td className="stats-row-action">
        <button type="button" className="btn btn-small" disabled={busy} onClick={() => void sync()}>
          {busy ? 'Syncing…' : 'Sync now'}
          <span className="visually-hidden"> {account.label}</span>
        </button>
      </td>
    </tr>
  );
}

/**
 * A level over the period, scaled to its own range (followers move by a handful on top of hundreds,
 * so an axis from zero would draw a flat line). A missed day breaks the line instead of being guessed.
 */
function Sparkline({ values, width = 120, height = 28 }: { values: ReadonlyArray<number | null>; width?: number; height?: number }) {
  const known = values.filter((v): v is number => v !== null);
  const min = Math.min(...known);
  const max = Math.max(...known);
  const span = max - min || 1;
  const step = width / Math.max(1, values.length - 1);
  const y = (v: number) => (max === min ? height / 2 : height - 3 - ((v - min) / span) * (height - 6));
  const runs: Array<Array<[number, number]>> = [];
  let run: Array<[number, number]> = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (run.length > 0) runs.push(run);
      run = [];
    } else run.push([i * step, y(v)]);
  });
  if (run.length > 0) runs.push(run);
  return (
    <svg className="stats-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {/* The whole period as a hairline, so an account read on only a few days shows where those days fall */}
      <line x1={0} x2={width} y1={height - 1} y2={height - 1} stroke="var(--sc-hairline)" strokeWidth={1} />
      {runs.map((points, i) => {
        const [first] = points;
        return points.length === 1 && first ? (
          <circle key={i} cx={first[0]} cy={first[1]} r={2} fill="currentColor" />
        ) : (
          <polyline key={i} points={points.map(([x, py]) => `${x.toFixed(1)},${py.toFixed(1)}`).join(' ')} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        );
      })}
    </svg>
  );
}

/** The sparklines' numbers, a day per row and an account per column */
function DayTable({ id, accounts, measure, measureName, buckets }: { id: string; accounts: AccountGrowthView[]; measure: Measure; measureName: string; buckets: string[] }) {
  const byAccount = accounts.map((a) => new Map(a.points.map((p) => [p.day, p[measure]])));
  return (
    <div id={id} className="chart-table" tabIndex={0} role="region" aria-label={`${measureName} per day, by account`}>
      <table className="table">
        <caption className="visually-hidden">{measureName} per day, by account</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            {accounts.map((a) => (
              <th key={a.id} scope="col">
                {a.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {buckets.map((d) => (
            <tr key={d}>
              <th scope="row">{dayLabel(d, true)}</th>
              {byAccount.map((values, i) => {
                const v = values.get(d);
                return <td key={accounts[i]?.id ?? i}>{v === null || v === undefined ? '—' : full(v)}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
