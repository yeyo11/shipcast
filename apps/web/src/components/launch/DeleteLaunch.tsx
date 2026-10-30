import { useEffect, useState } from 'react';
import { deleteLaunch, getDeletion } from '../../server/launches.functions';
import { CHANNEL_NAMES } from '../../server/view';
import { useToast } from '../Toasts';
import { Notice } from '../ui';
import { ConfirmDialog } from '../ui/ConfirmButton';

type Answer = Awaited<ReturnType<typeof getDeletion>>;
type Plan = Extract<Answer, { ok: true }>['plan'];

const posts = (n: number) => `${n} ${n === 1 ? 'post' : 'posts'}`;

/** What deleting a channel's posts does there, after its name */
function effect(remove: Plan['channels'][number]['remove']): string {
  if (remove === 'no') return 'cannot be deleted there, it stays';
  if (remove === 'unpublish') return 'unpublished';
  return 'deleted';
}

/**
 * Deleting a launch (docs/launch-delete.md): what it would do is read when the dialog opens. A launch
 * never published is removed; a published one is hidden, its posts kept unless the owner ticks their
 * channel, and the article's removal says how many posts would be left linking nowhere.
 */
export function DeleteLaunch({ launchId, open, onOpenChange, onDeleted }: { launchId: number; open: boolean; onOpenChange: (open: boolean) => void; onDeleted: () => void | Promise<void> }) {
  const toast = useToast();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [ticked, setTicked] = useState<string[]>([]);

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
  const description = !plan ? (
    <p>{problem ?? 'Reading what it would do…'}</p>
  ) : hidden ? (
    <>
      <p>It published, so it is hidden: gone from the lists, the rounds and the numbers, and nothing more of it goes out.</p>
      <p>Its posts stay on the networks unless you tick their channel below.</p>
    </>
  ) : (
    <>
      <p>Nothing of it was published, so it goes with its drafts. Its drafts pull request, or its preview on the site, is closed.</p>
      <p>Its release is not launched again by its events.</p>
    </>
  );

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete this launch?"
      description={description}
      body={
        plan && (
          <>
            {plan.refused && <Notice tone="bad">This launch cannot be deleted: {plan.refused}.</Notice>}
            {hidden && !plan.refused && plan.channels.length > 0 && (
              <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="label">Also delete on the networks</legend>
                <div className="checks">
                  {plan.channels.map((c) => (
                    <label className="check" key={c.channel}>
                      <input
                        type="checkbox"
                        disabled={c.remove === 'no'}
                        checked={ticked.includes(c.channel)}
                        onChange={(e) => setTicked(e.target.checked ? [...ticked, c.channel] : ticked.filter((x) => x !== c.channel))}
                      />
                      {CHANNEL_NAMES[c.channel] ?? c.channel} · {posts(c.out)}, {effect(c.remove)}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            {articleGoes && plan.articleLinks > 0 && (
              <Notice tone="wait">
                {posts(plan.articleLinks)} {plan.articleLinks === 1 ? 'links' : 'link'} to the article. Without it, {plan.articleLinks === 1 ? 'that link points' : 'those links point'} to a page that is gone.
              </Notice>
            )}
          </>
        )
      }
      confirm={hidden ? 'Delete the launch' : 'Delete it'}
      confirmDisabled={!plan || Boolean(plan.refused)}
      onConfirm={async () => {
        const answer = await deleteLaunch({ data: { id: launchId, channels: ticked } }).catch((error: unknown) => ({ ok: false as const, problem: error instanceof Error ? error.message : String(error) }));
        if (!answer.ok) return toast.fail(answer.problem);
        const notes = [...(answer.warning ? [answer.warning] : []), ...answer.failed, ...answer.problems];
        const title = answer.mode === 'removed' ? 'Launch deleted' : 'Launch hidden';
        if (answer.failed.length > 0) toast.fail(`${title}, but some posts are still out\n${notes.join('\n')}`);
        else toast.done(title, notes.length > 0 ? notes.join(' ') : answer.deleted > 0 ? `${posts(answer.deleted)} deleted on the networks.` : undefined);
        await onDeleted();
      }}
    />
  );
}
