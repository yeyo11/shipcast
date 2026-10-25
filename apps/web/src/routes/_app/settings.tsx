import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { PageHead } from '../../components/PageHead';
import { useToast } from '../../components/Toasts';
import { Notice, Pill, when } from '../../components/ui';
import { ConfirmButton } from '../../components/ui/ConfirmButton';
import { getSettings, saveSettings } from '../../server/settings.functions';

export const Route = createFileRoute('/_app/settings')({
  head: () => ({ meta: [{ title: 'Settings · Shipcast' }] }),
  loader: () => getSettings(),
  component: Settings,
});

const SOURCE: Record<string, string> = {
  settings: 'saved here',
  keychain: 'saved in the keychain',
  '.env': 'from .env, until it is saved here',
  unset: 'not set',
};

function Settings() {
  const data = Route.useLoaderData();
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
  const { github } = data;

  return (
    <>
      <PageHead title="Settings">
        What Shipcast needs besides <code>.env</code>, which holds only what it needs before anyone signs in. Public values are kept in the database, secrets in{' '}
        {data.secretsKind}. A change applies to what runs next, without a restart.
      </PageHead>

      {data.missing.length > 0 && <Notice tone="wait">Still to set: {data.missing.join(', ')}. Launching and drafting wait for them.</Notice>}

      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void save(changed);
        }}
      >
        {data.settings.map((s) => (
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
        <div className="row">
          <button className="btn btn-primary" type="submit" disabled={busy || Object.keys(changed).length === 0}>
            {busy ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </form>

      <h2 className="ph">GitHub</h2>
      <table className="table">
        <tbody>
          <tr>
            <th scope="row">The engine</th>
            <td>
              {github.access.kind === 'app' ? (
                <>
                  Through the GitHub App{github.access.slug ? <> <code>{github.access.slug}</code></> : null}; its commits and pull requests are by{' '}
                  <code>{github.access.bot ?? 'the App’s bot'}</code>
                </>
              ) : (
                <>Through GITHUB_TOKEN_PERSONAL in .env: set the GitHub App in .env to replace it</>
              )}
            </td>
          </tr>
          {github.access.kind === 'app' && (
            <tr>
              <th scope="row">Installation</th>
              <td>
                {github.installation ? (
                  <>
                    On <strong>{github.installation.account}</strong>, {github.installation.repositories} <span className="muted">({github.installation.permissions})</span>
                  </>
                ) : (
                  <Pill tone="failed">{github.installationProblem ?? 'not found'}</Pill>
                )}
              </td>
            </tr>
          )}
          <tr>
            <th scope="row">Sign-in</th>
            <td>{github.signIn === 'app' ? 'Through the GitHub App' : 'Through the GitHub OAuth App (SHIPCAST_GITHUB_CLIENT_ID); the GitHub App replaces it'}</td>
          </tr>
          {github.access.kind === 'app' && (
            <tr>
              <th scope="row">Your user token</th>
              <td>
                {github.user ? (
                  <>
                    @{github.user.login}
                    {github.user.expiresAt ? `, valid until ${when(github.user.expiresAt)} UTC and refreshed on its own` : ', without expiry'}
                    {github.user.refreshExpiresAt ? ` (until ${when(github.user.refreshExpiresAt)} UTC, then sign in again)` : ''}
                  </>
                ) : (
                  <span className="muted">None yet: it is kept when you sign in with GitHub</span>
                )}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
