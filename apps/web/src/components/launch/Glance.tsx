import { dayOffset, MARK_WORD, shortNumber, TOTAL_LABELS, type Day, type Mark, type Totals } from '../../server/launch-summary';
import { CHANNEL_NAMES, channelIcon } from '../../server/view';
import { number } from '../ui';

/*
 * A launch at a glance, shared by its page and its card on the list: a channel's mark with its state
 * dot, the totals, and the views per day. Inline SVG and CSS only, no chart library: /stats has the
 * charts; here the question is only "how did it do, and is it still moving?".
 */

/** A network's glyph; a network the design system has none for gets its initial, so no mark is blank */
export function ChannelIcon({ channel, size = 20 }: { channel: string; size?: number }) {
  const icon = channelIcon(channel);
  if (icon) return <img className="icon glyph" src={icon} alt="" width={size} height={size} />;
  return (
    <span className="glyph glyph-letter" aria-hidden="true" style={{ width: size, height: size, fontSize: Math.round(size * 0.62) }}>
      {(CHANNEL_NAMES[channel] ?? channel).charAt(0)}
    </span>
  );
}

/** A state as a dot whose shape says it; the word is shown, or kept for assistive technology */
export function StateDot({ mark, word, label }: { mark: Mark; word?: boolean; label?: string }) {
  return (
    <span className={`dot d-${mark}`}>
      <i aria-hidden="true" />
      {word ? (label ?? MARK_WORD[mark]) : <span className="visually-hidden">{label ?? MARK_WORD[mark]}</span>}
    </span>
  );
}

export function TotalsRow({ totals }: { totals: Totals }) {
  return (
    <dl className="totals" aria-label="This launch's totals">
      {TOTAL_LABELS.map(([key, label]) => (
        <div key={key}>
          <dt>{label}</dt>
          <dd title={number(totals[key])}>{shortNumber(totals[key])}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Views per day since the launch, as bars. A figure with a text alternative listing every day, since
 * a bar's height alone says nothing to a screen reader.
 */
export function DailyBars({ days, launchedAt }: { days: Day[]; launchedAt: string }) {
  if (days.length === 0) {
    return (
      <figure className="daily daily-empty">
        <figcaption className="muted">No views read yet: the first reading comes within six hours of the launch.</figcaption>
      </figure>
    );
  }
  const max = Math.max(1, ...days.map((d) => d.views));
  const every = Math.ceil(days.length / 8);
  const label = (d: Day) => {
    const n = dayOffset(d.day, launchedAt);
    return n === 0 ? 'Launch' : `+${n}d`;
  };
  return (
    <figure className="daily">
      <figcaption className="daily-title">Views per day since the launch</figcaption>
      <div className="daily-bars" aria-hidden="true">
        {days.map((d, i) => (
          <div key={d.day} title={`${d.day}: ${number(d.views)} views`}>
            <span style={{ height: `${Math.max(2, (d.views / max) * 100)}%` }} data-zero={d.views === 0 || undefined} />
            <small>{i % every === 0 || i === days.length - 1 ? label(d) : ''}</small>
          </div>
        ))}
      </div>
      <p className="visually-hidden">{days.map((d) => `${label(d)}: ${number(d.views)} views`).join('; ')}</p>
    </figure>
  );
}
