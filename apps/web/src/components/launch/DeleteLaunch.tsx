import { useEffect, useState } from 'react';
import { Sheet } from '../kit/Sheet';
import { deleteLaunch, getDeletion } from '../../server/launches.functions';
import { useToast } from '../Toasts';
import { channelTitle } from './ChannelGlyph';
import { Tick } from './UnpublishSheet';

type Answer = Awaited<ReturnType<typeof getDeletion>>;
type Plan = Extract<Answer, { ok: true }>['plan'];

const ARTICLES = new Set(['blog', 'devto', 'hashnode']);

/** What a channel holds of the launch, under its name: `1 post`, `2 articles` */
function holds(channel: string, n: number): string {
  const word = ARTICLES.has(channel) ? 'article' : 'post';
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

/** What ticking a channel does there, where it is not plainly a delete */
function effect(remove: Plan['channels'][number]['remove']): string {
  if (remove === 'no') return ', cannot be deleted there: it stays';
  if (remove === 'unpublish') return ', unpublished';
  return '';
}

/**
 * Deleting a launch (board DeleteLaunch, docs/launch-delete.md): what it would do is read when the
 * sheet opens. A launch never published is removed; a published one is hidden, its posts kept
 * unless the owner ticks their channel, and the article's removal says how many posts would be left
 * linking nowhere.
 */
export function DeleteLaunch({ launchId, open, onOpenChange, onDeleted }: { launchId: number; open: boolean; onOpenChange: (open: boolean) => void; onDeleted: () => void | Promise<void> }) {
  const toast = useToast();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [ticked, setTicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPlan(null);
    setProblem(null);
    setTicked([]);
    void getDeletion({ data: launchId })
      .then((answer) => (answer.ok ? setPlan(answer.plan) : setProblem(answer.problem)))
      .catch((error: unknown) => setProblem(error instanceof Error ? error.message : String(error)));
  }, [open, launchId]);

  const hidden = plan?.mode === 'hidden';
  const articleGoes = ticked.includes('blog');

  const confirm = async () => {
    setBusy(true);
    const answer = await deleteLaunch({ data: { id: launchId, channels: ticked } }).catch((error: unknown) => ({ ok: false as const, problem: error instanceof Error ? error.message : String(error) }));
    setBusy(false);
    if (!answer.ok) return toast.fail(answer.problem);
    const notes = [...(answer.warning ? [answer.warning] : []), ...answer.failed, ...answer.problems];
    const title = answer.mode === 'removed' ? 'Launch deleted' : 'Launch hidden';
    const posts = (n: number) => `${n} ${n === 1 ? 'post' : 'posts'}`;
    if (answer.failed.length > 0) toast.fail(`${title}, but some posts are still out\n${notes.join('\n')}`);
    else toast.done(title, notes.length > 0 ? notes.join(' ') : answer.deleted > 0 ? `${posts(answer.deleted)} deleted on the networks.` : undefined);
    onOpenChange(false);
    await onDeleted();
  };

  return (
    <Sheet label="Delete this launch?" open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <h2 className="k-d k-d30">Delete this launch?</h2>
      {!plan ? (
        <p className="pub-flush">{problem ?? 'Reading what it would do…'}</p>
      ) : hidden ? (
        <>
          <p className="pub-flush">
            It published, so it is <strong>hidden</strong>: gone from the lists, the rounds and the numbers, and nothing more of it goes out.
          </p>
          <p className="k-sm k-muted pub-flush">Its posts stay on the networks unless you tick their channel.</p>
        </>
      ) : (
        <>
          <p className="pub-flush">
            Nothing of it was published, so it goes with its drafts. Its drafts pull request, or its preview on the site, is <strong>closed</strong>.
          </p>
          <p className="k-sm k-muted pub-flush">Its release is not launched again by its events.</p>
        </>
      )}
      {plan?.refused && <div className="k-notice k-bad">This launch cannot be deleted: {plan.refused}.</div>}
      {plan && hidden && !plan.refused && plan.channels.length > 0 && (
        <fieldset className="k-stack pub-fieldset">
          <legend className="k-lbl pub-legend">Also delete on the networks</legend>
          {plan.channels.map((c) => (
            <label key={c.channel} className="k-row pub-pick">
              <Tick
                checked={ticked.includes(c.channel)}
                disabled={c.remove === 'no'}
                onChange={(on) => setTicked(on ? [...ticked, c.channel] : ticked.filter((x) => x !== c.channel))}
              />
              <span className="k-grow">
                {channelTitle(c.channel)}
                <br />
                <span className="k-xs k-muted">
                  {holds(c.channel, c.out)}
                  {effect(c.remove)}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {plan && articleGoes && plan.articleLinks > 0 && (
        <div className="k-notice">
          {plan.articleLinks} {plan.articleLinks === 1 ? 'post links' : 'posts link'} to the article. Without it, {plan.articleLinks === 1 ? 'that link points' : 'those links point'} to a page that is gone.
        </div>
      )}
      <div className="k-hrow k-g10">
        <button type="button" className="k-btn" onClick={() => onOpenChange(false)} disabled={busy}>
          Keep it
        </button>
        <button type="button" className="k-btn k-danger pub-fill" disabled={!plan || Boolean(plan.refused) || busy} onClick={confirm}>
          {busy ? 'Deleting…' : hidden ? 'Delete the launch' : 'Delete it'}
        </button>
      </div>
    </Sheet>
  );
}
