import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { agoLabel, launchTitle, shortDate, shortDateTime, TRIGGER_BY } from '../server/launch-list';
import { cardChannels, MARK_WORD, type CardChannel, type CardPost, type LaunchNumbers, type Mark, type Totals } from '../server/launch-summary';
import { CHANNEL_NAMES, type LaunchView, type Tone } from '../server/view';
import { Icon } from './kit/Icon';
import { Sheet, SheetClose } from './kit/Sheet';
import { NetworkGlyph } from './NetworkGlyph';
import { number } from './ui';

/*
 * A launch as a card on the Launches page (boards Main and DesktopHome): its name and state, where it
 * came from, then what it is doing. Drafting, a bar and what the drafting is doing now; failed before
 * anything went out, why; out, its numbers and one mark per channel with its state dot. A mark opens
 * that channel's peek (board ChannelPeek): its own numbers and a line per post, so the owner opens the
 * one they want, never all.
 */

export type HomeLaunch = LaunchView & {
  numbers: LaunchNumbers | null;
  postAccounts: Record<number, string>;
  updatedAt: string;
  held: boolean;
  ready: { count: number; text: string } | null;
  drafting: string | null;
};

const networkOf = (channel: string) => CHANNEL_NAMES[channel] ?? channel;

/** A state as the board's pill: a word and a shape */
const PILL: Record<Tone, string> = { published: 'k-p-pub', waiting: 'k-p-wait', failed: 'k-p-fail', draft: 'k-p-run', quiet: 'k-p-quiet' };

/** A channel's state as the board's dot */
const DOT: Record<Mark, string> = { published: 'k-dot-pub', scheduled: 'k-dot-sched', failed: 'k-dot-fail', off: 'k-dot-quiet' };

export function StatePill({ tone, label }: { tone: Tone; label: string }) {
  return <span className={`k-pill ${PILL[tone]}`}>{label}</span>;
}

const STATS: ReadonlyArray<[keyof Totals, string]> = [
  ['views', 'Views'],
  ['reactions', 'Reactions'],
  ['comments', 'Comments'],
  ['clicks', 'Clicks'],
];

