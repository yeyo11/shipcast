import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { JobsPanel } from '../../../components/Jobs';
import { Automation as SortingMachine } from '../../../components/illustrations';
import { PageToolbar, ToolbarAction } from '../../../components/PageToolbar';
import { SectionHead } from '../../../components/SectionHead';
import { CheckIcon, RefreshIcon } from '../../../components/ui/icons';
import { useToast } from '../../../components/Toasts';
import { Pill, when } from '../../../components/ui';
import { ConfirmButton } from '../../../components/ui/ConfirmButton';
import { getAutomation, rotateWebhookSecret, runRoundNow, saveAutomation } from '../../../server/automation.functions';

export const Route = createFileRoute('/_app/settings/automation')({
  head: () => ({ meta: [{ title: 'Automation · Shipcast' }] }),
  loader: () => getAutomation(),
  component: Automation,
});

type Mode = 'poll' | 'webhook' | 'off';

const MODES: Array<{ id: Mode; label: string; text: string }> = [
  { id: 'poll', label: 'Rounds', text: 'Shipcast checks your GitHub account on a timer: new releases are drafted, merged drafts published.' },
  { id: 'webhook', label: 'GitHub webhooks', text: 'GitHub tells Shipcast the moment a release is published or drafts are merged. The app must be reachable from GitHub.' },
  { id: 'off', label: 'Off', text: 'Nothing happens on its own: you launch, approve and publish from the app or the command line.' },
];

function Copyable({ label, value }: { label: string; value: string }) {
  const toast = useToast();
  return (
    <div className="field">
      <span className="label">{label}</span>
      <div className="row">
        <code className="input mono copyable">
          {value}
        </code>
        <button
          className="btn btn-small"
          type="button"
          onClick={() => void navigator.clipboard.writeText(value).then(() => toast.done(`${label} copied`))}
        >
          Copy
        </button>
      </div>
    </div>
  );
}

