import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { applyBrandPictureNow, applyProfileProposal, getProfileReview, profileReviewJob, reviewProfileNow } from '../server/profiles.functions';
import { wordDiff } from './assistant/diff';
import { dayWord } from './channels/view';
import { Icon } from './kit/Icon';
import { Sheet } from './kit/Sheet';
import { useLiveEnabled, useLiveInterest } from './live/Live';
import { useToast } from './Toasts';
import { when } from './ui';

export type ProfileView = NonNullable<Awaited<ReturnType<typeof getProfileReview>>>;
type Proposal = NonNullable<ProfileView['review']>['proposals'][number];

const FIELD_NAMES: Record<Proposal['field'], string> = { displayName: 'Name', bio: 'Bio', links: 'Links', avatar: 'Picture' };

/** LinkedIn calls its bio the About section; the others' own words are the defaults */
function fieldName(network: string, field: Proposal['field']): string {
  return network === 'linkedin' && field === 'bio' ? 'About' : FIELD_NAMES[field];
}

/**
 * Where a profile's review stands, for its card on the network's page (board ChannelNetwork): how
 * many proposals still wait, or that there is none yet.
 */
export function reviewStanding(view: ProfileView | null): { pill: string; tone: 'k-p-wait' | 'k-p-pub' | 'k-p-quiet'; reviewed: boolean } {
  const review = view?.review;
  if (!review) return { pill: 'Not reviewed', tone: 'k-p-quiet', reviewed: false };
  const open = review.proposals.filter((p) => !p.appliedAt).length;
  if (open === 0) return { pill: review.proposals.length === 0 ? 'Nothing to change' : 'All applied', tone: 'k-p-pub', reviewed: true };
  return { pill: `${open} ${open === 1 ? 'proposal' : 'proposals'}`, tone: 'k-p-wait', reviewed: true };
}

/** A confirmation as the boards ask one: the question, what it does, and the way out first */
function ConfirmSheet({ open, onOpenChange, title, children, confirm, onConfirm }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; children: ReactNode; confirm: string; onConfirm: () => void }) {
  return (
    <Sheet label={title} open={open} onOpenChange={onOpenChange} className="ch-sheet">
      <h2 className="k-d k-d30">{title}</h2>
      <p className="ch-flush">{children}</p>
      <div className="k-hrow k-g10">
        <button type="button" className="k-btn" onClick={() => onOpenChange(false)}>
          Keep it
        </button>
        <button
          type="button"
          className="k-btn k-pri k-grow"
          onClick={() => {
            onOpenChange(false);
            onConfirm();
          }}
        >
          {confirm}
        </button>
      </div>
    </Sheet>
  );
}

/** The proposal against what it replaces, word by word: struck and red where removed, green where added */
function InlineDiff({ before, after, long }: { before: string; after: string; long: boolean }) {
  const parts = useMemo(() => {
    const words = wordDiff(before, after);
    // A rewrite (little kept) reads better as the old text struck, then the new one, than as confetti
    const kept = words.filter((p) => p.type === 'equal' && p.text.trim()).reduce((n, p) => n + p.text.length, 0);
    if (before.trim() && kept < Math.min(before.length, after.length) / 2) {
      return [
        { type: 'delete' as const, text: before },
        { type: 'equal' as const, text: ' ' },
        { type: 'insert' as const, text: after },
      ];
    }
    return words;
  }, [before, after]);
  const [all, setAll] = useState(false);
  const body = parts.map((part, i) =>
    part.type === 'equal' ? (
      <span key={i}>{part.text}</span>
    ) : part.type === 'delete' ? (
      <del key={i} className="k-diff-del">
        <span className="visually-hidden"> [deleted: </span>
        {part.text}
        <span className="visually-hidden">] </span>
      </del>
    ) : (
      <ins key={i} className="k-diff-add ch-ins">
        <span className="visually-hidden"> [inserted: </span>
        {part.text}
        <span className="visually-hidden">] </span>
      </ins>
    ),
  );
  if (!long) return <div className="ch-diff">{body}</div>;
  // A long field shows three lines; a tap opens the rest
  return (
    <button type="button" className={`ch-diff is-long ch-diff-toggle${all ? '' : ' k-clamp3'}`} aria-expanded={all} onClick={() => setAll((a) => !a)}>
      {body}
    </button>
  );
}

