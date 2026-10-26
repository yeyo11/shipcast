import { useId, useState } from 'react';
import { composedText, multiEditPlan, networkName, singleEditChanges, type EditForm, type PieceRow, type SharedChanges } from '../../server/pieces';
import { Dialog, DialogClose } from '../ui/Dialog';

/*
 * The two edit dialogs of the launch page: one piece with every field its network takes, and
 * several pieces at once with the shared fields and, live, what each network does with them. The
 * rules are server/pieces.ts's (tested); the engine refuses again on the server.
 */

const FIELD_LABEL = { text: 'Text', title: 'Title', tags: 'Tags (comma separated)', link: 'Link', imageUrl: 'Image address', imageAlt: 'What the image shows' } as const;

function Field({ name, value, onChange, multiline, hint }: { name: keyof typeof FIELD_LABEL; value: string; onChange: (v: string) => void; multiline?: boolean; hint?: string }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{FIELD_LABEL[name]}</label>
      {multiline ? (
        <textarea id={id} className="textarea" value={value} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)} />
      )}
      {hint && <small>{hint}</small>}
    </div>
  );
}

export function EditPieceDialog({
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
  const set = (key: keyof EditForm) => (value: string) => setForm((f) => ({ ...f, [key]: value }));
  const has = (f: (typeof row.edit.fields)[number]) => row.edit.fields.includes(f);
  const changes = singleEditChanges(row.channel, row.edit.fields, form, initial);
  const shown = changes?.text !== undefined ? (composedText(row.channel, changes) ?? changes.text) : form.text;
  const name = row.piece ? `${networkName(row.channel)} ${row.piece}` : networkName(row.channel);
  return (
    <Dialog
      open
      wide
      onOpenChange={(open) => !open && !busy && onClose()}
      title={`Edit ${name}`}
      description={row.edit.reason}
      footer={
        <>
          <DialogClose>Cancel</DialogClose>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!changes || busy}
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
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="edit-grid">
        <div className="edit-form">
          {has('title') && <Field name="title" value={form.title} onChange={set('title')} />}
          {has('text') && (
            <Field
              name="text"
              multiline
              value={form.text}
              onChange={set('text')}
              hint={prefill.text ? 'Starts from the text as merged in the drafts’ pull request' : 'Shipcast keeps no copy of this piece: write the new text whole'}
            />
          )}
          {has('tags') && <Field name="tags" value={form.tags} onChange={set('tags')} />}
          {has('link') && <Field name="link" value={form.link} onChange={set('link')} />}
          {has('image') && (
            <>
              <Field name="imageUrl" value={form.imageUrl} onChange={set('imageUrl')} />
              <Field name="imageAlt" value={form.imageAlt} onChange={set('imageAlt')} />
            </>
          )}
        </div>
        <div className="edit-preview" aria-live="polite">
          <h3 className="ph-small">Preview</h3>
          <div className="preview">{shown || <span className="muted">Nothing to show yet</span>}</div>
          <p className="muted">{changes ? `Sends: ${Object.keys(changes).join(', ')}` : 'Nothing changed yet'}</p>
        </div>
      </div>
    </Dialog>
  );
}

export function EditManyDialog({ rows, onClose, onApply }: { rows: PieceRow[]; onClose: () => void; onApply: (changes: SharedChanges) => Promise<void> }) {
  const [form, setForm] = useState({ text: '', link: '', imageUrl: '', imageAlt: '' });
  const [busy, setBusy] = useState(false);
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
    <Dialog
      open
      wide
      onOpenChange={(open) => !open && !busy && onClose()}
      title={`Edit ${rows.length} pieces`}
      description="The same text, link or image goes to each piece; a network that has no such field leaves it out, and one that cannot be edited is left alone."
      footer={
        <>
          <DialogClose>Cancel</DialogClose>
          <button
            type="button"
            className="btn btn-primary"
            disabled={doable === 0 || busy}
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
        </>
      }
    >
      <div className="edit-grid">
        <div className="edit-form">
          <Field name="text" multiline value={form.text} onChange={set('text')} hint="On an article, this replaces the whole body" />
          <Field name="link" value={form.link} onChange={set('link')} />
          <Field name="imageUrl" value={form.imageUrl} onChange={set('imageUrl')} />
          <Field name="imageAlt" value={form.imageAlt} onChange={set('imageAlt')} />
        </div>
        <div className="edit-preview" aria-live="polite">
          <h3 className="ph-small">What changes</h3>
          <ul className="plan">
            {plan.map((p) => (
              <li key={p.id} data-ok={p.ok}>
                <strong>
                  {networkName(p.channel)}
                  {p.piece ? ` ${p.piece}` : ''}
                </strong>
                {p.ok ? (
                  <span>
                    {p.changes.join(', ')}
                    {p.dropped.length > 0 && <span className="muted"> · leaves out {p.dropped.join(', ')}</span>}
                    {p.warning && <span className="muted"> · {p.warning}</span>}
                  </span>
                ) : (
                  <span className="muted">Left alone: {p.reason}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Dialog>
  );
}
