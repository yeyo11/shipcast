import { Link, useRouter } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { full } from '../charts/data';
import { assignColours } from '../charts/palette';
import { LineChart } from '../charts/TimeChart';
import { NoAccounts } from '../illustrations';
import { Empty } from '../PageHead';
import { useToast } from '../Toasts';
import { Avatar, ChannelName, when } from '../ui';
import { syncAccountNow } from '../../server/channels.functions';
import type { getGrowth } from '../../server/stats.functions';

type GrowthData = Awaited<ReturnType<typeof getGrowth>>;
type AccountGrowthView = GrowthData['accounts'][number];
type Measure = 'followers' | 'following' | 'posts';
const MEASURES: Array<{ value: Measure; label: string }> = [
  { value: 'followers', label: 'Followers' },
  { value: 'following', label: 'Following' },
  { value: 'posts', label: 'Posts' },
];

/**
 * How each account grew, from its daily snapshots (docs/decisions/account-snapshots.md): one small
 * chart per account of the measure chosen, the latest numbers with their change over the period,
 * when it was last synced, and Sync now, the same action as on the Channels page.
 */
export function Growth({ data }: { data: GrowthData }) {
  const [measure, setMeasure] = useState<Measure>('followers');
  const colours = useMemo(() => assignColours(data.accounts.map((a) => ({ key: String(a.id), channel: a.channel, id: a.id }))), [data.accounts]);
  return (
    <section className="growth" aria-labelledby="growth-title">
      <div className="section-head">
        <h2 id="growth-title" className="ph">
          Account growth
        </h2>
        <div className="seg" role="radiogroup" aria-label="Measure">
          {MEASURES.map((m) => (
            <label key={m.value}>
              <input type="radio" name="growth-measure" checked={measure === m.value} onChange={() => setMeasure(m.value)} />
              <span>{m.label}</span>
            </label>
          ))}
        </div>
      </div>
      {data.accounts.length === 0 ? (
        <Empty art={<NoAccounts width={240} />} title="No account numbers yet" action={<Link className="btn" to="/channels">Go to Channels</Link>}>
          Each connected account is read once a day; its followers, following and posts show here from its first reading.
        </Empty>
      ) : (
        <ul className="growth-list">
          {data.accounts.map((a) => (
            <GrowthCard key={a.id} account={a} measure={measure} colour={colours.get(String(a.id)) ?? 'var(--sc-text)'} buckets={days(data.from, data.to)} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Every day of the period: a missed snapshot shows as a gap rather than squeezing the days together */
function days(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`) && out.length < 800; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

function GrowthCard({ account, measure, colour, buckets }: { account: AccountGrowthView; measure: Measure; colour: string; buckets: string[] }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const byDay = new Map(account.points.map((p) => [p.day, p[measure]]));
  const values = buckets.map((d) => byDay.get(d) ?? null);
  const counted = account.latest?.[measure] !== null && account.latest?.[measure] !== undefined;
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
    <li className="growth-card">
      <header className="growth-head">
        <div className="account-who">
          <Avatar src={account.avatarUrl} alt="" size={36} />
          <div style={{ minWidth: 0 }}>
            <strong className="break">{account.label}</strong>
            <div className="muted growth-network">
              <ChannelName channel={account.channel} />
            </div>
          </div>
        </div>
        <button type="button" className="btn btn-small" disabled={busy} onClick={() => void sync()}>
          {busy ? 'Syncing…' : 'Sync now'}
          <span className="visually-hidden"> {account.label}</span>
        </button>
      </header>
      <dl className="growth-numbers">
        {MEASURES.map((m) => {
          const now = account.latest?.[m.value];
          if (now === null || now === undefined) return null;
          const change = account.change[m.value];
          return (
            <div key={m.value}>
              <dt>{m.label}</dt>
              <dd>
                {full(now)}
                {change !== null && change !== 0 && (
                  <span className="growth-change">
                    {' '}
                    {change > 0 ? '+' : '−'}
                    {full(Math.abs(change))}
                    <span className="visually-hidden"> in the period</span>
                  </span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      <p className="muted growth-synced">
        {account.syncedAt ? `Last synced ${when(account.syncedAt)} UTC` : 'Never synced'}
        {account.stale && <span className="stale"> · not synced for over 36 hours</span>}
      </p>
      {counted ? (
        <LineChart
          title={`${account.label}: ${measure} per day`}
          buckets={buckets}
          unit="day"
          series={[{ key: String(account.id), label: MEASURES.find((m) => m.value === measure)?.label ?? measure, colour, values }]}
          levels
          zoomable={false}
          height={150}
        />
      ) : (
        <p className="muted">{account.channel === 'devto' && measure === 'following' ? 'dev.to does not say whom an account follows.' : 'This network does not count this.'}</p>
      )}
    </li>
  );
}