function Automation() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>(data.mode);
  const [interval, setIntervalText] = useState(String(data.intervalSeconds));
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // While a round runs, the page follows it
  const working = data.running || data.jobs.counts.running > 0;
  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => void router.invalidate(), 4000);
    return () => window.clearInterval(timer);
  }, [working, router]);

  const save = async () => {
    setBusy(true);
    try {
      const saved = await saveAutomation({ data: { mode, intervalSeconds: Number(interval) } });
      setIntervalText(String(saved.intervalSeconds));
      toast.done('Automation saved', saved.mode === 'off' ? 'Nothing runs on its own.' : `A round every ${saved.intervalSeconds} seconds.`);
      await router.invalidate();
    } catch (error) {
      toast.fail(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const newSecret = async () => {
    const answer = await rotateWebhookSecret();
    setSecret(answer.secret);
    toast.show({ tone: 'wait', title: 'Copy the secret now', text: 'It is shown only this once. Paste it into each webhook on GitHub.' });
    await router.invalidate();
  };

  return (
    <>
      <SectionHead title="Automation" art={<SortingMachine width={180} />}>
        How Shipcast hears about your releases and merges without you starting anything.
      </SectionHead>
      <PageToolbar
        label="Automation"
        actions={
          <>
            <ToolbarAction
              label={data.running ? 'A round is running…' : 'Run a round now'}
              icon={<RefreshIcon />}
              disabled={data.running}
              onClick={async () => {
                const answer = await runRoundNow();
                if (answer.started) toast.done('A round has started', 'It checks for releases, publishes what is ready and reads the numbers when due.');
                else toast.show({ tone: 'wait', title: 'A round is already running' });
                await router.invalidate();
              }}
            />
            <ToolbarAction primary type="submit" form="automation-form" label="Save automation" busyLabel={busy && 'Saving…'} icon={<CheckIcon />} disabled={busy} />
          </>
        }
      />

      <form
        id="automation-form"
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label">Mode</legend>
          <div className="seg">
            {MODES.map((m) => (
              <label key={m.id}>
                <input type="radio" name="mode" checked={mode === m.id} onChange={() => setMode(m.id)} />
                <span>{m.label}</span>
              </label>
            ))}
          </div>
          <small>{MODES.find((m) => m.id === mode)?.text}</small>
        </fieldset>
        {mode !== 'off' && (
          <div className="field">
            <label htmlFor="interval">{mode === 'poll' ? 'Seconds between rounds' : 'Seconds between maintenance rounds'}</label>
            <input id="interval" className="input mono" type="number" min={60} step={30} value={interval} onChange={(e) => setIntervalText(e.target.value)} style={{ maxWidth: 200 }} />
            <small>
              {mode === 'poll'
                ? 'At least 60, as GitHub asks of anyone polling its events.'
                : 'Webhooks bring releases and merges; these rounds still publish what is ready, refresh tokens and read the numbers every six hours.'}
            </small>
          </div>
        )}
      </form>

      {mode === 'webhook' && (
        <>
          <h2 className="ph">GitHub webhooks</h2>
          <div className="grid-2">
            <div className="form">
              <Copyable label="Payload URL" value={data.webhookUrl} />
              <Copyable label="Content type" value="application/json" />
              <div className="field">
                <span className="label">Secret</span>
                {secret ? (
                  <Copyable label="New secret" value={secret} />
                ) : (
                  <small>{data.hasSecret ? 'A secret is set; it is kept in the keychain and never shown again.' : 'No secret yet: generate one, then paste it into each webhook on GitHub.'}</small>
                )}
                <div className="row">
                  {data.hasSecret ? (
                    <ConfirmButton
                      className="btn btn-small"
                      title="Rotate the webhook secret?"
                      description="A new secret replaces the current one at once: every webhook on GitHub stops being trusted until it is given the new one."
                      confirm="Rotate the secret"
                      tone="primary"
                      onConfirm={newSecret}
                    >
                      Rotate the secret
                    </ConfirmButton>
                  ) : (
                    <button className="btn btn-small" type="button" onClick={() => void newSecret()}>
                      Generate a secret
                    </button>
                  )}
                </div>
              </div>
            </div>
            <aside className="card">
              <h3 className="ph">On GitHub</h3>
              {data.appWebhooks && (
                <p>
                  The GitHub App delivers releases, repositories and pull requests for every repo it is installed on, signed with its own secret: nothing to set per repo.
                  A webhook set by hand as below keeps working too.
                </p>
              )}
              <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.6 }}>
                <li>
                  In each repo you launch (on {data.owner}’s account, webhooks are set per repo): Settings → Webhooks → Add webhook.
                </li>
                <li>Paste the payload URL, choose application/json and paste the secret.</li>
                <li>
                  Choose <strong>Let me select individual events</strong>: <strong>Releases</strong>, and <strong>Repositories</strong> if a repo going public should launch it.
                </li>
                <li>
                  On <code>{data.launchesRepo}</code>, the same webhook with <strong>Pull requests</strong>, so a merge of drafts publishes them.
                </li>
              </ol>
              <p className="muted">GitHub sends a ping when the webhook is added; it shows below.</p>
            </aside>
          </div>
        </>
      )}

      {data.jobs.counts.all > 0 && (
        <>
          <h2 className="ph">Work in progress</h2>
          <JobsPanel initial={data.jobs} />
        </>
      )}

      <h2 className="ph">What happened</h2>
      <div className="cards">
        <article className="card">
          <header>
            <h3 className="ph">Last round</h3>
            {data.running ? <Pill tone="draft">Running</Pill> : data.lastRound ? <Pill tone="published">Done</Pill> : <Pill tone="manual">None yet</Pill>}
          </header>
          {data.lastRound ? (
            <>
              <p className="muted">
                {when(data.lastRound.at)} · {data.lastRound.summary}
              </p>
              {data.lastRound.lines.length > 0 && <div className="log">{data.lastRound.lines.join('\n')}</div>}
            </>
          ) : (
            <p className="muted">The app runs its first round shortly after it starts.</p>
          )}
        </article>
        <article className="card">
          <header>
            <h3 className="ph">Last delivery</h3>
            {data.lastDelivery ? <Pill tone="published">Received</Pill> : <Pill tone="manual">None yet</Pill>}
          </header>
          <p className="muted">{data.lastDelivery ? `${when(data.lastDelivery.at)} · ${data.lastDelivery.summary}` : 'No webhook delivery has reached Shipcast.'}</p>
        </article>
      </div>
    </>
  );
}
