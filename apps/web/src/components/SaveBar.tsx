import { useBlocker } from '@tanstack/react-router';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ConfirmSheet } from './settings/sheets';

/*
 * Settings' contextual save bar (boards SettingsGeneral, SettingsAutomation, DesktopSettings): it
 * appears only while a form has changes, says so in words, and holds Undo and the form's Save. On a
 * phone it sits right above the bottom bar, where a thumb reaches it; on a desktop it sticks to the
 * bottom of the page column. Leaving the page with changes asks first.
 */

const Slot = createContext<HTMLElement | null>(null);

/** Where the page's save bar is drawn: after the Settings column, so on a desktop it spans the whole page */
export function SaveBarSlot({ children }: { children: (ref: (el: HTMLElement | null) => void) => ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  return <Slot.Provider value={el}>{children(setEl)}</Slot.Provider>;
}

export function SaveBar({
  form,
  dirty,
  busy,
  text,
  onUndo,
  disabled = false,
}: {
  /** The id of the form the Save submits */
  form: string;
  dirty: boolean;
  busy: boolean;
  /** What changed, in words: "1 change not saved", "Rules changed" */
  text: string;
  /** Without it the bar has only Save (board SettingsAutomation) */
  onUndo?: () => void;
  /** Changes that cannot be saved yet (a required field left empty) */
  disabled?: boolean;
}) {
  const slot = useContext(Slot);
  const blocker = useBlocker({ shouldBlockFn: () => dirty && !busy, enableBeforeUnload: () => dirty, withResolver: true });
  const bar = dirty ? (
    <div className="k-bar st-savebar" role="region" aria-label="Unsaved changes">
      <span className="k-sm k-grow">
        <strong>{text}</strong>
      </span>
      {onUndo && (
        <button type="button" className="k-btn k-sm k-ghost" disabled={busy} onClick={onUndo}>
          Undo
        </button>
      )}
      <button type="submit" form={form} className="k-btn k-pri" disabled={busy || disabled}>
        {busy ? 'Saving…' : 'Save'}
      </button>
    </div>
  ) : null;
  return (
    <>
      {bar && (slot ? createPortal(bar, slot) : bar)}
      <ConfirmSheet
        open={blocker.status === 'blocked'}
        onOpenChange={(open) => {
          if (!open && blocker.status === 'blocked') blocker.reset?.();
        }}
        title="Leave without saving?"
        keep="Keep editing"
        confirm="Leave"
        danger
        onConfirm={() => blocker.proceed?.()}
      >
        The changes on this page have not been saved. Leaving drops them.
      </ConfirmSheet>
    </>
  );
}