/** The numbers in a row: those the launch (or the channel) counts; clicks only once there are some */
function Numbers({ totals }: { totals: Partial<Totals> }) {
  const shown = STATS.filter(([key]) => totals[key] !== undefined && (key !== 'clicks' || (totals.clicks ?? 0) > 0));
  if (shown.length === 0) return null;
  return (
    <dl className="k-hrow k-g24 home-numbers">
      {shown.map(([key, label]) => (
        <div key={key} className="k-stack">
          <dt className="k-xs k-muted">{label}</dt>
          <dd className="k-d k-d30">{number(totals[key] ?? 0)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A post's line in the peek: what it is, when, and the way to it */
function PeekLine({ post, first, when, timezone }: { post: CardPost; first: boolean; when: string | null; timezone: string }) {
  const opens = post.url !== null && post.status !== 'deleted';
  const state = post.status === 'scheduled' && post.scheduledAt ? `Goes out ${shortDateTime(post.scheduledAt, timezone)}` : post.status === 'failed' ? 'Failed' : post.status === 'deleted' ? 'Deleted' : 'No link';
  const body = (
    <>
      <span className="k-grow">
        <strong className="k-sm">{post.label}</strong>
        <br />
        <span className="k-xs k-muted">{opens ? when : state}</span>
      </span>
      {opens && (
        <span className="k-hrow k-g6 k-sm">
          {first ? 'Open the post' : 'Open'} <Icon name="external" size={16} />
        </span>
      )}
    </>
  );
  if (!opens) return <div className="k-row">{body}</div>;
  return (
    <a className="k-row home-peek-line" href={post.url ?? undefined} target="_blank" rel="noopener noreferrer">
      {body}
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

/** A channel's mark: the network and its state dot; it opens the channel's peek */
function ChannelMark({ c, launch, timezone }: { c: CardChannel; launch: HomeLaunch; timezone: string }) {
  const [open, setOpen] = useState(false);
  const word = MARK_WORD[c.mark];
  const name = `${networkOf(c.channel)}: ${word.toLowerCase()}`;
  const totals = launch.numbers?.channels[c.channel]?.totals ?? {};
  const at = (id: number) => {
    const post = launch.posts.find((p) => p.id === id);
    return post?.publishedAt ? shortDateTime(post.publishedAt, timezone) : null;
  };
  const lines = c.posts.filter((p) => p.status !== 'deleted' || p.url === null);
  return (
    <Sheet
      label={`${networkOf(c.channel)} on this launch`}
      open={open}
      onOpenChange={setOpen}
      className="home-peek"
      trigger={
        <button type="button" className="home-mark" title={name} aria-label={`${name}. ${c.posts.length === 1 ? '1 post' : `${c.posts.length} posts`}`}>
          <NetworkGlyph channel={c.channel} size={15} />
          <span className={`k-dot ${DOT[c.mark]}`} aria-hidden="true" />
        </button>
      }
    >
      <div className="k-hrow k-between">
        <span className="k-hrow k-g10 home-peek-net">
          <NetworkGlyph channel={c.channel} size={22} /> {networkOf(c.channel)}
        </span>
        <span className="k-hrow k-g6 k-sm">
          <span className={`k-dot ${DOT[c.mark]}`} aria-hidden="true" /> {word}
        </span>
      </div>
      <Numbers totals={totals} />
      <div className="k-stack">
        {lines.map((p, i) => (
          <PeekLine key={p.id} post={p} first={i === 0} when={at(p.id)} timezone={timezone} />
        ))}
        {c.posts.length === 0 && (
          <div className="k-row">
            <span className="k-grow k-sm">{launch.failures.find((f) => f.channel === c.channel)?.message.split('\n')[0] ?? 'It failed before anything went out.'}</span>
          </div>
        )}
      </div>
      <SheetClose render={<Link className="k-btn k-full" to="/launches/$id" params={{ id: String(launch.id) }} search={{ tab: 'channels', channel: c.channel }} />}>See it on the launch page</SheetClose>
    </Sheet>
  );
}

/** What the card's line under the name says: the repo (or Article) and the day, or since when it drafts */
function metaOf(launch: HomeLaunch, timezone: string, article: boolean): string {
  const where = article ? 'Article' : launch.repo;
  if (launch.status === 'detected' || launch.status === 'generating') return `${where} · started ${agoLabel(launch.createdAt)} by ${TRIGGER_BY[launch.trigger] ?? 'you'}`;
  return `${where} · ${shortDate(launch.createdAt, timezone)}`;
}

export function LaunchCard({ launch, timezone }: { launch: HomeLaunch; timezone: string }) {
  const { title, version, article } = launchTitle(launch);
  const channels = cardChannels({ posts: launch.posts, failures: launch.failures, postAccounts: launch.postAccounts });
  const drafting = launch.status === 'detected' || launch.status === 'generating';
  const failedEmpty = launch.status === 'failed' && launch.posts.length === 0;
  const tone = launch.state.tone;
  const problem = launch.problem?.split('\n')[0]?.trim().replace(/\.$/, '');
  return (
    <article className={`k-card home-card${tone === 'failed' ? ' k-fail' : ''}`}>
      <div className="k-hrow k-between k-g8 home-card-head">
        <h3 className="home-card-title">
          <Link to="/launches/$id" params={{ id: String(launch.id) }} className="home-card-link">
            {article ? (
              <span className="k-d k-d24 k-clamp2 home-card-article">{title}</span>
            ) : (
              <span className="k-hrow k-g8 home-card-name">
                <span className="k-d k-d30">{title}</span>
                <span className="k-mono k-sm k-muted">{version}</span>
              </span>
            )}
          </Link>
        </h3>
        <StatePill tone={tone} label={launch.state.label} />
      </div>
      <p className="k-xs k-muted home-card-meta">{metaOf(launch, timezone, article)}</p>
      {drafting ? (
        <div className="k-hrow k-g8 k-sm">
          <span className="k-grow home-progress" role="progressbar" aria-label="Drafting" aria-valuetext={launch.drafting ?? 'Drafting'}>
            <span />
          </span>
          <span className="k-muted k-xs">{launch.drafting}</span>
        </div>
      ) : failedEmpty ? (
        <p className="k-sm home-card-text">It failed before anything went out{problem ? `: ${problem}` : ''}.</p>
      ) : (
        <>
          {launch.numbers && channels.length > 0 && <Numbers totals={launch.numbers.totals} />}
          {channels.length > 0 ? (
            <ul className="k-hrow k-g6 k-wrap home-marks" aria-label="Channels">
              {channels.map((c) => (
                <li key={c.channel}>
                  <ChannelMark c={c} launch={launch} timezone={timezone} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="k-sm k-muted home-card-text">
              {launch.status === 'skipped'
                ? 'Nothing was published for this release.'
                : launch.status === 'drafted' && !launch.held && launch.pullRequest
                  ? 'Drafts are waiting in the pull request.'
                  : 'Nothing published yet.'}
            </p>
          )}
        </>
      )}
    </article>
  );
}
