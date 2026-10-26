import { useRouter } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { saveSettings } from '../server/settings.functions';
import { useToast } from './Toasts';
import { PageToolbar, ToolbarAction } from './PageToolbar';
import { ConfirmButton } from './ui/ConfirmButton';
import { CheckIcon } from './ui/icons';

export interface SettingView {
  name: string;
  label: string;
  env: string;
  secret: boolean;
  value: string | null;
  set: boolean;
  source: string;
}

/** The AI's settings (claudio's address and token, the budget) live in Settings › AI only, so nothing is configured twice */
export const AI_SETTING_NAMES: ReadonlySet<string> = new Set(['claudioUrl', 'claudioToken', 'maxBudgetUsd']);

const SOURCE: Record<string, string> = {
  settings: 'saved here',
  keychain: 'saved in the keychain',
  '.env': 'from .env, until it is saved here',
  unset: 'not set',
};

/**
 * A group of the runtime settings as one form. General and AI each show their own group, so a
 * setting is configured in exactly one place. With `toolbar`, its Save is the page toolbar's action.
 */
export function SettingsForm({ settings, submit = 'Save settings', toolbar = false }: { settings: SettingView[]; submit?: string; toolbar?: boolean }) {
  const formId = useId();
  const router = useRouter();
  const toast = useToast();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const save = async (change: Record<string, string | null>) => {
    setBusy(true);
    try {
      const answer = await saveSettings({ data: change });
      setEdits({});
      toast.done('Settings saved', answer.missing.length ? `Still to set: ${answer.missing.join(', ')}.` : 'They apply to what runs next.');
      await router.invalidate();
    } catch (error) {
      toast.fail(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const changed = Object.fromEntries(Object.entries(edits).filter(([, v]) => v.trim() !== ''));

  return (
    <form
      id={formId}
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        void save(changed);
      }}
    >
      {settings.map((s) => (
        <div className="field" key={s.name}>
          <label htmlFor={`setting-${s.name}`}>{s.label}</label>
          <div className="row">
            <input
              id={`setting-${s.name}`}
              className="input"
              style={{ flex: '1 1 220px', minWidth: 0 }}
              type={s.secret ? 'password' : 'text'}
              autoComplete="off"
              placeholder={s.secret ? (s.set ? 'Set; type a new one to replace it' : 'Not set') : (s.value ?? 'Not set')}
              value={edits[s.name] ?? ''}
              onChange={(e) => setEdits({ ...edits, [s.name]: e.target.value })}
            />
            {s.source === 'settings' || s.source === 'keychain' ? (
              <ConfirmButton
                className="btn btn-small"
                disabled={busy}
                title={`Clear ${s.label.toLowerCase()}?`}
                description={s.secret ? 'The secret is deleted from the keychain; what needs it waits until a new one is set.' : `It is now ${s.value ?? 'empty'}; clearing it falls back to .env, if .env has it.`}
                confirm="Clear"
                onConfirm={() => save({ [s.name]: null })}
              >
                Clear
              </ConfirmButton>
            ) : null}
          </div>
          <small>
            {SOURCE[s.source]}
            {s.value && !s.secret ? <> · now <code>{s.value}</code></> : null} · was <code>{s.env}</code> in .env
          </small>
        </div>
      ))}
      {/* The page's own form saves from its toolbar; a form among others keeps its button under it */}
      {toolbar ? (
        <PageToolbar
          label="Settings"
          actions={<ToolbarAction primary type="submit" form={formId} label={submit} busyLabel={busy && 'Saving…'} icon={<CheckIcon />} disabled={busy || Object.keys(changed).length === 0} />}
        />
      ) : (
        <div className="row">
          <button className="btn btn-primary" type="submit" disabled={busy || Object.keys(changed).length === 0}>
            {busy ? 'Saving…' : submit}
          </button>
        </div>
      )}
    </form>
  );
}