function ProposalCard({ proposal, index, count, network, accountId, canApply, onApplied }: { proposal: Proposal; index: number; count: number; network: { id: string; name: string }; accountId: number; canApply: boolean; onApplied: () => Promise<void> }) {
  const [value, setValue] = useState(proposal.proposed);
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
  const toast = useToast();
  const name = fieldName(network.id, proposal.field);
  const lower = name.toLowerCase();
  const advice = proposal.field === 'avatar';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.done('Copied', `Paste it into the ${lower} on ${network.name}.`);
    } catch {
      toast.fail('The browser did not allow copying: select the text and copy it by hand');
    }
  };
  const apply = async () => {
    const result = await applyProfileProposal({ data: { id: accountId, field: proposal.field as 'displayName' | 'bio' | 'links', value } }).catch((error: unknown) => ({
      ok: false as const,
      problem: error instanceof Error ? error.message : String(error),
    }));
    if (!result.ok) {
      toast.fail(result.problem);
      return;
    }
    toast.done('Profile changed', `The ${lower} is updated on ${network.name}.`);
    await onApplied();
  };

  return (
    <section className="k-card ch-proposal" aria-label={`${name}, proposal ${index} of ${count}`}>
      <div className="k-hrow k-between k-g8">
        <span className="k-lbl">{name}</span>
        {proposal.appliedAt ? (
          <span className="k-xs k-muted">Applied {when(proposal.appliedAt)} UTC</span>
        ) : (
          <span className="k-xs k-muted">
            {index} of {count}
          </span>
        )}
      </div>
      {advice ? (
        <p className="k-sm ch-flush">{value}</p>
      ) : editing ? (
        <label className="k-field">
          <span className="visually-hidden">Proposed {lower}, editable</span>
          <textarea className={`k-input ch-input${proposal.field === 'links' ? ' k-mono' : ''}`} rows={proposal.field === 'displayName' ? 2 : 5} value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
      ) : (
        <InlineDiff before={proposal.current} after={value} long={proposal.field !== 'displayName'} />
      )}
      <p className="k-xs k-muted ch-flush">Why: {proposal.why}</p>
      {proposal.problem && value === proposal.proposed && (
        <div className="k-notice k-bad">
          <Icon name="help" size={18} />
          <div className="k-grow">{proposal.problem}</div>
        </div>
      )}
      {!advice && (
        <div className="k-hrow k-g8">
          {canApply ? (
            <button type="button" className="k-btn k-sm ch-apply" disabled={!value.trim() && proposal.field === 'displayName'} onClick={() => setAsking(true)}>
              <Icon name="check" size={18} />
              Apply on {network.name}
            </button>
          ) : (
            <button type="button" className="k-btn k-sm ch-apply" onClick={() => void copy()}>
              <Icon name="copy" size={18} />
              Copy the {lower}
            </button>
          )}
          <button type="button" className="k-btn k-sm k-icon" aria-label={editing ? `Done editing the ${lower}` : `Edit the ${lower}`} aria-pressed={editing} onClick={() => setEditing((e) => !e)}>
            <Icon name={editing ? 'check' : 'write'} size={18} />
          </button>
          {canApply && (
            <button type="button" className="k-btn k-sm k-ghost" onClick={() => void copy()}>
              Copy
            </button>
          )}
        </div>
      )}
      <ConfirmSheet open={asking} onOpenChange={setAsking} title={`Change the ${lower} on ${network.name}?`} confirm={`Change the ${lower}`} onConfirm={() => void apply()}>
        This writes to your real profile now, in public. The {lower} becomes the text you see here; you can change it back by hand.
      </ConfirmSheet>
    </section>
  );
}

