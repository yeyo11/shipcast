import { Link } from '@tanstack/react-router';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Icon } from '../kit/Icon';
import { channelEntries, type PieceRow } from '../../server/pieces';
import type { SchedulingChannel } from '../../server/pieces.server';
import type { ChannelNumbers, Day, Totals } from '../../server/launch-summary';
import { number } from '../ui';
import { ChannelGlyph, channelTitle } from './ChannelGlyph';
import { useLaunchActions } from './LaunchActions';
import { channelRows, chartDay, chartPoints, type ChannelRow } from './published';
import { Tick } from './UnpublishSheet';

/*
 * A published launch's Channels tab (board LaunchDetail): its totals over the views per day since it
 * went out, then one row per channel with how it went (out with its leading number, failed with
 * Retry, waiting for its time with Move), ticks to edit several, and Unpublish.
 */

/** The width the chart is drawn at: its box's, so the line fills a phone and a desktop column alike */
function useWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => entry && setWidth(Math.max(120, Math.round(entry.contentRect.width))));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

const TOTALS: Array<[keyof Totals, string]> = [
  ['views', 'Views'],
  ['reactions', 'Reactions'],
  ['comments', 'Comments'],
  ['clicks', 'Clicks'],
  ['stars', 'Stars'],
];

function ViewsChart({ days }: { days: Day[] }) {
  const [ref, width] = useWidth<HTMLDivElement>(358);
  const gradient = useId();
  const { points, peak } = chartPoints(days, width);
  const line = points.map(([x, y]) => `${x},${y}`).join(' ');
  const area = `M0 100 ${points.map(([x, y]) => `L${x} ${y}`).join(' ')} L${width} 100 Z`;
  const label = peak && `${number(peak.views)} on ${chartDay(peak.day)}`;
  // The peak's words sit right of its dot, or left of it when the dot is near the right edge
  const flip = peak !== null && peak.x > width - 110;
  return (
    <div ref={ref} className="pub-chart">
      <svg viewBox={`0 0 ${width} 110`} width="100%" height="110" role="img" aria-label={`Views per day since the launch${label ? `; the most, ${label}` : ''}`}>
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--sc-chart)" stopOpacity=".35" />
            <stop offset="1" stopColor="var(--sc-chart)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {points.length > 1 && <path d={area} fill={`url(#${gradient})`} />}
        {points.length > 1 && <polyline points={line} fill="none" stroke="var(--sc-chart)" strokeWidth="3" strokeLinejoin="round" />}
        <line x1="0" y1="100" x2={width} y2="100" stroke="var(--sc-rail)" />
        {peak && (
          <>
            <circle cx={peak.x} cy={peak.y} r="5" fill="var(--sc-chart)" />
            <text x={flip ? peak.x - 10 : peak.x + 10} y={Math.max(12, peak.y - 2)} textAnchor={flip ? 'end' : 'start'} fill="var(--sc-text)" fontSize="12" fontFamily="var(--sc-font-text)">
              {label}
            </text>
          </>
        )}
      </svg>
    </div>
  );
}

