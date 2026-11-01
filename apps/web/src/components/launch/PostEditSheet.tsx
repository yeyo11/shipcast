import { channelDefinition } from '@shipcast/schema/channels';
import { useId, useLayoutEffect, useRef, useState, type UIEvent } from 'react';
import { diffSummary, wordDiff, type Part } from '../assistant/diff';
import { Sheet } from '../kit/Sheet';
import { multiEditPlan, networkName, singleEditChanges, type EditForm, type PieceRow, type SharedChanges } from '../../server/pieces';
import { number } from '../ui';
import { listWords } from './published';

/*
 * Editing what went out (boards PostEdit): one piece in a sheet, its text starting from the text as
 * it went out with what the owner adds marked as they type, the count against the network's limit
 * and, before saving, what changes. Several pieces at once share a text, link or image, with what
 * each network does with them. The rules are server/pieces.ts's (tested); the engine refuses again.
 */

const pieceTitle = (row: Pick<PieceRow, 'channel' | 'piece'>) => (row.piece ? `${networkName(row.channel)} ${row.piece}` : networkName(row.channel));

/** A textarea over a copy of its text in which the words added since `base` are marked */
function DiffArea({ id, base, value, onChange, label }: { id: string; base: string; value: string; onChange: (next: string) => void; label: string }) {
  const behind = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  // The box grows with the text up to a point, so what was just added at the end stays in sight
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(320, Math.max(146, el.scrollHeight))}px`;
  }, [value]);
  const parts: Part[] = base ? wordDiff(base, value).filter((p) => p.type !== 'delete') : [{ type: 'equal', text: value }];
  const sync = (e: UIEvent<HTMLTextAreaElement>) => {
    if (behind.current) behind.current.scrollTop = e.currentTarget.scrollTop;
  };
  return (
    <div className="pub-diffarea k-input">
      <div className="pub-diffarea-behind" ref={behind} aria-hidden="true">
        {parts.map((p, i) => (p.type === 'insert' ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
        {/* A last line break needs a character after it to take its height */}
        {'​'}
      </div>
      <textarea ref={area} id={id} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} onScroll={sync} spellCheck />
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <div className="k-field">
      <label className="k-lbl" htmlFor={id}>
        {label}
      </label>
      <input id={id} className="k-input pub-input" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

const words = (n: number) => `${number(n)} ${n === 1 ? 'word' : 'words'}`;

/** What an edit changes, in a line: the words added and taken out, and the other fields it sends */
export function changeSummary(before: string, after: string, fields: readonly string[]): string {
  const { inserted, deleted } = diffSummary(wordDiff(before, after));
  const text = inserted && deleted ? `${words(inserted)} added, ${words(deleted)} taken out` : inserted ? `${words(inserted)} added` : deleted ? `${words(deleted)} taken out` : before !== after ? 'Spacing and punctuation only' : '';
  const others = fields.filter((f) => f !== 'text');
  const also = others.length > 0 ? `${text ? '; ' : ''}${others.length === 1 ? 'a new' : 'new'} ${others.join(', ')}` : '';
  const line = `${text}${also}`;
  return line ? `${line.charAt(0).toUpperCase()}${line.slice(1)}.` : 'Nothing changed yet.';
}

export function PostEditSheet({
  row,
  prefill,
  onClose,
  onSave,
}: {
  row: PieceRow;
  prefill: { text: string; title: string };
  onClose: () => void;
  onSave: (changes: NonNullable<ReturnType<typeof singleEditChanges>>) => Promise<void>;
}) {
  const initial: EditForm = { text: prefill.text, title: prefill.title, tags: '', link: '', imageUrl: '', imageAlt: '' };
  const [form, setForm] = useState<EditForm>(initial);
  const [busy, setBusy] = useState(false);
  const textId = useId();
  const set = (key: keyof EditForm) => (value: string) => setForm((f) => ({ ...f, [key]: value }));
  const has = (f: (typeof row.edit.fields)[number]) => row.edit.fields.includes(f);
  const changes = singleEditChanges(row.channel, row.edit.fields, form, initial);
  const limit = channelDefinition(row.channel)?.text;
  const length = limit ? limit.length(form.text) : form.text.length;
  const over = limit !== undefined && length > limit.max;
  const name = pieceTitle(row);
  // The text is what an edit is mostly about; a network's other fields wait behind one tap
  const extra = (['title', 'tags', 'link', 'image'] as const).filter(has);
  const [more, setMore] = useState(false);
  return (
    <Sheet label={`Edit ${name}`} open onOpenChange={(open) => !open && !busy && onClose()}>
      <h2 className="k-d k-d30">Edit {name}</h2>
      <p className="k-sm k-muted pub-flush">
        {prefill.text ? 'Starts from the text as it went out.' : 'Shipcast keeps no copy of this piece: write the new text whole.'} The network gets the new version; a launch happens once, so nothing is posted again.
      </p>
      {has('text') && <DiffArea id={textId} label={`The text on ${name}`} base={prefill.text} value={form.text} onChange={set('text')} />}
      {has('text') && (
        <div className="k-hrow k-between k-xs k-muted">
          <span className={over ? 'pub-bad' : undefined}>{limit ? `${number(length)} of ${number(limit.max)} characters` : `${number(length)} characters`}</span>
          <span className="k-hrow k-g6">
            <span className="k-dot k-dot-pub" aria-hidden="true" /> {networkName(row.channel)} allows edits
          </span>
        </div>
      )}
      {extra.length > 0 && (
        <>
          <button type="button" className="pub-linkbtn k-sm pub-more" aria-expanded={more} onClick={() => setMore(!more)}>
            {more ? 'Hide' : 'Also change'} the {listWords([...extra])}
          </button>
          {more && (
            <div className="k-stack k-g12">
              {has('title') && <Field label="Title" value={form.title} onChange={set('title')} />}
              {has('tags') && <Field label="Tags (comma separated)" value={form.tags} onChange={set('tags')} />}
              {has('link') && <Field label="Link" value={form.link} onChange={set('link')} />}
              {has('image') && (
                <>
                  <Field label="Image address" value={form.imageUrl} onChange={set('imageUrl')} />
                  <Field label="What the image shows" value={form.imageAlt} onChange={set('imageAlt')} />
                </>
              )}
            </div>
          )}
        </>
      )}
      <div className="k-card pub-changes" aria-live="polite">
        <span className="k-lbl">What changes</span>
        <span className="k-sm">{changes ? changeSummary(prefill.text, form.text, Object.keys(changes)) : 'Nothing changed yet.'}</span>
      </div>
      <div className="k-hrow k-g10">
        <button type="button" className="k-btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="k-btn k-pri k-grow"
          disabled={!changes || busy || over}
          onClick={async () => {
            if (!changes) return;
            setBusy(true);
            try {
              await onSave(changes);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Saving…' : `Save on ${networkName(row.channel)}`}
        </button>
      </div>
    </Sheet>
  );
}

/** Several pieces at once: the same text, link or image to each, and what each network does with them */
export function EditManySheet({ rows, onClose, onApply }: { rows: PieceRow[]; onClose: () => void; onApply: (changes: SharedChanges) => Promise<void> }) {
  const [form, setForm] = useState({ text: '', link: '', imageUrl: '', imageAlt: '' });
  const [busy, setBusy] = useState(false);
  const textId = useId();
  const clean = (v: string) => (v.trim() === '' ? undefined : v);
  const changes: SharedChanges = {
    ...(clean(form.text) !== undefined && { text: form.text }),
    ...(clean(form.link) !== undefined && { link: form.link.trim() }),
    ...(clean(form.imageUrl) !== undefined && { imageUrl: form.imageUrl.trim(), ...(clean(form.imageAlt) !== undefined && { imageAlt: form.imageAlt.trim() }) }),
  };
  const plan = multiEditPlan(rows, changes);
  const doable = plan.filter((p) => p.ok).length;
  const set = (key: keyof typeof form) => (value: string) => setForm((f) => ({ ...f, [key]: value }));
  return (
    <Sheet label={`Edit ${rows.length} pieces`} open onOpenChange={(open) => !open && !busy && onClose()}>
      <h2 className="k-d k-d30">Edit {rows.length} pieces</h2>
      <p className="k-sm k-muted pub-flush">The same text, link or image goes to each; a network with no such field leaves it out. A launch happens once, so nothing is posted again.</p>
      <div className="k-field">
        <label className="k-lbl" htmlFor={textId}>
          Text <span className="k-xs">(on an article, the whole body)</span>
        </label>
        <textarea id={textId} className="k-input pub-textarea" value={form.text} onChange={(e) => set('text')(e.target.value)} />
      </div>
      <Field label="Link" value={form.link} onChange={set('link')} />
      <Field label="Image address" value={form.imageUrl} onChange={set('imageUrl')} />
      <Field label="What the image shows" value={form.imageAlt} onChange={set('imageAlt')} />
      <div className="k-card pub-changes" aria-live="polite">
        <span className="k-lbl">What changes</span>
        <ul className="pub-plan">
          {plan.map((p) => (
            <li key={p.id} className="k-sm">
              <strong>
                {networkName(p.channel)}
                {p.piece ? ` ${p.piece}` : ''}
              </strong>{' '}
              {p.ok ? (
                <span>
                  {p.changes.length > 0 ? p.changes.join(', ') : 'nothing yet'}
                  {p.dropped.length > 0 && <span className="k-muted"> · leaves out {p.dropped.join(', ')}</span>}
                  {p.warning && <span className="k-muted"> · {p.warning}</span>}
                </span>
              ) : (
                <span className="k-muted">left alone: {p.reason}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
      <div className="k-hrow k-g10">
        <button type="button" className="k-btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="k-btn k-pri k-grow"
          disabled={doable === 0 || Object.keys(changes).length === 0 || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onApply(changes);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Saving…' : `Save on ${doable} ${doable === 1 ? 'piece' : 'pieces'}`}
        </button>
      </div>
    </Sheet>
  );
}
