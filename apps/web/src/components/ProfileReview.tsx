import { useEffect, useRef, useState } from 'react';
import { applyProfileProposal, getProfileReview, profileReviewJob, reviewProfileNow } from '../server/profiles.functions';
import { DiffView } from './assistant/DiffView';
import { useToast } from './Toasts';
import { Notice, when } from './ui';
import { ConfirmButton } from './ui/ConfirmButton';

type View = NonNullable<Awaited<ReturnType<typeof getProfileReview>>>;
type Proposal = NonNullable<View['review']>['proposals'][number];

const FIELD_NAMES: Record<Proposal['field'], string> = { displayName: 'Name', bio: 'Bio', links: 'Links', avatar: 'Picture' };

/**
 * One account's profile review: start it (a job, since the AI takes a while), then each proposal as
 * a diff against the field as it is, editable before it goes anywhere, with Copy everywhere and Apply
 * where the network's API and this account's credential allow it. Apply asks first: it changes the
 * real profile.
 */
export function ProfileReview({ account, network, initial, focused }: { account: { id: number; label: string }; network: string; initial: View | null; focused: boolean }) {
  const [view, setView] = useState<View | null>(initial);
  const [job, setJob] = useState<string | null>(null);
  const [pasted, setPasted] = useState({ displayName: '', bio: '', links: '' });
  const toast = useToast();
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'start' });
  }, [focused]);

  // While the review runs, its job is read every few seconds; the review is read again once it ends
  useEffect(() => {
    if (!job) return;
    const timer = setInterval(async () => {
      const state = await profileReviewJob({ data: job }).catch(() => null);
      if (!state || state.state === 'created' || state.state === 'active' || state.state === 'retry') return;
      clearInterval(timer);
      setJob(null);
      if (state.state === 'failed') toast.fail(state.log.at(-1) ?? 'The review failed');
      setView(await getProfileReview({ data: account.id }));
    }, 3000);
    return () => clearInterval(timer);
  }, [job, account.id, toast]);

  const capability = view?.capability;
  if (!capability) return null;
  const review = view.review;

  const start = async () => {
    const request = capability.read ? {} : { pasted: Object.fromEntries(Object.entries(pasted).filter(([, v]) => v.trim())) };
    const started = await reviewProfileNow({ data: { id: account.id, request } }).catch((error: unknown) => ({ ok: false as const, problem: error instanceof Error ? error.message : String(error) }));
    if (started.ok) setJob(started.job);
    else toast.fail(started.problem);
  };

  return (
    <section className="card profile-review" ref={ref} aria-labelledby={`review-${account.id}`}>
      <header>
        <h3 className="ph" id={`review-${account.id}`}>
          {account.label}
        </h3>
        <button type="button" className="btn btn-primary" disabled={job !== null || (!capability.read && !pasted.bio.trim() && !pasted.displayName.trim() && !pasted.links.trim())} onClick={start}>
          {job ? 'Reviewing…' : review ? 'Review it again' : 'Review this profile'}
        </button>
      </header>
      <p className="muted">
        {capability.edit === 'yes' ? 'Proposals can be applied here, after you confirm each one. ' : ''}
        {capability.note}.
      </p>
      {capability.edit === 'reconnect' && (
        <Notice tone="wait">
          Reconnect to allow profile edits: <a href={`/channels/${network}`}>connect this account again</a> and Shipcast will ask for the permission. Reviews and Copy work meanwhile.
        </Notice>
      )}
      {!capability.read && (
        <div className="profile-paste">
          <p className="muted">This network’s API does not give the profile: paste what it says now.</p>
          {capability.fields.includes('displayName') && (
            <div className="field">
              <label htmlFor={`paste-name-${account.id}`}>Name</label>
              <input id={`paste-name-${account.id}`} className="input" value={pasted.displayName} onChange={(e) => setPasted({ ...pasted, displayName: e.target.value })} />
            </div>
          )}
          <div className="field">
            <label htmlFor={`paste-bio-${account.id}`}>Bio</label>
            <textarea id={`paste-bio-${account.id}`} className="textarea" rows={3} value={pasted.bio} onChange={(e) => setPasted({ ...pasted, bio: e.target.value })} />
          </div>
          {capability.fields.includes('links') && (
            <div className="field">
              <label htmlFor={`paste-links-${account.id}`}>
                Links <span className="muted">(one per line, as Label: address)</span>
              </label>
              <textarea id={`paste-links-${account.id}`} className="textarea mono" rows={2} value={pasted.links} onChange={(e) => setPasted({ ...pasted, links: e.target.value })} />
            </div>
          )}
        </div>
      )}
      {job && <Notice tone="wait">The AI is reading the profile and its numbers; this takes a minute or so. You can leave the page: the review is kept.</Notice>}
      {review && (
        <>
          <p>
            <strong>{review.summary}</strong> <span className="muted">Reviewed {when(review.reviewedAt)} UTC, in {review.language}.</span>
          </p>
          {review.proposals.length === 0 ? (
            <p className="muted">No change proposed: the profile already works.</p>
          ) : (
            <ol className="profile-proposals">
              {review.proposals.map((p, i) => (
                <ProposalItem key={`${review.reviewedAt}-${i}`} proposal={p} accountId={account.id} canApply={capability.edit === 'yes' && (capability.editable as string[]).includes(p.field)} onApplied={async () => setView(await getProfileReview({ data: account.id }))} />
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}

function ProposalItem({ proposal, accountId, canApply, onApplied }: { proposal: Proposal; accountId: number; canApply: boolean; onApplied: () => Promise<void> }) {
  const [value, setValue] = useState(proposal.proposed);
  const toast = useToast();
  const name = FIELD_NAMES[proposal.field];
  const advice = proposal.field === 'avatar';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.done('Copied', `Paste it into the ${name.toLowerCase()} on the network.`);
    } catch {
      toast.fail('The browser did not allow copying: select the text and copy it by hand');
    }
  };

  return (
    <li className="proposal">
      <div className="proposal-head">
        <strong>{name}</strong>
        {proposal.appliedAt && <span className="proposal-wait">Applied {when(proposal.appliedAt)} UTC</span>}
      </div>
      <p>{proposal.why}</p>
      {advice ? (
        <p className="chat-prose">{value}</p>
      ) : (
        <>
          <DiffView before={proposal.current} after={value} label={`${name}: the change proposed`} />
          <div className="field">
            <label htmlFor={`proposal-${accountId}-${proposal.field}`}>Proposed {name.toLowerCase()}, editable</label>
            <textarea id={`proposal-${accountId}-${proposal.field}`} className={`textarea${proposal.field === 'links' ? ' mono' : ''}`} rows={proposal.field === 'displayName' ? 1 : 3} value={value} onChange={(e) => setValue(e.target.value)} />
          </div>
        </>
      )}
      {proposal.problem && value === proposal.proposed && <Notice tone="bad">{proposal.problem}</Notice>}
      <div className="row">
        {canApply && !advice && (
          <ConfirmButton
            className="btn btn-primary"
            disabled={!value.trim() && proposal.field === 'displayName'}
            title={`Change the ${name.toLowerCase()} on the network?`}
            description={<>This writes to your real profile now, in public. The {name.toLowerCase()} becomes the text you see here; you can change it back by hand.</>}
            confirm={`Change the ${name.toLowerCase()}`}
            tone="primary"
            onConfirm={async () => {
              const result = await applyProfileProposal({ data: { id: accountId, field: proposal.field as 'displayName' | 'bio' | 'links', value } }).catch((error: unknown) => ({
                ok: false as const,
                problem: error instanceof Error ? error.message : String(error),
              }));
              if (!result.ok) {
                toast.fail(result.problem);
                return;
              }
              toast.done('Profile changed', `The ${name.toLowerCase()} is updated on the network.`);
              await onApplied();
            }}
          >
            Apply
          </ConfirmButton>
        )}
        <button type="button" className="btn" onClick={copy}>
          Copy
        </button>
      </div>
    </li>
  );
}
