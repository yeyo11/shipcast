import { Link } from '@tanstack/react-router';
import { animate, AnimatePresence, motion, useMotionValue, useTransform } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cardChannels, foldMarks, launchDateLabel, MARK_WORD, type CardChannel, type CardPost, type LaunchNumbers, type Totals } from '../server/launch-summary';
import { zonedLabel } from '../server/pieces';
import { CHANNEL_NAMES, type LaunchView } from '../server/view';
import { ChannelIcon, StateDot } from './launch/Glance';
import { number, Pill } from './ui';
import { ResponsiveMenu } from './ui/ResponsiveMenu';

/*
 * A launch as a summary card (docs/web-app.md): how it did (its totals and the views per day) and
 * where it went (one mark per channel with its state dot). Every mark opens the same menu, a line
 * per post, so the owner opens the one they want, never all. While a channel's menu is open, the
 * numbers and the chart turn to that channel against the launch's own scale; closing it turns them
 * back. Motion counts and morphs the change, instantly for whoever asks for reduced motion.
 */

/** A mark's width and the gap after it, as in app.css (.mark: 36px, .marks: gap 8px) */
const MARK_GAP = 8;
const MARK_STEP = 36 + MARK_GAP;
const EASE = { duration: 0.25, ease: 'easeOut' } as const;