/** The launch's totals and its views per day, with what waits on the owner under them */
export function ViewsCard({ totals, days, waitingComments }: { totals: Totals; days: Day[]; waitingComments: number }) {
  const shown = TOTALS.filter(([key], i) => i < 3 || totals[key] > 0);
  return (
    <div className="k-px pub-views">
      <div className="k-card pub-views-card">
        <dl className="k-hrow k-g24 pub-totals" aria-label="This launch's totals">
          {shown.map(([key, label]) => (
            <div key={key} className="k-stack">
              <dt className="k-xs k-muted">{label}</dt>
              <dd className="k-d k-d30">{number(totals[key])}</dd>
            </div>
          ))}
        </dl>
        {days.length > 0 && <ViewsChart days={days} />}
        <div className="k-xs k-muted">
          {days.length > 0 ? 'Views per day since the launch' : 'No views read yet: the first reading comes within six hours of the launch'}
          {waitingComments > 0 && (
            <>
              {' · '}
              <Link to="/comments">{waitingComments === 1 ? '1 comment to answer' : `${waitingComments} comments to answer`}</Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ row, ticked, onTick }: { row: ChannelRow; ticked: boolean; onTick: (on: boolean) => void }) {
  const { retry, move } = useLaunchActions();
  const [busy, setBusy] = useState(false);
  const title = channelTitle(row.channel);
  const failed = row.kind === 'failed';
  return (
    <div className="k-row">
      <Tick checked={ticked} disabled={row.editable.length === 0} onChange={onTick} label={row.editable.length > 0 ? `Select ${title}` : `${title} cannot be edited`} />
      <span className={`k-ic${failed ? ' pub-ic-fail' : ''}`}>
        <ChannelGlyph channel={row.channel} />
      </span>
      <div className="k-grow k-stack">
        {row.url ? (
          <a className="pub-name" href={row.url} target="_blank" rel="noreferrer">
            {title}
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>
        ) : (
          <strong>{title}</strong>
        )}
        {failed ? (
          <span className="k-xs pub-fail-line" title={row.line}>
            ◆ {row.line}
          </span>
        ) : (
          <span className="k-xs k-muted">{row.line}</span>
        )}
      </div>
      {failed ? (
        <button
          type="button"
          className="k-btn k-sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await retry(row.channel);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Icon name="retry" size={18} />
          {busy ? 'Retrying…' : 'Retry'}
        </button>
      ) : row.kind === 'scheduled' && row.scheduled ? (
        <button type="button" className="k-btn k-sm" onClick={() => row.scheduled && move({ channel: row.channel as SchedulingChannel['channel'], scheduled: { ...row.scheduled, status: 'scheduled', updatedAt: row.scheduled.scheduledAt ?? '' } })}>
          <Icon name="calendar" size={18} />
          Move
        </button>
      ) : row.figure ? (
        <div className="k-stack pub-figure">
          <span className="k-d k-d24">{number(row.figure.value)}</span>
          <span className="k-xs k-muted">{row.figure.caption}</span>
        </div>
      ) : null}
    </div>
  );
}

export function ChannelList({
  rows,
  failures,
  scheduling,
  replies,
  numbers,
  timezone,
}: {
  rows: PieceRow[];
  failures: ReadonlyArray<{ channel: string; message: string }>;
  scheduling: ReadonlyArray<{ channel: string; scheduled: { id: number; status: string; updatedAt: string; scheduledAt: string | null } | null }>;
  replies: Record<string, number>;
  numbers: Record<string, ChannelNumbers>;
  timezone: string;
}) {
  const { edit, unpublish } = useLaunchActions();
  const entries = useMemo(() => channelEntries({ rows, failures, scheduling, replies }), [rows, failures, scheduling, replies]);
  const list = useMemo(() => channelRows(entries, numbers, timezone), [entries, numbers, timezone]);
  const [ticked, setTicked] = useState<string[]>([]);
  const chosen = list.filter((r) => ticked.includes(r.channel)).flatMap((r) => r.editable);
  const removable = rows.some((r) => r.remove.allowed);

  if (list.length === 0) return <p className="k-px k-sm k-muted pub-none">Nothing went out on a channel yet, and none waits for a time. The drafts are in Content.</p>;
  return (
    <>
      <div className="k-px k-stack pub-rows">
        {list.map((row) => (
          <Row key={row.channel} row={row} ticked={ticked.includes(row.channel)} onTick={(on) => setTicked(on ? [...ticked, row.channel] : ticked.filter((c) => c !== row.channel))} />
        ))}
      </div>
      <div className="k-px k-hrow k-g8 pub-row-actions">
        <button type="button" className="k-btn k-sm" onClick={() => edit(chosen)}>
          <Icon name="write" size={18} />
          {chosen.length > 1 ? `Edit ${chosen.length} together` : 'Edit selected'}
        </button>
        {removable && (
          <button type="button" className="k-btn k-sm" onClick={() => unpublish(ticked)}>
            <Icon name="trash" size={18} />
            Unpublish
          </button>
        )}
      </div>
    </>
  );
}
