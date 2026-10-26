import { useEffect, useId, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { DateRangePicker } from '../ui/DatePicker';
import { dateToDay } from '../ui/dates';
import { Drawer } from '../ui/Drawer';
import { CloseIcon } from '../ui/icons';
import { Popover } from '../ui/Popover';
import { usePhone } from '../ui/ResponsiveMenu';
import { ScrollArea } from '../ui/ScrollArea';
import { Select, type Option } from '../ui/Select';
import { grouped, summarize, type FilterOption } from './filter-options';
import { DAYS_LIMIT, MAX_DAYS, daysBetween, isDay, type Bucket, type GroupBy, type Kind, type Metric, type Period, type StatsSearch } from '../../server/stats-search';

/*
 * The Stats page's filters, as one bar (Linear's and Plausible's pattern, 2026-10-26): the period,
 * then a pill per thing to narrow to (Channel, Account, Launch) and Chart for how the numbers are
 * drawn. A pill says what it holds ("3 accounts") rather than listing it, so the bar keeps its size
 * with a hundred accounts; it opens a list with a search, grouped (accounts by network, launches by
 * project), to tick. Every change goes to the address, which is what loads the numbers, so a view is
 * always shareable. On a phone the lists open as bottom sheets and the row scrolls sideways.
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
  options: { channels: FilterOption[]; accounts: FilterOption[]; launches: FilterOption[] };
  onChange: (patch: Partial<StatsSearch>) => void;
}

export function FilterBar({ search, period, options, onChange }: FilterBarProps) {
  const id = useId();
  const pick = (next: Period) => {
    if (next !== 'custom') onChange({ period: next, from: undefined, to: undefined });
  };
  const periodOptions: Array<Option<Period>> = [...PERIOD_OPTIONS, ...(search.period === 'custom' ? [{ value: 'custom' as const, label: 'Custom' }] : [])];
  const filtered = Boolean(search.channels || search.accounts || search.launches);
  // How the chart differs from its defaults, so a closed Chart still says something is set
  const reshaped = (search.groupBy !== 'channel' ? 1 : 0) + (search.chart !== 'line' ? 1 : 0) + (search.bucket !== 'day' ? 1 : 0) + (search.compare ? 1 : 0);
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
      <Dimension
        name="Channel"
        plural="channels"
        options={options.channels}
        value={search.channels ?? []}
        onValueChange={(channels) => onChange({ channels: channels.length > 0 ? channels : undefined })}
      />
      <Dimension
        name="Account"
        plural="accounts"
        options={options.accounts}
        value={(search.accounts ?? []).map(String)}
        onValueChange={(accounts) => onChange({ accounts: accounts.length > 0 ? accounts.map(Number) : undefined })}
      />
      <Dimension
        name="Launch"
        plural="launches"
        options={options.launches}
        value={(search.launches ?? []).map(String)}
        onValueChange={(launches) => onChange({ launches: launches.length > 0 ? launches.map(Number) : undefined })}
        empty="No published launch yet."
      />
      <Sheet
        title="The chart"
        trigger={
          <button type="button" className="btn btn-small stats-pill" data-set={reshaped > 0 || undefined}>
            Chart
            {reshaped > 0 && (
              <span className="stats-filters-count">
                {reshaped}
                <span className="visually-hidden"> changed</span>
              </span>
            )}
          </button>
        }
      >
        <ChartOptions search={search} period={period} onChange={onChange} />
      </Sheet>
      {filtered && (
        <button type="button" className="btn-link stats-clear" onClick={() => onChange({ channels: undefined, accounts: undefined, launches: undefined })}>
          Clear the filters
        </button>
      )}
    </section>
  );
}

/** A popover by its trigger on a desktop, a bottom sheet on a phone: the same content */
function Sheet({ title, trigger, children, className }: { title: string; trigger: ReactElement; children: ReactNode; className?: string }) {
  const phone = usePhone();
  return phone ? (
    <Drawer title={title} trigger={trigger}>
      {children}
    </Drawer>
  ) : (
    <Popover title={title} className={`stats-sheet${className ? ` ${className}` : ''}`} align="start" trigger={trigger}>
      {children}
    </Popover>
  );
}

/** One thing to narrow to: a pill that says what it holds, its list behind it, and a way to clear it */
function Dimension({ name, plural, options, value, onValueChange, empty }: { name: string; plural: string; options: FilterOption[]; value: string[]; onValueChange: (v: string[]) => void; empty?: string }) {
  const summary = summarize(value, options, plural);
  return (
    <span className="stats-pill-wrap" data-set={summary ? true : undefined}>
      <Sheet
        title={name}
        className="stats-sheet-list"
        trigger={
          <button type="button" className="btn btn-small stats-pill" data-set={summary ? true : undefined} aria-label={summary ? `${name}: ${summary}` : `${name}: all ${plural}`}>
            <span className="stats-pill-name">{name}</span>
            {summary && <span className="stats-pill-value">{summary}</span>}
          </button>
        }
      >
        <Checklist name={name} plural={plural} options={options} value={value} onValueChange={onValueChange} empty={empty} />
      </Sheet>
      {summary && (
        <button type="button" className="stats-pill-clear" aria-label={`Show every ${name.toLowerCase()} again`} onClick={() => onValueChange([])}>
          <CloseIcon size={14} />
        </button>
      )}
    </span>
  );
}

/** The list behind a pill: a search, then the choices under their groups, each a checkbox */
function Checklist({ name, plural, options, value, onValueChange, empty = `No ${plural} yet.` }: { name: string; plural: string; options: FilterOption[]; value: string[]; onValueChange: (v: string[]) => void; empty?: string }) {
  const id = useId();
  const [query, setQuery] = useState('');
  const groups = useMemo(() => grouped(options, query), [options, query]);
  const shown = groups.flatMap((g) => g.options.map((o) => o.value));
  const chosen = new Set(value);
  const toggle = (v: string, on: boolean) => onValueChange(on ? [...value, v] : value.filter((x) => x !== v));
  return (
    <div className="stats-checklist">
      {options.length > 6 && (
        <input
          className="input stats-checklist-search"
          type="search"
          placeholder={`Find ${plural}`}
          aria-label={`Find ${plural}`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          // A list this long is searched first
          autoFocus
        />
      )}
      <div className="stats-checklist-bar">
        <span className="muted" role="status">
          {value.length === 0 ? `All ${plural}` : `${value.length} of ${options.length}`}
        </span>
        <span className="stats-checklist-actions">
          <button type="button" className="btn-link" disabled={shown.every((v) => chosen.has(v))} onClick={() => onValueChange([...new Set([...value, ...shown])])}>
            {query ? 'Tick these' : 'Tick all'}
          </button>
          <button type="button" className="btn-link" disabled={value.length === 0} onClick={() => onValueChange([])}>
            Untick all
          </button>
        </span>
      </div>
      <ScrollArea maxHeight="min(360px, 50dvh)" label={`${name} list`}>
        {options.length === 0 ? (
          <p className="muted stats-checklist-empty">{empty}</p>
        ) : shown.length === 0 ? (
          <p className="muted stats-checklist-empty">Nothing matches “{query}”.</p>
        ) : (
          groups.map((g) => (
            <div key={g.group ?? ''} className="stats-checklist-group" role="group" aria-labelledby={g.group ? `${id}-${g.group}` : undefined}>
              {g.group && (
                <p className="stats-checklist-heading" id={`${id}-${g.group}`}>
                  {g.group}
                </p>
              )}
              {g.options.map((o) => (
                <label key={o.value} className="stats-checklist-item">
                  <input type="checkbox" checked={chosen.has(o.value)} onChange={(e) => toggle(o.value, e.target.checked)} />
                  <span className="stats-checklist-label">{o.label}</span>
                  {o.hint && o.hint !== o.group && <span className="muted stats-checklist-hint">{o.hint}</span>}
                </label>
              ))}
            </div>
          ))
        )}
      </ScrollArea>
    </div>
  );
}

/** How the numbers are drawn: grouping, kind, interval, the comparison and a custom range */
function ChartOptions({ search, period, onChange }: Omit<FilterBarProps, 'options'>) {
  const id = useId();
  const [from, setFrom] = useState(period.from);
  const [to, setTo] = useState(period.to);
  useEffect(() => {
    setFrom(period.from);
    setTo(period.to);
  }, [period.from, period.to]);
  const rangeProblem = !isDay(from) || !isDay(to) ? 'Pick both days.' : to < from ? 'The end comes after the start.' : daysBetween(from, to) > MAX_DAYS ? `At most ${MAX_DAYS} days.` : null;
  const weeksOnly = period.days > DAYS_LIMIT;
  return (
    <div className="stats-filters">
      <div className="stats-filters-group">
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
