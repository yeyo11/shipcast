import { Link } from '@tanstack/react-router';
import { useLayoutEffect, useRef, useState } from 'react';
import { cardChannels, foldMarks, launchDateLabel, MARK_WORD, shortNumber, type CardChannel, type CardPost, type LaunchNumbers } from '../server/launch-summary';
import { zonedLabel } from '../server/pieces';
import { CHANNEL_NAMES, type LaunchView } from '../server/view';
import { ChannelIcon, StateDot } from './launch/Glance';
import { number, Pill } from './ui';
import { Popover } from './ui/Popover';

/*
 * A launch as a summary card (docs/web-app.md): how it did (its totals and the views per day) and
 * where it went (one mark per channel with its state dot). A mark opens what went out there: the
 * post itself when there is one with an address, a small menu of its posts otherwise. Never an
 * "open all": the owner opens the one they want.
 */

/** A mark's width and the gap after it, as in app.css (.mark: 36px, .marks: gap 8px) */
const MARK_GAP = 8;
const MARK_STEP = 36 + MARK_GAP;
/** The marks whose menus open leftwards, so a menu near the card's right edge stays on screen */
const RIGHT_EDGE = 3;

const networkOf = (channel: string) => CHANNEL_NAMES[channel] ?? channel;
const host = (url: string) => url.replace(/^https?:\/\//, '').split('/')[0] ?? url;

const markName = (c: CardChannel) =>
  `${networkOf(c.channel)}: ${MARK_WORD[c.mark].toLowerCase()}${c.accounts.length > 1 ? `, on ${c.accounts.length} accounts (${c.accounts.join(', ')})` : ''}`;

/** The one post a mark opens directly: a channel with a single post that has an address and is still up */
const single = (c: CardChannel): (CardPost & { url: string }) | undefined => {
  const only = c.posts.length === 1 ? c.posts[0] : undefined;
  return only?.url && only.status !== 'deleted' ? { ...only, url: only.url } : undefined;
};

/** What the tile shows: the glyph, the state dot on its top corner, the accounts count on its bottom one */
function MarkFace({ c }: { c: CardChannel }) {
  return (
    <>
      <ChannelIcon channel={c.channel} size={18} />
      <span className={`dot d-${c.mark}`} aria-hidden="true">
        <i />
      </span>
      {c.accounts.length > 1 && (
        <span className="mark-accounts" aria-hidden="true">
          {c.accounts.length}
        </span>
      )}
    </>
  );
}

/** A post without an address says where it stands instead */
function postState(p: CardPost, timezone: string): string {
  if (p.status === 'scheduled' && p.scheduledAt) return `Goes out ${zonedLabel(p.scheduledAt, timezone)}`;
  if (p.status === 'failed') return 'Failed';
  if (p.status === 'deleted') return 'Deleted';
  return 'No link';
}

function PostLine({ p, timezone }: { p: CardPost; timezone: string }) {
  if (p.url && p.status !== 'deleted') {
    return (
      <a className="pop-line" href={p.url} target="_blank" rel="noopener noreferrer">
        <span>{p.label}</span>
        <span className="pop-host">{host(p.url)}</span>
        <span className="visually-hidden"> (opens in a new tab)</span>
      </a>
    );
  }
  return (
    <span className="pop-line is-quiet">
      <span>{p.label}</span>
      <span>{postState(p, timezone)}</span>
    </span>
  );
}

/**
 * One channel's mark. One post with an address: the mark is that link, in a new tab. Several posts
 * (two languages, a post and its story, two accounts) or none with an address (scheduled, failed): a
 * button opening a menu with a line per post and the way to the channel on the launch page.
 */
function Mark({ c, launchId, timezone, leftwards }: { c: CardChannel; launchId: number; timezone: string; leftwards: boolean }) {
  const name = markName(c);
  const only = single(c);
  if (only) {
    return (
      <li className={`mark m-${c.mark} is-link`}>
        <a href={only.url} target="_blank" rel="noopener noreferrer" title={`${name}. Open the post`} aria-label={`${name}. Open the post (new tab)`}>
          <MarkFace c={c} />
        </a>
      </li>
    );
  }
  const count = c.posts.length;
  return (
    <li className={`mark m-${c.mark} is-link`}>
      <Popover
        label={networkOf(c.channel)}
        align={leftwards ? 'end' : 'start'}
        className="pop"
        trigger={
          <button type="button" title={name} aria-label={`${name}. ${count === 0 ? 'Nothing went out' : count === 1 ? '1 post' : `${count} posts`}`}>
            <MarkFace c={c} />
          </button>
        }
      >
        <p className="pop-head">
          <span className="pop-net">
            <ChannelIcon channel={c.channel} size={16} /> {networkOf(c.channel)}
          </span>
          <StateDot mark={c.mark} word />
        </p>
        {c.posts.map((p) => (
          <PostLine key={p.id} p={p} timezone={timezone} />
        ))}
        {count === 0 && <span className="pop-line is-quiet">It failed before anything went out</span>}
        <Link className="pop-foot" to="/launches/$id" params={{ id: String(launchId) }} search={{ tab: 'channels', channel: c.channel }}>
          See it on the launch page
        </Link>
      </Popover>
    </li>
  );
}

/** The "+n" menu: each folded channel is its mark, followed by one chip per post when it has several */
function MoreMarks({ folded }: { folded: CardChannel[] }) {
  return (
    <li className="marks-more">
      <Popover
        label={`${folded.length} more channels`}
        align="end"
        className="pop"
        trigger={
          <button type="button" aria-label={`${folded.length} more channels: ${folded.map(markName).join('; ')}`}>
            +{folded.length}
          </button>
        }
      >
        <ul className="pop-channels">
          {folded.map((c) => {
            const only = single(c);
            return (
              <li key={c.channel}>
                <span className={`mark m-${c.mark}`}>
                  {only ? (
                    <a href={only.url} target="_blank" rel="noopener noreferrer" title={markName(c)} aria-label={`${markName(c)}. Open the post (new tab)`}>
                      <MarkFace c={c} />
                    </a>
                  ) : (
                    <span role="img" aria-label={markName(c)} title={markName(c)}>
                      <MarkFace c={c} />
                    </span>
                  )}
                </span>
                {c.posts.length > 1 && (
                  <span className="pop-chips">
                    {c.posts.map((p) =>
                      p.url && p.status !== 'deleted' ? (
                        <a key={p.id} href={p.url} target="_blank" rel="noopener noreferrer">
                          {p.label}
                          <span className="visually-hidden"> on {networkOf(c.channel)} (opens in a new tab)</span>
                        </a>
                      ) : (
                        <span key={p.id} className="is-quiet">
                          {p.label}
                        </span>
                      ),
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </Popover>
    </li>
  );
}

/**
 * The channel marks on one row, problems first. As many as the row's own width holds; when they do
 * not all fit, the rest (the channels that went fine, first) fold behind "+n".
 */
function Marks({ channels, launchId, timezone }: { channels: CardChannel[]; launchId: number; timezone: string }) {
  const ref = useRef<HTMLUListElement>(null);
  const [fit, setFit] = useState(channels.length);
  // Measured again whenever the card resizes: its width depends on the grid and the screen
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setFit(Math.max(1, Math.floor((el.clientWidth + MARK_GAP) / MARK_STEP)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const { shown, folded } = foldMarks(channels, fit);
  // A full row spreads edge to edge, so no gap is left at its end; a short one stays under the text
  const used = shown.length + (folded.length > 0 ? 1 : 0);
  const full = used > 2 && used >= fit - 1;
  return (
    <ul className="marks" aria-label="Channels" ref={ref} data-full={full || undefined}>
      {shown.map((c, i) => (
        <Mark key={c.channel} c={c} launchId={launchId} timezone={timezone} leftwards={used - i <= RIGHT_EDGE} />
      ))}
      {folded.length > 0 && <MoreMarks folded={folded} />}
    </ul>
  );
}

/** Views per day since the launch, the card's whole width: an area with its line, the days under it */
function DailyArea({ values }: { values: number[] }) {
  if (values.length < 2) return <p className="lcard-none">{values.length === 0 ? 'No views read yet.' : `${number(values[0] ?? 0)} views on the launch day so far.`}</p>;
  const w = 320;
  const h = 96;
  const max = Math.max(1, ...values);
  const step = w / (values.length - 1);
  const line = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 4 - (v / max) * (h - 12)).toFixed(1)}`).join(' ');
  return (
    <figure className="darea">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
        <polygon points={`0,${h} ${line} ${w},${h}`} className="darea-fill" />
        <polyline points={line} fill="none" className="darea-line" strokeWidth="2.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
      <figcaption>
        <span className="visually-hidden">Views per day since the launch: {values.map(number).join(', ')}. </span>
        <span aria-hidden="true">Launch day</span>
        <span aria-hidden="true">+{values.length - 1} days</span>
      </figcaption>
    </figure>
  );
}

function Stat({ label, value, lead }: { label: string; value: number; lead?: boolean }) {
  return (
    <div className={lead ? 'is-lead' : undefined}>
      <dt>{label}</dt>
      <dd title={number(value)}>{shortNumber(value)}</dd>
    </div>
  );
}

export function LaunchCard({
  launch,
  numbers,
  postAccounts,
  timezone,
}: {
  launch: LaunchView;
  numbers: LaunchNumbers | null;
  postAccounts: Record<number, string>;
  timezone: string;
}) {
  const channels = cardChannels({ posts: launch.posts, failures: launch.failures, postAccounts });
  const waiting = launch.state.tone === 'waiting';
  const article = launch.ref.startsWith('article:');
  return (
    <article className={`lcard${waiting ? ' waiting' : ''}`}>
      <header>
        <h2>
          <Link to="/launches/$id" params={{ id: String(launch.id) }}>
            {article ? 'Article' : launch.repo.split('/')[1]} {!article && <span className="lcard-ref">{launch.ref}</span>}
          </Link>
        </h2>
        <Pill tone={launch.state.tone}>{launch.state.label}</Pill>
      </header>
      <p className="lcard-meta">
        {launch.repo} · {launchDateLabel(launch.createdAt, timezone)}
      </p>
      {numbers && channels.length > 0 && (
        <>
          <dl className="lcard-stats">
            <Stat label="Views" value={numbers.totals.views} lead />
            <Stat label="Reactions" value={numbers.totals.reactions} />
            <Stat label="Comments" value={numbers.totals.comments} />
            <Stat label="Clicks" value={numbers.totals.clicks} />
          </dl>
          <DailyArea values={numbers.daily.map((d) => d.views)} />
        </>
      )}
      {channels.length > 0 ? (
        <Marks channels={channels} launchId={launch.id} timezone={timezone} />
      ) : (
        <p className="lcard-none">
          {launch.problem ? launch.problem.split('\n')[0] : launch.pullRequest ? 'Drafts are waiting in the pull request.' : 'Nothing published yet.'}
        </p>
      )}
    </article>
  );
}
