import { useEffect, useId, useRef, useState } from 'react';
import { shortDay } from '../charts/data';
import { Icon } from '../kit/Icon';
import { Sheet } from '../kit/Sheet';
import { dateToDay } from '../ui/dates';
import { MAX_DAYS, daysBetween, isDay, type Period, type StatsSearch } from '../../server/stats-search';
import { PERIOD_CHIPS } from './parts';
import type { FilterOption } from './filter-options';

/*
 * The Stats filters (board StatsFilters): one sheet with the period (a custom range among them), the
 * channels to count and the launch. Nothing changes while it is open: "Show the numbers" puts the
 * whole choice in the address at once, which is what loads the numbers, so a view stays a link.
 * Accounts can still be narrowed through the address; the sheet does not offer them (the board
 * keeps to channels and launches).
 */

export interface FiltersProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  search: StatsSearch;
  /** The period's real days, from the server: what a custom range starts from */
  period: { from: string; to: string };
  options: { channels: FilterOption[]; launches: FilterOption[] };
  onChange: (patch: Partial<StatsSearch>) => void;
}

export function Filters({ open, onOpenChange, search, period, options, onChange }: FiltersProps) {
  const id = useId();
  const all = options.channels.map((c) => c.value);
  const [draft, setDraft] = useState(() => fromSearch(search, period, all));
  // Every opening starts from the view on the page, not from what was left unapplied last time
  useEffect(() => {
    if (open) setDraft(fromSearch(search, period, all));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const problem =
    draft.period !== 'custom'
      ? null
      : !isDay(draft.from) || !isDay(draft.to)
        ? 'Pick both days.'
        : draft.to < draft.from
          ? 'The end comes after the start.'
          : daysBetween(draft.from, draft.to) > MAX_DAYS
            ? `At most ${MAX_DAYS} days.`
            : null;
  const allTicked = all.every((c) => draft.channels.includes(c));
  const toggle = (c: string) => setDraft((d) => ({ ...d, channels: d.channels.includes(c) ? d.channels.filter((x) => x !== c) : [...d.channels, c] }));
  const apply = () => {
    if (problem) return;
    const channels = draft.channels.length === 0 || all.every((c) => draft.channels.includes(c)) ? undefined : all.filter((c) => draft.channels.includes(c));
    onChange({
      period: draft.period,
      from: draft.period === 'custom' ? draft.from : undefined,
      to: draft.period === 'custom' ? draft.to : undefined,
      channels,
      launches: draft.launches,
    });
    onOpenChange(false);
  };
  const today = dateToDay(new Date());

  return (
    <Sheet label="Filters" open={open} onOpenChange={onOpenChange} className="stats-filters">
      <form
        className="k-stack stats-filters-form"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <h2 className="k-d k-d30">Filters</h2>
        <fieldset className="k-stack k-g8 stats-fieldset">
          <legend className="k-lbl">Period</legend>
          <div className="k-chips">
            {[...PERIOD_CHIPS, { value: 'custom' as const, label: 'Custom' }].map((p) => {
              const on = draft.period === p.value;
              return (
                <button key={p.value} type="button" className={`k-chip${on ? ' k-pick' : ''}`} aria-pressed={on} onClick={() => setDraft((d) => ({ ...d, period: p.value }))}>
                  {on && <Icon name="check" size={16} strokeWidth={3} />}
                  {p.label}
                </button>
              );
            })}
          </div>
        </fieldset>
        {draft.period === 'custom' && (
          <div className="k-hrow k-g10 stats-range">
            <DayField label="From" value={draft.from} max={today} onChange={(from) => setDraft((d) => ({ ...d, from }))} />
            <DayField label="To" value={draft.to} max={today} onChange={(to) => setDraft((d) => ({ ...d, to }))} />
          </div>
        )}
        {problem && (
          <p className="k-xs stats-filters-problem" role="status">
            {problem}
          </p>
        )}
        {options.channels.length > 0 && (
          <fieldset className="k-stack k-g8 stats-fieldset">
            <legend className="k-lbl">Channel</legend>
            <div className="k-chips">
              {options.channels.map((c) => {
                const on = draft.channels.includes(c.value);
                return (
                  <button key={c.value} type="button" className={`k-chip${on ? ' k-on' : ''}`} aria-pressed={on} onClick={() => toggle(c.value)}>
                    {on && <Icon name="check" size={16} strokeWidth={3} />}
                    {c.label}
                  </button>
                );
              })}
            </div>
          </fieldset>
        )}
        <label className="k-field" htmlFor={`${id}-launch`}>
          <span className="k-lbl">Launch</span>
          <span className="k-input stats-select">
            <select
              id={`${id}-launch`}
              value={draft.launches && draft.launches.length === 1 ? String(draft.launches[0]) : draft.launches ? 'several' : ''}
              onChange={(e) => setDraft((d) => ({ ...d, launches: e.target.value === '' ? undefined : e.target.value === 'several' ? d.launches : [Number(e.target.value)] }))}
            >
              <option value="">Every launch</option>
              {draft.launches && draft.launches.length > 1 && <option value="several">{draft.launches.length} launches</option>}
              {options.launches.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
            <span className="k-muted stats-select-mark">
              <Icon name="chevronDown" size={18} />
            </span>
          </span>
        </label>
        <div className="k-hrow k-g10">
          <button type="button" className="k-btn" onClick={() => setDraft((d) => ({ ...d, channels: allTicked ? [] : all }))}>
            {allTicked ? 'Untick all' : 'Tick all'}
          </button>
          <button type="submit" className="k-btn k-pri stats-filters-apply" disabled={problem !== null}>
            Show the numbers
          </button>
        </div>
      </form>
    </Sheet>
  );
}

interface Draft {
  period: Period;
  from: string;
  to: string;
  channels: string[];
  launches: number[] | undefined;
}

function fromSearch(search: StatsSearch, period: { from: string; to: string }, all: string[]): Draft {
  return { period: search.period, from: period.from, to: period.to, channels: search.channels ?? all, launches: search.launches };
}

/** A day as the board writes it ("1 Oct 2026"), with the browser's own date picker under it */
function DayField({ label, value, max, onChange }: { label: string; value: string; max: string; onChange: (day: string) => void }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  return (
    <label className="k-field k-grow" htmlFor={id}>
      <span className="k-lbl">{label}</span>
      <span className="k-input stats-day">
        <span className="k-grow k-ellipsis" aria-hidden="true">
          {isDay(value) ? shortDay(value, true) : 'Pick a day'}
        </span>
        <span className="k-muted">
          <Icon name="calendar" size={18} />
        </span>
        <input
          ref={input}
          id={id}
          type="date"
          value={value}
          max={max}
          onChange={(e) => onChange(e.target.value)}
          onClick={() => {
            try {
              input.current?.showPicker();
            } catch {
              // A browser without showPicker opens its picker on the click itself
            }
          }}
        />
      </span>
    </label>
  );
}