/**
 * One account's profile review (board ProfileReview): start it (a job, since the AI takes a
 * while), then each proposal as a diff against the field as it is, editable before it goes
 * anywhere, with Apply where the network's API and this account's credential allow it (after a
 * confirmation: it changes the real profile) and Copy everywhere else.
 */
export function ProfileReview({ account, network, initial, now }: { account: { id: number; label: string; failed: boolean }; network: { id: string; name: string }; initial: ProfileView | null; now: string }) {
  const [view, setView] = useState<ProfileView | null>(initial);
  const [job, setJob] = useState<string | null>(null);
  const [pasted, setPasted] = useState({ displayName: '', bio: '', links: '' });
  const [picture, setPicture] = useState(false);
  const toast = useToast();
  useEffect(() => setView(initial), [initial]);

  /** Reads the job once: when it has ended, the review is read again; true once it has */
  const settle = useCallback(
    async (id: string) => {
      const state = await profileReviewJob({ data: id }).catch(() => null);
      if (!state || state.state === 'created' || state.state === 'active' || state.state === 'retry') return false;
      setJob((current) => (current === id ? null : current));
      if (state.state === 'failed') toast.fail(state.log.at(-1) ?? 'The review failed');
      setView(await getProfileReview({ data: account.id }));
      return true;
    },
    [account.id, toast],
  );
  // Live: the job's own events (ended, or a resync) say when to read it
  const live = useLiveEnabled();
  useLiveInterest(live && job ? ['job'] : null, {
    accepts: (e) => e.data.id === job && (e.data.state === 'completed' || e.data.state === 'failed'),
    reload: () => {
      if (job) void settle(job);
    },
    debounceMs: 0,
  });
  // Otherwise, while the review runs, its job is read every few seconds
  useEffect(() => {
    if (!job || live) return;
    const timer = setInterval(() => {
      void settle(job).then((done) => {
        if (done) clearInterval(timer);
      });
    }, 3000);
    return () => clearInterval(timer);
  }, [job, live, settle]);

  const capability = view?.capability;
  if (!capability) return <p className="k-muted ch-flush">{network.name} has no profile Shipcast can review.</p>;
  const review = view.review;
  const pastable = capability.read ? (capability.paste ?? []) : capability.fields;
  const canEdit = capability.edit === 'yes' && !account.failed;
  const pasteReady = capability.read || pasted.bio.trim() !== '' || pasted.displayName.trim() !== '' || pasted.links.trim() !== '';

  const start = async () => {
    // A read profile takes only the fields its API leaves out
    const fields = Object.entries(pasted).filter(([field, v]) => v.trim() && (!capability.read || pastable.includes(field as keyof typeof pasted)));
    const request = fields.length > 0 ? { pasted: Object.fromEntries(fields) } : {};
    const started = await reviewProfileNow({ data: { id: account.id, request } }).catch((error: unknown) => ({ ok: false as const, problem: error instanceof Error ? error.message : String(error) }));
    if (started.ok) setJob(started.job);
    else toast.fail(started.problem);
  };
  const applyPicture = async () => {
    const result = await applyBrandPictureNow({ data: account.id }).catch((error: unknown) => ({ ok: false as const, problem: error instanceof Error ? error.message : String(error) }));
    if (result.ok) toast.done('Picture changed', 'The picture is brand.yml’s avatar now.');
    else toast.fail(result.problem);
  };
  const reload = async () => setView(await getProfileReview({ data: account.id }));

  const pasteFields = pastable.some((f) => f !== 'avatar') && (
    <>
      <p className="k-sm k-muted ch-flush">{capability.read ? `Optional: ${network.name}’s API leaves these out, so paste them to have them reviewed too.` : `${network.name}’s API does not give the profile: paste what it says now.`}</p>
      {pastable.includes('displayName') && (
        <label className="k-field">
          <span className="k-lbl">Name</span>
          <input className="k-input ch-input" value={pasted.displayName} onChange={(e) => setPasted({ ...pasted, displayName: e.target.value })} />
        </label>
      )}
      {(!capability.read || pastable.includes('bio')) && (
        <label className="k-field">
          <span className="k-lbl">{fieldName(network.id, 'bio')}</span>
          <textarea className="k-input ch-input" rows={4} value={pasted.bio} onChange={(e) => setPasted({ ...pasted, bio: e.target.value })} />
        </label>
      )}
      {pastable.includes('links') && (
        <label className="k-field">
          <span className="k-lbl">Links</span>
          <textarea className="k-input ch-input k-mono" rows={2} value={pasted.links} onChange={(e) => setPasted({ ...pasted, links: e.target.value })} />
          <span className="k-help">One per line, as Label: address</span>
        </label>
      )}
    </>
  );
  const open = review?.proposals ?? [];

  return (
    <div className="k-stack k-g12">
      <h1 className="k-d k-d48">Profile review</h1>
      <p className="k-sm k-muted ch-flush" title={review?.summary}>
        {review
          ? `For ${account.label}, read ${dayWord(review.reviewedAt, now)}. Each field on its own; nothing changes until you apply it.`
          : `For ${account.label}. The AI reads the profile, how the account grew and your brand, and proposes each field’s new text. Nothing changes until you apply a proposal.`}
      </p>
      {job && (
        <div className="k-notice k-wait" role="status">
          <span className="ch-notice-icon">
            <Icon name="clock" size={18} />
          </span>
          <div className="k-grow">The AI is reading the profile and its numbers; this takes a minute or so. You can leave the page: the review is kept.</div>
        </div>
      )}
      {review && review.proposals.length === 0 && <p className="k-muted ch-flush">No change proposed: the profile already works.</p>}
      {open.map((p, i) => (
        <ProposalCard key={`${review?.reviewedAt}-${p.field}`} proposal={p} index={i + 1} count={open.length} network={network} accountId={account.id} canApply={canEdit && (capability.editable as string[]).includes(p.field)} onApplied={reload} />
      ))}
      {review && capability.edit !== 'yes' ? (
        <div className="k-notice k-wait">
          <span className="ch-notice-icon">
            <Icon name="help" size={18} />
          </span>
          <div className="k-grow">{capability.note}.</div>
        </div>
      ) : review && account.failed ? (
        <div className="k-notice k-wait">
          <span className="ch-notice-icon">
            <Icon name="help" size={18} />
          </span>
          <div className="k-grow">{network.name} must work again before a proposal can be applied.</div>
        </div>
      ) : null}
      {canEdit && capability.brandPicture && (
        <section className="k-card k-flat">
          <span className="k-lbl ch-white">Picture</span>
          <p className="k-sm k-muted ch-flush">Shipcast can set brand.yml’s avatar as this account’s picture.</p>
          <button type="button" className="k-btn k-sm" onClick={() => setPicture(true)}>
            Use brand.yml’s picture
          </button>
          <ConfirmSheet open={picture} onOpenChange={setPicture} title={`Change the picture on ${network.name}?`} confirm="Change the picture" onConfirm={() => void applyPicture()}>
            This sets the avatar in brand.yml as this account’s picture now, in public; you can change it back by hand.
          </ConfirmSheet>
        </section>
      )}
      <section className="k-card k-flat ch-review-start" aria-label={review ? 'Review it again' : 'Review this profile'}>
        {pasteFields}
        <button type="button" className={`k-btn k-full${review ? '' : ' k-pri'}`} disabled={job !== null || !pasteReady} onClick={() => void start()}>
          {job ? 'Reviewing…' : review ? 'Review it again' : 'Review this profile'}
        </button>
      </section>
    </div>
  );
}
