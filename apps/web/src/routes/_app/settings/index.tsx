import { createFileRoute, Link } from '@tanstack/react-router';
import { SectionHead } from '../../../components/SectionHead';
import { AI_SETTING_NAMES, SettingsForm } from '../../../components/SettingsForm';
import { Notice, Pill, when } from '../../../components/ui';
import { getOnboardingState } from '../../../server/onboarding.functions';
import { remaining, STEP_TITLES } from '../../../server/onboarding';
import { getSettings } from '../../../server/settings.functions';

export const Route = createFileRoute('/_app/settings/')({
  head: () => ({ meta: [{ title: 'Settings · Shipcast' }] }),
  loader: async () => {
    const [settings, onboarding] = await Promise.all([getSettings(), getOnboardingState()]);
    return { ...settings, onboarding };
  },
  component: Settings,
});

function Settings() {
  const data = Route.useLoaderData();
  const { github } = data;

  return (
    <>
      <SectionHead title="General">
        What Shipcast needs besides <code>.env</code>, which holds only what it needs before anyone signs in. Public values are kept in the database, secrets in{' '}
        {data.secretsKind}. A change applies to what runs next, without a restart. The AI is configured in <Link to="/settings/ai">AI</Link>.
      </SectionHead>

      <FinishSettingUp left={remaining(data.onboarding).map((s) => STEP_TITLES[s])} />

      {data.missing.length > 0 && <Notice tone="wait">Still to set: {data.missing.join(', ')}. Launching and drafting wait for them.</Notice>}

      <SettingsForm toolbar settings={data.settings.filter((s) => !AI_SETTING_NAMES.has(s.name))} />

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

/** Where a skipped or unfinished onboarding is resumed; with every step done, a quiet way back into it */
function FinishSettingUp({ left }: { left: string[] }) {
  return (
    <section className="card setup-card" aria-label="Setting up">
      <div>
        <h2 className="setup-title">{left.length > 0 ? 'Finish setting up' : 'Set up'}</h2>
        <p className="muted">{left.length > 0 ? `Still to do: ${left.join(', ')}.` : 'Every step of the setup is done. Open it again to review a step.'}</p>
      </div>
      <Link className={`btn${left.length > 0 ? ' btn-primary' : ''}`} to="/onboarding">
        {left.length > 0 ? 'Finish setting up' : 'Open the setup'}
      </Link>
    </section>
  );
}