const networkOf = (channel: string) => CHANNEL_NAMES[channel] ?? channel;
const host = (url: string) => url.replace(/^https?:\/\//, '').split('/')[0] ?? url;

const markName = (c: CardChannel) =>
  `${networkOf(c.channel)}: ${MARK_WORD[c.mark].toLowerCase()}${c.accounts.length > 1 ? `, on ${c.accounts.length} accounts (${c.accounts.join(', ')})` : ''}`;

/** A post's line in its channel's menu: `Open the post` when it is the only one */
const lineLabel = (p: CardPost, c: CardChannel) => (c.posts.length === 1 && p.label === 'Post' ? 'Open the post' : p.label);
const opens = (p: CardPost): p is CardPost & { url: string } => p.url !== null && p.status !== 'deleted';

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

function PostLine({ p, c, timezone, onChoose }: { p: CardPost; c: CardChannel; timezone: string; onChoose: () => void }) {
  if (opens(p)) {
    return (
      <a className="pop-line" href={p.url} target="_blank" rel="noopener noreferrer" onClick={onChoose}>
        <span>{lineLabel(p, c)}</span>
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

/** A channel's own numbers, at the top of its sheet on a phone, where the card behind is covered */
function SheetNumbers({ numbers }: { numbers: Partial<Totals> | undefined }) {
  return (
    <dl className="pop-numbers">
      {(['views', 'reactions', 'comments', 'clicks'] as const).map((k) => (
        <div key={k}>
          <dt>{k.charAt(0).toUpperCase() + k.slice(1)}</dt>
          <dd>{numbers?.[k] === undefined ? '—' : number(numbers[k])}</dd>
        </div>
      ))}
    </dl>
  );
}

function Mark({
  c,
  launchId,
  timezone,
  numbers,
  onPeek,
}: {
  c: CardChannel;
  launchId: number;
  timezone: string;
  numbers: Partial<Totals> | undefined;
  onPeek: (channel: string, open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const name = markName(c);
  const count = c.posts.length;
  const change = (next: boolean) => {
    setOpen(next);
    onPeek(c.channel, next);
  };
  return (
    <li className={`mark m-${c.mark} is-link`} data-active={open || undefined}>
      <ResponsiveMenu
        label={networkOf(c.channel)}
        className="pop"
        open={open}
        onOpenChange={change}
        sheetLead={<SheetNumbers numbers={numbers} />}
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
          <PostLine key={p.id} p={p} c={c} timezone={timezone} onChoose={() => change(false)} />
        ))}
        {count === 0 && <span className="pop-line is-quiet">It failed before anything went out</span>}
        <Link className="pop-foot" to="/launches/$id" params={{ id: String(launchId) }} search={{ tab: 'channels', channel: c.channel }}>
          See it on the launch page
        </Link>
      </ResponsiveMenu>
    </li>
  );
}

/** The "+n" menu: each folded channel is its mark, followed by one chip per post */
function MoreMarks({ folded, timezone }: { folded: CardChannel[]; timezone: string }) {
  return (
    <li className="marks-more">
      <ResponsiveMenu
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
          {folded.map((c) => (
            <li key={c.channel}>
              <span className={`mark m-${c.mark}`} role="img" aria-label={markName(c)} title={markName(c)}>
                <MarkFace c={c} />
              </span>
              <span className="pop-chips">
                {c.posts.length === 0 && <span className="is-quiet">Failed</span>}
                {c.posts.map((p) =>
                  opens(p) ? (
                    <a key={p.id} href={p.url} target="_blank" rel="noopener noreferrer">
                      {lineLabel(p, c)}
                      <span className="visually-hidden"> on {networkOf(c.channel)} (opens in a new tab)</span>
                    </a>
                  ) : (
                    <span key={p.id} className="is-quiet">
                      {c.posts.length === 1 && p.label === 'Post' ? postState(p, timezone) : `${p.label} · ${postState(p, timezone)}`}
                    </span>
                  ),
                )}
              </span>
            </li>
          ))}
        </ul>
      </ResponsiveMenu>
    </li>
  );
}

/**
 * The channel marks on one row, problems first. As many as the row's own width holds; when they do
 * not all fit, the rest (the channels that went fine, first) fold behind "+n".
 */
function Marks({
  channels,
  launchId,
  timezone,
  numbers,
  onPeek,
}: {
  channels: CardChannel[];
  launchId: number;
  timezone: string;
  numbers: LaunchNumbers | null;
  onPeek: (channel: string, open: boolean) => void;
}) {
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
      {shown.map((c) => (
        <Mark key={c.channel} c={c} launchId={launchId} timezone={timezone} numbers={numbers?.channels[c.channel]?.totals} onPeek={onPeek} />
      ))}
      {folded.length > 0 && <MoreMarks folded={folded} timezone={timezone} />}
    </ul>
  );
}

/**
 * Views per day since the launch, the card's whole width: an area with its line, the days under it.
 * Paths with the same commands and as many points for every series, so Motion morphs one into the
 * next point by point; a polyline's points cannot be interpolated and would jump.
 */
function DailyArea({ values, max }: { values: number[]; max: number }) {
  const w = 320;
  const h = 96;
  const step = w / Math.max(1, values.length - 1);
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)} ${(h - 4 - (v / Math.max(1, max)) * (h - 12)).toFixed(1)}`).join(' ');
  const area = `${line} L${w} ${h} L0 ${h} Z`;
  return (
    <figure className="darea">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
        <motion.path initial={false} animate={{ d: area }} transition={EASE} className="darea-fill" />
        <motion.path initial={false} animate={{ d: line }} transition={EASE} fill="none" className="darea-line" strokeWidth="2.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
      <figcaption>
        <span className="visually-hidden">Views per day since the launch: {values.map(number).join(', ')}. </span>
        <span aria-hidden="true">Launch day</span>
        <span aria-hidden="true">
          +{values.length - 1} {values.length === 2 ? 'day' : 'days'}
        </span>
      </figcaption>
    </figure>
  );
}

/** A number that counts to its new value instead of swapping; whole numbers, `—` where a network counts none */
function Count({ value }: { value: number | undefined }) {
  const mv = useMotionValue(value ?? 0);
  const text = useTransform(mv, (v) => Math.round(v).toLocaleString('en'));
  useEffect(() => {
    if (value === undefined) return;
    const controls = animate(mv, value, EASE);
    return () => controls.stop();
  }, [mv, value]);
  return value === undefined ? <span title="This network does not count it">—</span> : <motion.span>{text}</motion.span>;
}

/**
 * Which channel the numbers are for, in a quiet pill: its width follows the new name while the name
 * cross-fades inside it, all within a line of fixed height so the card never moves.
 */
function Scope({ channel }: { channel: string | null }) {
  return (
    <p className="lcard-scope" aria-live="polite">
      <motion.span layout transition={{ layout: { duration: 0.25, ease: [0.2, 0.8, 0.2, 1] } }} className={`lcard-pill${channel ? ' is-on' : ''}`}>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={channel ?? 'all'} className="lcard-pill-name" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
            {channel ? (
              <>
                <ChannelIcon channel={channel} size={14} /> {networkOf(channel)} only
              </>
            ) : (
              'All channels'
            )}
          </motion.span>
        </AnimatePresence>
      </motion.span>
    </p>
  );
}

const STATS: ReadonlyArray<[keyof Totals, string]> = [
  ['views', 'Views'],
  ['reactions', 'Reactions'],
  ['comments', 'Comments'],
  ['clicks', 'Clicks'],
];

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
  const [peek, setPeek] = useState<string | null>(null);
  const waiting = launch.state.tone === 'waiting';
  const article = launch.ref.startsWith('article:');
  // A menu closing as another opens must not undo the new one's peek
  const onPeek = (channel: string, open: boolean) => setPeek((now) => (open ? channel : now === channel ? null : now));
  const days = numbers?.daily ?? [];
  const peeked = peek ? numbers?.channels[peek] : undefined;
  const shown: Partial<Totals> = peek ? (peeked?.totals ?? {}) : (numbers?.totals ?? {});
  const byDay = new Map((peeked?.daily ?? []).map((d) => [d.day, d.views]));
  const values = peek ? days.map((d) => byDay.get(d.day) ?? 0) : days.map((d) => d.views);
  return (
    <article className={`lcard${waiting ? ' waiting' : ''}`} data-peek={peek ? '' : undefined}>
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
          <Scope channel={peek} />
          <dl className="lcard-stats">
            {STATS.map(([key, label], i) => (
              <div key={key} className={i === 0 ? 'is-lead' : undefined}>
                <dt>{label}</dt>
                <dd>
                  <Count value={shown[key]} />
                </dd>
              </div>
            ))}
          </dl>
          {days.length > 1 ? (
            <DailyArea values={values} max={Math.max(1, ...days.map((d) => d.views))} />
          ) : (
            <p className="lcard-none">{days.length === 0 ? 'No views read yet.' : `${number(days[0]?.views ?? 0)} views on the launch day so far.`}</p>
          )}
        </>
      )}
      {channels.length > 0 ? (
        <Marks channels={channels} launchId={launch.id} timezone={timezone} numbers={numbers} onPeek={onPeek} />
      ) : (
        <p className="lcard-none">
          {launch.problem ? launch.problem.split('\n')[0] : launch.pullRequest ? 'Drafts are waiting in the pull request.' : 'Nothing published yet.'}
          {launch.status === 'drafted' && launch.pullRequest && (
            <>
              {' '}
              <Link to="/launches/$id/edit" params={{ id: String(launch.id) }}>
                Edit the drafts
              </Link>
            </>
          )}
        </p>
      )}
    </article>
  );
}
