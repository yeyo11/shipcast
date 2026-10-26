import { useEffect, useId, useState } from 'react';
import { MultiCombobox } from '../ui/Combobox';
import { DateRangePicker } from '../ui/DatePicker';
import { dateToDay } from '../ui/dates';
import { Drawer } from '../ui/Drawer';
import { Popover } from '../ui/Popover';
import { usePhone } from '../ui/ResponsiveMenu';
import { Select, type Option } from '../ui/Select';
import { DAYS_LIMIT, MAX_DAYS, daysBetween, isDay, type Bucket, type GroupBy, type Kind, type Metric, type Period, type StatsSearch } from '../../server/stats-search';

/*
 * The Stats page's filters: the period at hand, as a segmented control, and everything else (the
 * filters, the grouping, the chart's kind and interval, the comparison, a custom range) one click
 * away behind "Filters". Every change goes to the address (the page's search params), which is what
 * loads the numbers, so a view is always shareable. On a phone the bar is one row (the period as a
 * Select, Filters as a bottom sheet). It sits in the page's toolbar; the range is the caption under it.
 */

export const METRIC_NAMES: Record<Metric, string> = { views: 'Views', reactions: 'Reactions', comments: 'Comments', shares: 'Shares', clicks: 'Clicks', impressions: 'Impressions' };

const PERIOD_OPTIONS: Array<Option<Exclude<Period, 'custom'>>> = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'all', label: 'All' },
];
const GROUP_OPTIONS: Array<Option<GroupBy>> = [
  { value: 'channel', label: 'Channel' },
  { value: 'account', label: 'Account' },
  { value: 'launch', label: 'Launch' },
];

export interface FilterBarProps {
  search: StatsSearch;
  /** The period's real days, from the server: what a custom range starts from */
  period: { from: string; to: string; days: number };
  options: { channels: Array<Option<string>>; accounts: Array<Option<string>>; launches: Array<Option<string>> };
  onChange: (patch: Partial<StatsSearch>) => void;
}

export function FilterBar({ search, period, options, onChange }: FilterBarProps) {
  const id = useId();
  // How many choices narrow or reshape the view, so a closed "Filters" still says something is set
  const set =
    (search.channels ? 1 : 0) +
    (search.accounts ? 1 : 0) +
    (search.launches ? 1 : 0) +
    (search.groupBy !== 'channel' ? 1 : 0) +
    (search.chart !== 'line' ? 1 : 0) +
    (search.bucket !== 'day' ? 1 : 0) +
    (search.compare ? 1 : 0);
  const phone = usePhone();
  const pick = (period: Period) => {
    if (period !== 'custom') onChange({ period, from: undefined, to: undefined });
  };
  const periodOptions: Array<Option<Period>> = [...PERIOD_OPTIONS, ...(search.period === 'custom' ? [{ value: 'custom' as const, label: 'Custom' }] : [])];
  const trigger = (
    <button type="button" className="btn btn-small stats-filters-button">
      Filters
      {set > 0 && (
        <span className="stats-filters-count">
          {set}
          <span className="visually-hidden"> set</span>
        </span>
      )}
    </button>
  );
  const filters = <Filters search={search} period={period} options={options} onChange={onChange} />;
  return (
    <section className="stats-filterbar" aria-label="What to show">
      {/* Both shapes are rendered and CSS shows one, so the server's page is already right on a phone */}
      <div className="seg stats-period" role="radiogroup" aria-label="Period">
        {periodOptions.map((o) => (
          <label key={o.value}>
            <input type="radio" name={`${id}-period`} checked={search.period === o.value} readOnly={o.value === 'custom'} onChange={() => pick(o.value)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
      <div className="stats-period-select">
        <Select<Period> label={<span className="visually-hidden">Period</span>} options={periodOptions} value={search.period} onValueChange={pick} />
      </div>
      {phone ? (
        <Drawer title="Filters" trigger={trigger}>
          {filters}
        </Drawer>
      ) : (
        <Popover title="Filters" className="stats-filters-popup" align="start" trigger={trigger}>
          {filters}
        </Popover>
      )}
    </section>
  );
}

function Filters({ search, period, options, onChange }: FilterBarProps) {
  const id = useId();
  const [from, setFrom] = useState(period.from);
  const [to, setTo] = useState(period.to);
  useEffect(() => {
    setFrom(period.from);
    setTo(period.to);
  }, [period.from, period.to]);
  const rangeProblem = !isDay(from) || !isDay(to) ? 'Pick both days.' : to < from ? 'The end comes after the start.' : daysBetween(from, to) > MAX_DAYS ? `At most ${MAX_DAYS} days.` : null;
  const weeksOnly = period.days > DAYS_LIMIT;
  const filtered = Boolean(search.channels || search.accounts || search.launches);
  return (
    <div className="stats-filters">
      <div className="stats-filters-group" role="group" aria-labelledby={`${id}-narrow`}>
        <h3 className="stats-filters-heading" id={`${id}-narrow`}>
          Narrow to
        </h3>
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
        {filtered && (
          <button type="button" className="btn-link stats-filters-clear" onClick={() => onChange({ channels: undefined, accounts: undefined, launches: undefined })}>
            Clear the filters
          </button>
        )}
      </div>
      <div className="stats-filters-group" role="group" aria-labelledby={`${id}-chart`}>
        <h3 className="stats-filters-heading" id={`${id}-chart`}>
          The chart
        </h3>
        <Select<GroupBy> label="Group the chart by" options={GROUP_OPTIONS} value={search.groupBy} onValueChange={(groupBy) => onChange({ groupBy })} />
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
        <label className="check">
          <input type="checkbox" checked={search.compare} onChange={(e) => onChange({ compare: e.target.checked })} />
          Compare with the previous period
        </label>
      </div>
      <form
        className="stats-filters-range"
        onSubmit={(e) => {
          e.preventDefault();
          if (!rangeProblem) onChange({ period: 'custom', from, to });
        }}
      >
        <span className="label" aria-hidden="true">
          Custom range
        </span>
        <DateRangePicker
          label="Custom range"
          from={from}
          to={to}
          max={dateToDay(new Date())}
          onChange={(range) => {
            setFrom(range.from);
            setTo(range.to);
          }}
        />
        <button className="btn btn-small" type="submit" disabled={rangeProblem !== null}>
          Show this range
        </button>
        {rangeProblem && (
          <small className="muted" role="status">
            {rangeProblem}
          </small>
        )}
      </form>
    </div>
  );
}

/** Radio buttons as one control (Cartel's `.seg`), with a visible label for the group */
function Segmented<V extends string>({ label, name, value, options, onChange, disabled }: { label: string; name: string; value: V; options: Array<{ value: V; label: string }>; onChange: (v: V) => void; disabled?: boolean }) {
  const labelId = useId();
  return (
    <div className="field stats-filters-seg">
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
