import { useEffect, useId, useState } from 'react';
import { MultiCombobox } from '../ui/Combobox';
import { Select, type Option } from '../ui/Select';
import { DAYS_LIMIT, MAX_DAYS, daysBetween, isDay, type Bucket, type GroupBy, type Kind, type Metric, type Period, type StatsSearch } from '../../server/stats-search';

/*
 * The Stats page's control bar, after PostHog's: the period, what to chart and how, the comparison
 * and the filters, in one calm row that wraps. Every change goes to the address (the page's search
 * params), which is what loads the numbers, so a view is always shareable.
 */

export const METRIC_NAMES: Record<Metric, string> = { views: 'Views', reactions: 'Reactions', comments: 'Comments', shares: 'Shares', clicks: 'Clicks', impressions: 'Impressions' };

const PERIOD_OPTIONS: Array<Option<Period>> = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'custom', label: 'Custom range' },
];
const METRIC_OPTIONS = (Object.keys(METRIC_NAMES) as Metric[]).map((m) => ({ value: m, label: METRIC_NAMES[m] }));
const GROUP_OPTIONS: Array<Option<GroupBy>> = [
  { value: 'channel', label: 'Channel' },
  { value: 'account', label: 'Account' },
  { value: 'launch', label: 'Launch' },
];

export interface ControlBarProps {
  search: StatsSearch;
  /** The period's real days, from the server: what a custom range starts from */
  period: { from: string; to: string; days: number };
  options: { channels: Array<Option<string>>; accounts: Array<Option<string>>; launches: Array<Option<string>> };
  onChange: (patch: Partial<StatsSearch>) => void;
}

export function ControlBar({ search, period, options, onChange }: ControlBarProps) {
  const id = useId();
  const [from, setFrom] = useState(period.from);
  const [to, setTo] = useState(period.to);
  const [custom, setCustom] = useState(search.period === 'custom');
  useEffect(() => {
    setFrom(period.from);
    setTo(period.to);
    setCustom(search.period === 'custom');
  }, [period.from, period.to, search.period]);
  const rangeProblem = !isDay(from) || !isDay(to) ? 'Pick both days.' : to < from ? 'The end comes after the start.' : daysBetween(from, to) > MAX_DAYS ? `At most ${MAX_DAYS} days.` : null;
  const weeksOnly = period.days > DAYS_LIMIT;

  return (
    <section className="controls" aria-label="What to show">
      <div className="controls-row">
        <Select<Period>
          label="Period"
          options={PERIOD_OPTIONS}
          value={custom ? 'custom' : search.period}
          onValueChange={(p) => {
            if (p === 'custom') setCustom(true);
            else {
              setCustom(false);
              onChange({ period: p, from: undefined, to: undefined });
            }
          }}
        />
        <Select<Metric> label="Metric" options={METRIC_OPTIONS} value={search.metric} onValueChange={(metric) => onChange({ metric })} />
        <Select<GroupBy> label="Group by" options={GROUP_OPTIONS} value={search.groupBy} onValueChange={(groupBy) => onChange({ groupBy })} />
      </div>
      {custom && (
        <form
          className="controls-row controls-range"
          onSubmit={(e) => {
            e.preventDefault();
            if (!rangeProblem) onChange({ period: 'custom', from, to });
          }}
        >
          <div className="field">
            <label className="label" htmlFor={`${id}-from`}>
              From
            </label>
            <input id={`${id}-from`} className="input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field">
            <label className="label" htmlFor={`${id}-to`}>
              To
            </label>
            <input id={`${id}-to`} className="input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </div>
          <button className="btn" type="submit" disabled={rangeProblem !== null}>
            Show this range
          </button>
          {rangeProblem && (
            <small className="muted" role="status">
              {rangeProblem}
            </small>
          )}
        </form>
      )}
      <div className="controls-row">
        <MultiCombobox label="Channels" noun="channels" options={options.channels} value={search.channels ?? []} onValueChange={(channels) => onChange({ channels: channels.length > 0 ? channels : undefined })} placeholder="All channels" />
        <MultiCombobox
          label="Accounts"
          noun="accounts"
          options={options.accounts}
          value={(search.accounts ?? []).map(String)}
          onValueChange={(accounts) => onChange({ accounts: accounts.length > 0 ? accounts.map(Number) : undefined })}
          placeholder="All accounts"
        />
        <MultiCombobox
          label="Launches"
          noun="launches"
          options={options.launches}
          value={(search.launches ?? []).map(String)}
          onValueChange={(launches) => onChange({ launches: launches.length > 0 ? launches.map(Number) : undefined })}
          placeholder="All launches"
          empty="No published launch matches."
        />
      </div>
      <div className="controls-row controls-toggles">
        <Segmented<Kind>
          label="Chart"
          name={`${id}-kind`}
          value={search.chart}
          options={[
            { value: 'line', label: 'Lines' },
            { value: 'area', label: 'Areas' },
            { value: 'bar', label: 'Bars' },
          ]}
          onChange={(chart) => onChange({ chart })}
        />
        <Segmented<Bucket>
          label={weeksOnly ? 'Interval (weeks past 120 days)' : 'Interval'}
          name={`${id}-bucket`}
          value={weeksOnly ? 'week' : search.bucket}
          disabled={weeksOnly}
          options={[
            { value: 'day', label: 'Days' },
            { value: 'week', label: 'Weeks' },
          ]}
          onChange={(bucket) => onChange({ bucket })}
        />
        <label className="check controls-compare">
          <input type="checkbox" checked={search.compare} onChange={(e) => onChange({ compare: e.target.checked })} />
          Compare with the previous period
        </label>
      </div>
    </section>
  );
}

/** Radio buttons as one control (Cartel's `.seg`), with a visible label for the group */
function Segmented<V extends string>({ label, name, value, options, onChange, disabled }: { label: string; name: string; value: V; options: Array<{ value: V; label: string }>; onChange: (v: V) => void; disabled?: boolean }) {
  const labelId = useId();
  return (
    <div className="field controls-seg">
      <span className="label" id={labelId}>
        {label}
      </span>
      <div className="seg" role="radiogroup" aria-labelledby={labelId}>
        {options.map((o) => (
          <label key={o.value}>
            <input type="radio" name={name} checked={value === o.value} disabled={disabled} onChange={() => onChange(o.value)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
