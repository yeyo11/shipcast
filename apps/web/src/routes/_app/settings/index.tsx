import { createFileRoute, Link } from '@tanstack/react-router';
import { AI_SETTING_NAMES, SettingsForm } from '../../../components/SettingsForm';
import { when } from '../../../components/ui';
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
  const left = remaining(data.onboarding).map((s) => STEP_TITLES[s]);

  return (
    <div className="st-content">
      <p className="st-lead">
        What Shipcast needs besides <span className="k-mono k-xs">.env</span>. Public values live in the database, secrets in {data.secretsKind}. A change
        applies to what runs next, without a restart.
      </p>
      <div className="st-cards">
        {/* Where a skipped or unfinished onboarding is resumed; with every step done, a quiet way back into it */}
        <section className="k-card st-rowcard" aria-label="Setting up">
          <span className="k-grow">
            <strong>{left.length > 0 ? 'Finish setting up' : 'Set up'}</strong>
            <br />
            <span className="k-sm k-muted">{left.length > 0 ? `Still to do: ${left.join(', ')}.` : 'Every step is done. Open it again to review one.'}</span>
          </span>
          <Link className={`k-btn k-sm${left.length > 0 ? ' k-pri' : ''}`} to="/onboarding">
            {left.length > 0 ? 'Finish' : 'Open'}
          </Link>
        </section>

        <section className="k-card st-g14" aria-labelledby="st-needs">
          <SettingsForm
            bar
            missing={data.missing}
            settings={data.settings.filter((s) => !AI_SETTING_NAMES.has(s.name))}
            heading={
              <h2 id="st-needs" className="k-d k-d30">
                What it needs
              </h2>
            }
          />
        </section>

        <section className="k-card st-g4" aria-labelledby="st-github">
          <h2 id="st-github" className="k-d k-d30 st-mb6">
            GitHub
          </h2>
          <dl className="k-kv st-kv">
            <dt>The engine</dt>
            <dd>
              {github.access.kind === 'app' ? (
                <>
                  Through the GitHub App{github.access.slug ? <> <span className="k-mono k-xs">{github.access.slug}</span></> : null}
                </>
              ) : (
                <>
                  Through <span className="k-mono k-xs">GITHUB_TOKEN_PERSONAL</span> in .env; the GitHub App replaces it
                </>
              )}
            </dd>
            {github.access.kind === 'app' && (
              <>
                <dt>Installation</dt>
                <dd>
                  {github.installation ? (
                    <>
                      On <strong>{github.installation.account}</strong>, {github.installation.repositories}
                    </>
                  ) : (
                    <span className="st-bad">{github.installationProblem ?? 'Not found'}</span>
                  )}
                </dd>
              </>
            )}
            <dt>Sign-in</dt>
            <dd>{github.signIn === 'app' ? 'Through the GitHub App' : 'Through the GitHub OAuth App; the GitHub App replaces it'}</dd>
            {github.access.kind === 'app' && (
              <>
                <dt>Your token</dt>
                <dd>
                  {github.user ? (
                    <>
                      @{github.user.login}, {github.user.expiresAt ? 'refreshed on its own' : 'without expiry'}
                      {github.user.refreshExpiresAt ? <span className="k-muted"> (sign in again after {when(github.user.refreshExpiresAt)} UTC)</span> : null}
                    </>
                  ) : (
                    <span className="k-muted">None yet: kept when you sign in with GitHub</span>
                  )}
                </dd>
              </>
            )}
          </dl>
        </section>
      </div>
    </div>
  );
}
