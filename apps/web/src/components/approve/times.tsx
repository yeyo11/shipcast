import { useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { cancelSchedule, moveSchedule, recommendedTimes, schedulePiece } from '../../server/posts.functions';
import { scheduleChips, zonedInputToIso, type Chip } from '../../server/pieces';
import type { SchedulingChannel } from '../../server/pieces.server';
import { Icon } from '../kit/Icon';
import { Sheet } from '../kit/Sheet';
import { useToast } from '../Toasts';
import { dayLabel, monthGrid, MONTH_NAMES, zonedParts } from './model';

/*
 * When a channel of a launch to approve goes out (boards LaunchReview and LaunchSchedule): the
 * recommended times as chips, the picked one in yellow, and "Another day" for any other day and
 * time. Times read and write in the owner's zone (docs/scheduling.md); a channel left without a time
 * goes out as soon as the drafts are approved.
 */

/** How many recommended times a channel's card offers before "Another day" */
const SHOWN = 3;

export interface ChannelChips {
  chips: Chip[] | null;
  reason: string | null;
}

const READING: ChannelChips = { chips: null, reason: null };

/** The recommended times of each channel, best first, read once for the page; null while they are read */
export function useChipsFor(channels: readonly string[]): (channel: string) => ChannelChips {
  const [answers, setAnswers] = useState<Record<string, ChannelChips>>({});
  const wanted = channels.join(',');
  useEffect(() => {
    let live = true;
    for (const channel of wanted ? wanted.split(',') : []) {
      recommendedTimes({ data: { channel } })
        .then((r) => {
          if (live) setAnswers((a) => ({ ...a, [channel]: r.ok ? { chips: scheduleChips(r.value.slots, new Date()), reason: r.value.slots[0]?.reason ?? null } : { chips: [], reason: null } }));
        })
        .catch(() => live && setAnswers((a) => ({ ...a, [channel]: { chips: [], reason: null } })));
    }
    return () => {
      live = false;
    };
  }, [wanted]);
  return (channel) => answers[channel] ?? READING;
}

/** Puts a channel's piece on a time, moves it, or takes the time away so it goes out with the approval */
export function useSchedule(launchId: number, item: SchedulingChannel) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<{ ok: true } | { ok: false; problem: string }>, done: string) => {
    setBusy(true);
    try {
      const answer = await work();
      if (answer.ok) toast.done(done);
      else toast.fail(answer.problem);
      await router.invalidate();
      return answer.ok;
    } catch (error) {
      toast.fail(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const scheduled = item.scheduled;
  return {
    busy,
    at: (iso: string, label: string) =>
      run(() => (scheduled ? moveSchedule({ data: { postId: scheduled.id, at: iso } }) : schedulePiece({ data: { launchId, channel: item.channel, at: iso } })), `Goes out ${label}`),
    clear: () => (scheduled ? run(() => cancelSchedule({ data: { postId: scheduled.id } }), 'No time: it goes out as soon as you approve') : Promise.resolve(true)),
  };
}

/** A recommended time as the board's chip: yellow with a check when it is the one picked */
export function TimeChip({ chip, picked, disabled, onClick }: { chip: Chip; picked: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`k-chip${picked ? ' k-pick' : ''}`} aria-pressed={picked} title={chip.title} aria-label={`${chip.label}${chip.best ? ', best' : ''}: ${chip.title}`} disabled={disabled} onClick={onClick}>
      {picked && <Icon name="check" size={16} strokeWidth={3} />}
      {chip.label}
      {chip.best ? ' · best' : ''}
    </button>
  );
}

export interface TimesProps {
  launchId: number;
  item: SchedulingChannel;
  name: string;
  timezone: string;
  chips: Chip[] | null;
  reason: string | null;
  onAnotherDay: () => void;
  /** The desktop card shows the chips alone, without the inner card */
  bare?: boolean;
}

/** The "When it goes out" card of the channel being looked at */
export function Times({ launchId, item, name, timezone, chips, reason, onAnotherDay, bare }: TimesProps) {
  const { busy, at, clear } = useSchedule(launchId, item);
  const scheduledAt = item.scheduled?.scheduledAt ?? null;
  const shown = (chips ?? []).slice(0, bare ? 2 : SHOWN);
  const list = (
    <div className="k-chips" role="group" aria-label={`When ${name} goes out`}>
      {chips === null && <span className="k-sm k-muted ap-chips-wait">Reading the best times…</span>}
      {shown.map((chip) => {
        const picked = scheduledAt !== null && Date.parse(chip.at) === Date.parse(scheduledAt);
        return <TimeChip key={chip.at} chip={chip} picked={picked} disabled={busy} onClick={() => void (picked ? clear() : at(chip.at, chip.label))} />;
      })}
      <button type="button" className="k-chip" onClick={onAnotherDay} disabled={busy}>
        <Icon name="calendar" size={16} />
        Another day
      </button>
    </div>
  );
  if (bare) return list;
  return (
    <div className="k-card ap-times">
      <div className="k-hrow k-between">
        <span className="k-lbl">When it goes out</span>
        <span className="k-xs k-muted">{timezone}</span>
      </div>
      {list}
      {reason && <div className="k-xs k-muted">{reason.replace(/^./, (c) => c.toUpperCase()).replace(/\.?$/, '.')}</div>}
    </div>
  );
}

const todayIn = (timeZone: string) => zonedParts(new Date().toISOString(), timeZone).day;

/** "Another day" (board LaunchSchedule): the recommended times, a month to pick the day from and the time */
export function ScheduleSheet({
  open,
  onOpenChange,
  launchId,
  item,
  name,
  timezone,
  chips,
  title = 'Another day',
}: {
  title?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  launchId: number;
  item: SchedulingChannel;
  name: string;
  timezone: string;
  chips: Chip[] | null;
}) {
  const { busy, at } = useSchedule(launchId, item);
  const start = () => {
    const from = item.scheduled?.scheduledAt ?? chips?.[0]?.at;
    if (from) return zonedParts(from, timezone);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    return { day: zonedParts(tomorrow, timezone).day, time: '09:00' };
  };
  const [value, setValue] = useState(start);
  const [month, setMonth] = useState(() => value.day.slice(0, 7));
  // Each opening starts again from the channel's time
  useEffect(() => {
    if (!open) return;
    const v = start();
    setValue(v);
    setMonth(v.day.slice(0, 7));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const today = todayIn(timezone);
  const [y, m] = month.split('-').map(Number) as [number, number];
  const { blanks, days } = monthGrid(y, m - 1);
  const shiftMonth = (by: number) => {
    const d = new Date(Date.UTC(y, m - 1 + by, 1));
    setMonth(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  };
  const iso = zonedInputToIso(`${value.day}T${value.time}`, timezone);
  const past = iso ? Date.parse(iso) <= Date.now() : true;
  const label = dayLabel(value.day, value.time);
  const pickedChip = (chip: Chip) => {
    const p = zonedParts(chip.at, timezone);
    return p.day === value.day && p.time === value.time;
  };

  return (
    <Sheet label={`${title} for ${name}`} open={open} onOpenChange={onOpenChange} className="ap-sheet">
      <h2 className="k-d k-d30">{title}</h2>
      <p className="k-sm k-muted ap-m0">
        For {name}, in {timezone}. The launch keeps its other times.
      </p>
      {chips && chips.length > 0 && (
        <div className="k-stack k-g8">
          <span className="k-lbl">Recommended</span>
          <div className="k-hrow k-g8 k-wrap">
            {chips.slice(0, SHOWN).map((chip) => (
              <TimeChip
                key={chip.at}
                chip={chip}
                picked={pickedChip(chip)}
                onClick={() => {
                  const p = zonedParts(chip.at, timezone);
                  setValue(p);
                  setMonth(p.day.slice(0, 7));
                }}
              />
            ))}
          </div>
        </div>
      )}
      <div className="k-card ap-cal">
        <div className="k-hrow k-between">
          <button type="button" className="k-btn k-sm k-icon k-ghost" aria-label="Previous month" onClick={() => shiftMonth(-1)} disabled={month <= today.slice(0, 7)}>
            <Icon name="chevronLeft" size={18} />
          </button>
          <strong aria-live="polite">
            {MONTH_NAMES[m - 1]} {y}
          </strong>
          <button type="button" className="k-btn k-sm k-icon k-ghost" aria-label="Next month" onClick={() => shiftMonth(1)}>
            <Icon name="chevronRight" size={18} />
          </button>
        </div>
        <div className="ap-cal-grid k-sm" role="grid" aria-label={`${MONTH_NAMES[m - 1]} ${y}`}>
          {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
            <span key={i} className="k-xs k-muted ap-cal-head" aria-hidden="true">
              {d}
            </span>
          ))}
          {Array.from({ length: blanks }, (_, i) => (
            <span key={`b${i}`} />
          ))}
          {Array.from({ length: days }, (_, i) => {
            const day = `${month}-${String(i + 1).padStart(2, '0')}`;
            const on = day === value.day;
            const gone = day < today;
            return (
              <button
                key={day}
                type="button"
                className={`ap-cal-day${on ? ' ap-on' : ''}`}
                aria-pressed={on}
                aria-label={dayLabel(day, value.time).split(',')[0]}
                disabled={gone}
                onClick={() => setValue((v) => ({ ...v, day }))}
              >
                {i + 1}
              </button>
            );
          })}
        </div>
      </div>
      <div className="k-hrow k-g10">
        <label className="k-field k-grow">
          <span className="k-lbl">Time</span>
          <span className="k-input ap-time">
            <input type="time" className="k-grow" value={value.time} step={300} onChange={(e) => e.target.value && setValue((v) => ({ ...v, time: e.target.value }))} aria-label={`Time, in ${timezone}`} />
            <span className="k-muted" aria-hidden="true">
              <Icon name="clock" size={18} />
            </span>
          </span>
        </label>
      </div>
      {past && <p className="k-sm ap-m0 ap-bad-text">That moment has passed: pick a later one.</p>}
      <div className="k-hrow k-g10">
        <button type="button" className="k-btn" onClick={() => onOpenChange(false)}>
          Cancel
        </button>
        <button
          type="button"
          className="k-btn k-pri ap-grow-btn"
          disabled={busy || past || !iso}
          onClick={async () => {
            if (iso && (await at(iso, label))) onOpenChange(false);
          }}
        >
          Move to {label}
        </button>
      </div>
    </Sheet>
  );
}

/** A scheduled piece's Move, from the launch's actions: the same sheet, with the channel's own recommendations */
export function MoveSheet({ launchId, item, name, timezone, onClose }: { launchId: number; item: SchedulingChannel; name: string; timezone: string; onClose: () => void }) {
  const chipsOf = useChipsFor([item.channel]);
  return <ScheduleSheet open onOpenChange={(o) => !o && onClose()} launchId={launchId} item={item} name={name} timezone={timezone} chips={chipsOf(item.channel).chips} title={`Move ${name}`} />;
}
