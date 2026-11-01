import { Link, useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { full, shortDay } from '../charts/data';
import { NoAccounts } from '../illustrations';
import { Diamond } from '../kit/Icon';
import { useToast } from '../Toasts';
import { syncAccountNow } from '../../server/channels.functions';
import type { getGrowth } from '../../server/stats.functions';
import { ago, daysSince, Glyph, StatsEmpty } from './parts';

type GrowthData = Awaited<ReturnType<typeof getGrowth>>;
type AccountGrowthView = GrowthData['accounts'][number];
type Measure = 'followers' | 'following' | 'posts';
const MEASURES: Array<{ value: Measure; label: string }> = [
  { value: 'followers', label: 'Followers' },
  { value: 'following', label: 'Following' },
  { value: 'posts', label: 'Posts' },
];

/** What a network calls its followers, where it is not "followers" */
const FOLLOWER_WORD: Record<string, string> = { telegram: 'Subscribers', newsletter: 'Subscribers', youtube: 'Subscribers' };

/**
 * How each account grew (board StatsAccounts), from its daily snapshots
 * (docs/decisions/account-snapshots.md): a card per account with the measure picked above, its change
 * over the period and a sparkline of it. An account whose credential failed, or that has gone unread
 * for over 36 hours, is the failure card: what it last read, and the way to fix it (Reconnect on
 * Channels for a failed credential, Sync now otherwise). Only accounts with an audience are here, and
 * each measure lists only the accounts whose network counts it; the sources of numbers are on Channels.
 */
export function Accounts({ data, days }: { data: GrowthData; days: number }) {
  const [measure, setMeasure] = useState<Measure>('followers');
  if (data.accounts.length === 0) {
    return (
      <StatsEmpty
        art={<NoAccounts width={240} />}
        title="No account numbers yet"
        actions={
          <Link className="k-btn" to="/channels">
            Go to Channels
          </Link>
        }
      >
        Each connected account is read once a day; its followers, following and posts show here from its first reading.
      </StatsEmpty>
    );
  }
  const buckets = everyDay(data.from, data.to);
  // A measure lists only the accounts whose network counts it: no card says only "not counted"
  const counting = data.accounts.filter((a) => counts(a, measure));
  return (
    <section aria-label="Account growth">
      <div className="k-px stats-gap14">
        <div className="k-seg" role="radiogroup" aria-label="Measure">
          {MEASURES.map((m) => (
            <button key={m.value} type="button" role="radio" aria-checked={measure === m.value} className={measure === m.value ? 'k-on' : undefined} onClick={() => setMeasure(m.value)}>
              {m.label}
            </button>
          ))}
        </div>
      </div>
      {counting.length === 0 ? (
        <p className="k-px k-sm k-muted stats-gap14">No connected network counts {MEASURES.find((m) => m.value === measure)?.label.toLowerCase()}.</p>
      ) : (
        <ul className="k-px k-stack k-g10 stats-gap14 stats-accounts">
          {counting.map((a) => (
            <AccountCard key={a.id} account={a} measure={measure} buckets={buckets} days={days} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Whether an account's network gives this figure: its latest reading has it, or any day did */
function counts(account: Pick<AccountGrowthView, 'latest' | 'points'>, measure: Measure): boolean {
  return (account.latest?.[measure] ?? null) !== null || account.points.some((p) => p[measure] !== null);
}

/** Every day of the period: a missed snapshot shows as a gap rather than squeezing the days together */
function everyDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`) && out.length < 800; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

function AccountCard({ account, measure, buckets, days }: { account: AccountGrowthView; measure: Measure; buckets: string[]; days: number }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const byDay = new Map(account.points.map((p) => [p.day, p[measure]]));
  // The sparkline runs to the last day read: a failing account's line stops where its readings stopped
  const lastRead = account.points.filter((p) => p[measure] !== null).at(-1)?.day;
  const values = buckets.map((d) => (lastRead && d > lastRead ? undefined : (byDay.get(d) ?? null))).filter((v): v is number | null => v !== undefined);
  const network = account.networkName;
  const bad = account.failing || account.stale;
  const now = account.latest?.[measure] ?? null;
  const change = account.change[measure];
  const word = measure === 'followers' ? (FOLLOWER_WORD[account.channel] ?? 'Followers') : measure === 'following' ? 'Following' : 'Posts';

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
    <li className={`k-card stats-account${bad ? ' k-fail' : ''}`}>
      <div className="k-hrow k-g10">
        <span className="k-ic stats-account-ic">
          <Glyph channel={account.channel} size={17} />
        </span>
        <div className="k-grow k-stack">
          <strong className="k-sm k-ellipsis">
            <span className="visually-hidden">{network}: </span>
            {account.label}
          </strong>
          {bad ? (
            <span className="k-xs stats-account-bad">
              <Diamond size={7} /> {account.failing ? 'Its credential failed' : account.syncedAt ? `Not synced for ${daysSince(account.syncedAt)} ${daysSince(account.syncedAt) === 1 ? 'day' : 'days'}` : 'Never synced'}
            </span>
          ) : (
            <span className="k-xs k-muted" suppressHydrationWarning>
              {account.syncedAt ? `synced ${ago(account.syncedAt)}` : 'not synced yet'}
            </span>
          )}
        </div>
      </div>
      <div className="k-hrow k-between stats-account-numbers">
        <div className="k-stack">
          <span className="k-d k-d30">{now === null ? '—' : full(now)}</span>
          <span className="k-xs k-muted">
            {now === null
              ? `${word}: not counted by ${network}`
              : bad
                ? `${word} · last read ${lastRead ? shortDay(lastRead) : 'never'}`
                : `${word} · ${change === null ? 'no change read' : `${change >= 0 ? '+' : '−'}${full(Math.abs(change))} in ${days} days`}`}
          </span>
        </div>
        {values.some((v) => v !== null) && <Sparkline values={values} total={buckets.length} />}
      </div>
      {bad && (
        <div className="k-hrow k-g8 k-wrap">
          {account.failing ? (
            <Link className="k-btn k-sm" to="/channels" search={{ focus: String(account.id) }}>
              Reconnect
            </Link>
          ) : (
            <button type="button" className="k-btn k-sm" disabled={busy} onClick={() => void sync()}>
              {busy ? 'Syncing…' : 'Sync now'}
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * A level over the period, scaled to its own range (followers move by a handful on top of hundreds,
 * so an axis from zero would draw a flat line), in the board's 110 × 36. A missed day breaks the line.
 */
function Sparkline({ values, total, width = 110, height = 36 }: { values: ReadonlyArray<number | null>; total: number; width?: number; height?: number }) {
  const known = values.filter((v): v is number => v !== null);
  const min = Math.min(...known);
  const max = Math.max(...known);
  const span = max - min || 1;
  const step = width / Math.max(1, total - 1);
  const y = (v: number) => (max === min ? height / 2 : height - 4 - ((v - min) / span) * (height - 8));
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
      {runs.map((points, i) => {
        const [first] = points;
        return points.length === 1 && first ? (
          <circle key={i} cx={first[0]} cy={first[1]} r={2} fill="var(--sc-yellow)" />
        ) : (
          <polyline key={i} points={points.map(([x, py]) => `${x.toFixed(1)},${py.toFixed(1)}`).join(' ')} fill="none" stroke="var(--sc-yellow)" strokeWidth={2.5} strokeLinejoin="round" />
        );
      })}
    </svg>
  );
}
