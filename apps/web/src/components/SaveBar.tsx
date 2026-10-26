import { useBlocker } from '@tanstack/react-router';
import { ConfirmDialog } from './ui/ConfirmButton';

/*
 * Settings' contextual save bar (Shopify's pattern, docs/web-app.md): it appears at the bottom of the
 * window only while a form has changes, says so in words, and holds the form's two answers, Discard
 * and its own Save. On a phone it sits over the bottom navigation, where a thumb reaches it, instead of
 * a glyph in the page's toolbar that said nothing. Leaving the page with changes asks first.
 */
export function SaveBar({
  form,
  dirty,
  busy,
  save,
  onDiscard,
  disabled = false,
}: {
  /** The id of the form the Save submits */
  form: string;
  dirty: boolean;
  busy: boolean;
  /** The form's own verb, as its toast will say it: "Save automation" */
  save: string;
  onDiscard: () => void;
  /** Changes that cannot be saved yet (a required field left empty) */
  disabled?: boolean;
}) {
  const blocker = useBlocker({ shouldBlockFn: () => dirty && !busy, enableBeforeUnload: () => dirty, withResolver: true });
  return (
    <>
      {dirty && (
        <div className="save-bar" role="region" aria-label="Unsaved changes">
          <p className="save-bar-text">
            <span className="save-bar-dot" aria-hidden="true" />
            Unsaved changes
          </p>
          <div className="save-bar-actions">
            <button type="button" className="btn btn-small" disabled={busy} onClick={onDiscard}>
              Discard
            </button>
            <button type="submit" form={form} className="btn btn-small btn-primary" disabled={busy || disabled}>
              {busy ? 'Saving…' : save}
            </button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={blocker.status === 'blocked'}
        onOpenChange={(open) => {
          if (!open && blocker.status === 'blocked') blocker.reset();
        }}
        title="Leave without saving?"
        description="The changes on this page have not been saved. Leaving drops them."
        confirm="Leave without saving"
        onConfirm={() => blocker.proceed?.()}
      />
    </>
  );
}
