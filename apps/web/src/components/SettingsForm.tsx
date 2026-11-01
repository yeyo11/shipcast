import { useRouter } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { saveSettings } from '../server/settings.functions';
import { SaveBar } from './SaveBar';
import { changesText, settingHelp } from './settings/view';
import { useToast } from './Toasts';

export interface SettingView {
  name: string;
  label: string;
  env: string;
  secret: boolean;
  value: string | null;
  set: boolean;
  source: string;
}

/** The AI's settings (claudio's address and token) live in Settings › AI only, so nothing is configured twice */
export const AI_SETTING_NAMES: ReadonlySet<string> = new Set(['claudioUrl', 'claudioToken']);

/** A secret marked to be cleared on save (its field shows that instead of a value) */
const CLEAR = '\u0000clear';

/** What each field starts from: a public value as it is, a secret never (it is not sent to the page) */
const initialOf = (s: SettingView) => (s.secret ? '' : (s.value ?? ''));

/**
 * The runtime settings as one form (board SettingsGeneral's "What it needs"): a public value is
 * edited in place, a secret that is kept shows as kept with a way to replace it. With `bar` the
 * form saves from the page's save bar; otherwise it carries its own Save under the fields.
 */
export function SettingsForm({ settings, missing = [], bar = false, heading, onSaved }: { settings: SettingView[]; missing?: readonly string[]; bar?: boolean; heading?: ReactNode; onSaved?: () => void }) {
  const formId = useId();
  const router = useRouter();
  const toast = useToast();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [replacing, setReplacing] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const focusNext = useRef<string | null>(null);

  // A field Replace opened takes the focus once it is drawn
  useEffect(() => {
    if (!focusNext.current) return;
    document.getElementById(`setting-${focusNext.current}`)?.focus();
    focusNext.current = null;
  });

  const changed: Record<string, string | null> = {};
  for (const s of settings) {
    const draft = edits[s.name];
    if (draft === undefined) continue;
    if (draft === CLEAR) changed[s.name] = null;
    else if (s.secret) {
      if (draft.trim() !== '') changed[s.name] = draft.trim();
    } else if (draft.trim() !== initialOf(s)) {
      // An emptied value that was saved here falls back to .env; one that never was is left alone
      if (draft.trim() !== '') changed[s.name] = draft.trim();
      else if (s.source === 'settings') changed[s.name] = null;
    }
  }
  const count = Object.keys(changed).length;

  const reset = () => {
    setEdits({});
    setReplacing({});
  };

  const save = async () => {
    setBusy(true);
    try {
      const answer = await saveSettings({ data: changed });
      reset();
      toast.done('Settings saved', answer.missing.length ? `Still to set: ${answer.missing.join(', ')}.` : 'They apply to what runs next.');
      await router.invalidate();
      onSaved?.();
    } catch (error) {
      toast.fail(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      id={formId}
      className="st-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (count > 0) void save();
      }}
    >
      {heading}
      {settings.map((s) => {
        const id = `setting-${s.name}`;
        const draft = edits[s.name];
        const help = settingHelp(s);
        const kept = s.secret && s.set && !replacing[s.name];
        const bad = missing.includes(s.label) && !(draft ?? initialOf(s)).trim();
        return (
          <div className="k-field" key={s.name}>
            <label className="k-lbl" htmlFor={kept ? undefined : id}>
              {s.label}
            </label>
            {kept ? (
              <div className="k-input k-between st-kept">
                <span className="k-mono st-mono">••••••••••••</span>
                <span className="k-xs k-muted">
                  {s.source === '.env' ? 'from .env' : 'kept'} ·{' '}
                  <button
                    type="button"
                    className="st-link"
                    aria-label={`Replace ${s.label.toLowerCase()}`}
                    onClick={() => {
                      focusNext.current = s.name;
                      setReplacing({ ...replacing, [s.name]: true });
                    }}
                  >
                    Replace
                  </button>
                </span>
              </div>
            ) : draft === CLEAR ? (
              <div className="k-input k-between st-kept">
                <span className="k-sm k-muted">Cleared when you save</span>
                <button type="button" className="st-link k-xs" onClick={() => setEdits({ ...edits, [s.name]: '' })}>
                  Keep it
                </button>
              </div>
            ) : (
              <input
                id={id}
                className={`k-input st-input${bad ? ' k-bad' : ''}`}
                type={s.secret ? 'password' : 'text'}
                autoComplete="off"
                spellCheck={false}
                placeholder={s.secret && s.set ? 'Type the new one' : 'Not set: tap to type it'}
                value={draft ?? initialOf(s)}
                onChange={(e) => setEdits({ ...edits, [s.name]: e.target.value })}
              />
            )}
            {s.secret && replacing[s.name] && draft !== CLEAR && (s.source === 'keychain' || s.source === 'settings') ? (
              <span className="k-help">
                Empty keeps the one kept, or{' '}
                <button type="button" className="st-link" onClick={() => setEdits({ ...edits, [s.name]: CLEAR })}>
                  clear it
                </button>
                .
              </span>
            ) : help ? (
              <span className="k-help">{help}</span>
            ) : null}
          </div>
        );
      })}
      {bar ? (
        <SaveBar form={formId} dirty={count > 0} busy={busy} text={changesText(count)} onUndo={reset} />
      ) : (
        <button className="k-btn k-pri st-start" type="submit" disabled={busy || count === 0}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      )}
    </form>
  );
}
