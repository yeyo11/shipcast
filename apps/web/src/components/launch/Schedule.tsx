import { useRouter } from '@tanstack/react-router';
import { useEffect, useId, useState } from 'react';
import { cancelSchedule, moveSchedule, recommendedTimes, schedulePiece } from '../../server/posts.functions';
import { countdown, isoToZonedInput, scheduleChips, zonedInputToIso, zonedLabel, type Chip } from '../../server/pieces';
import type { SchedulingChannel } from '../../server/pieces.server';
import { useToast } from '../Toasts';
import { Tooltip } from '../ui/Tooltip';

/*
 * A time for a channel a drafted launch has not published yet, shown in that channel's panel: the recommended times as chips
 * (their reason on hover and in the accessible name), a picker for any other, and for a scheduled
 * one its countdown and Cancel. Times read and write in the owner's zone (docs/scheduling.md).
 */

function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function ChannelSchedule({ launchId, item, timezone }: { launchId: number; item: SchedulingChannel; timezone: string }) {
  const router = useRouter();
  const toast = useToast();
  const now = useNow();
  const [chips, setChips] = useState<Chip[] | null>(null);
  const [value, setValue] = useState(item.scheduled?.scheduledAt ? isoToZonedInput(item.scheduled.scheduledAt, timezone) : '');
  const [busy, setBusy] = useState(false);
  const pickerId = useId();
  const scheduled = item.scheduled;

  useEffect(() => {
    let live = true;
    recommendedTimes({ data: { channel: item.channel } }).then((answer) => {
      if (live) setChips(answer.ok ? scheduleChips(answer.value.slots, new Date()) : []);
    });
    return () => {
      live = false;
    };
  }, [item.channel]);

  const run = async (work: () => Promise<{ ok: true } | { ok: false; problem: string }>, done: string) => {
    setBusy(true);
    try {
      const answer = await work();
      if (answer.ok) toast.done(done);
      else toast.fail(answer.problem);
      await router.invalidate();
    } finally {
      setBusy(false);
    }
  };
  const at = (iso: string) => (scheduled?.scheduledAt ? moveSchedule({ data: { postId: scheduled.id, at: iso } }) : schedulePiece({ data: { launchId, channel: item.channel, at: iso } }));
  const picked = zonedInputToIso(value, timezone);

  return (
    <div className="sched">
      <div className="sched-head">
        <strong>{scheduled ? 'Goes out' : 'Not out yet'}</strong>
        {scheduled?.scheduledAt && (
          <span className="sched-when">
            <strong>{zonedLabel(scheduled.scheduledAt, timezone)}</strong> <span className="muted">{countdown(scheduled.scheduledAt, now)}</span>
          </span>
        )}
        {scheduled && (
          <button type="button" className="btn btn-small" disabled={busy} onClick={() => run(() => cancelSchedule({ data: { postId: scheduled.id } }), `Cancelled: it publishes with the launch`)}>
            Cancel
          </button>
        )}
      </div>
      <div className="sched-body">
        {chips === null ? (
          <span className="muted">Reading the best times…</span>
        ) : chips.length === 0 ? (
          <span className="muted">No recommended time yet: pick one</span>
        ) : (
          <ul className="chips" aria-label={`Recommended times for ${item.channel}`}>
            {chips.map((chip) => (
              <li key={chip.at}>
                <Tooltip content={chip.title}>
                  <button type="button" className="chip" data-best={chip.best || undefined} disabled={busy} aria-label={chip.title} onClick={() => run(() => at(chip.at), `Scheduled for ${chip.label}`)}>
                    {chip.label}
                  </button>
                </Tooltip>
              </li>
            ))}
          </ul>
        )}
        <div className="sched-pick">
          <label htmlFor={pickerId} className="visually-hidden">
            Another time for {item.channel}, in {timezone}
          </label>
          <input id={pickerId} className="input" type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)} />
          <button type="button" className="btn btn-small" disabled={busy || !picked} onClick={() => picked && run(() => at(picked), 'Scheduled')}>
            {scheduled ? 'Move' : 'Schedule'}
          </button>
        </div>
        <small className="muted">Times in {timezone}. Left without a time, it publishes when the pull request is merged.</small>
      </div>
    </div>
  );
}
