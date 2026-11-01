import { useEffect, useId, useState } from 'react';
import { Icon } from '../kit/Icon';
import { Overlay } from '../kit/Overlay';
import { PickerSelect } from '../kit/Picker';
import { DatePicker } from '../ui/DatePicker';
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

/** The launch picker's two choices beside the launches: none chosen, and several chosen through the address */
const EVERY = '*';
const SEVERAL = 'several';

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
    <Overlay
      kind="drawer"
      label="Filters"
      heading="Filters"
      open={open}
      onOpenChange={onOpenChange}
      className="stats-filters"
      footer={
        <div className="k-hrow k-g10">
          <button type="button" className="k-btn" onClick={() => setDraft((d) => ({ ...d, channels: allTicked ? [] : all }))}>
            {allTicked ? 'Untick all' : 'Tick all'}
          </button>
          <button type="submit" form={`${id}-form`} className="k-btn k-pri stats-filters-apply" disabled={problem !== null}>
            Show the numbers
          </button>
        </div>
      }
    >
      <form
        id={`${id}-form`}
        className="k-stack stats-filters-form"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
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
        <PickerSelect
          label="Launch"
          value={draft.launches && draft.launches.length === 1 ? String(draft.launches[0]) : draft.launches ? SEVERAL : EVERY}
          options={[
            { value: EVERY, label: 'Every launch' },
            ...(draft.launches && draft.launches.length > 1 ? [{ value: SEVERAL, label: `${draft.launches.length} launches` }] : []),
            ...options.launches.map((l) => ({ value: l.value, label: l.label })),
          ]}
          onValueChange={(v) => setDraft((d) => ({ ...d, launches: v === EVERY ? undefined : v === SEVERAL ? d.launches : [Number(v)] }))}
        />
      </form>
    </Overlay>
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

/** A day as the board writes it ("1 Oct 2026"), its calendar the app's own (ui/DatePicker) */
function DayField({ label, value, max, onChange }: { label: string; value: string; max: string; onChange: (day: string) => void }) {
  const id = useId();
  return (
    <div className="k-field k-grow">
      <label className="k-lbl" htmlFor={id}>
        {label}
      </label>
      <DatePicker id={id} label={label} value={isDay(value) ? value : ''} max={max} onChange={onChange} short />
    </div>
  );
}
