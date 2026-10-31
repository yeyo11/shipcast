import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { TopBar } from '../../components/kit/Bars';
import { Icon } from '../../components/kit/Icon';
import { SaveBar } from '../../components/SaveBar';
import { ConfirmSheet, OnceSheet } from '../../components/settings/sheets';
import { ago, changesText, everyText } from '../../components/settings/view';
import { useToast } from '../../components/Toasts';
import { getAutomation, rotateWebhookSecret, saveAutomation } from '../../server/automation.functions';

export const Route = createFileRoute('/_app/settings_/automation/webhooks')({
  head: () => ({ meta: [{ title: 'Webhooks · Shipcast' }] }),
  loader: () => getAutomation(),
  component: Webhooks,
});

type Mode = 'poll' | 'webhook' | 'off';

const MODES: Array<{ id: Mode; label: string; text: string }> = [
  { id: 'webhook', label: 'Webhooks', text: 'GitHub tells Shipcast the moment a release is published or drafts are merged. The app must be reachable from GitHub.' },
  { id: 'poll', label: 'Rounds', text: 'Shipcast checks your GitHub account on a timer: new releases are drafted, merged drafts published.' },
  { id: 'off', label: 'Off', text: 'Nothing happens on its own: you launch, approve and publish from the app or the command line.' },
];

/** A value to paste into GitHub, in the kit's input with a copy button (board Webhooks) */
function Copyable({ label, value, copy = true }: { label: string; value: string; copy?: boolean }) {
  const toast = useToast();
  return (
    <div className="k-field">
      <span className="k-lbl">{label}</span>
      <span className="k-input st-mono-input">
        <span className="k-grow k-ellipsis">{value}</span>
        {copy && (
        <button type="button" className="st-copy" aria-label={`Copy the ${label.toLowerCase()}`} onClick={() => void navigator.clipboard.writeText(value).then(() => toast.done(`${label} copied`))}>
          <Icon name="copy" size={18} />
        </button>
        )}
      </span>
    </div>
  );
}

function Webhooks() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>(data.mode);
  const [interval, setIntervalText] = useState(String(data.intervalSeconds));
  const [rotating, setRotating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // What was saved comes back from the server: the form starts again from it, so the save bar closes
  useEffect(() => {
    setMode(data.mode);
    setIntervalText(String(data.intervalSeconds));
  }, [data.mode, data.intervalSeconds]);

  const count = (mode !== data.mode ? 1 : 0) + (interval !== String(data.intervalSeconds) ? 1 : 0);

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
    await router.invalidate();
  };

  return (
    <div className="st-sub">
      <TopBar back={{ label: 'Automation', to: '/settings/automation' }} />
      <form
        id="listening-form"
        className="st-subbody st-g14"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Link to="/settings/automation" className="k-desktop st-backlink">
          <Icon name="chevronLeft" size={18} />
          Automation
        </Link>
        <h1 className="k-d st-subtitle">Webhooks</h1>
        <p className="k-sm k-muted st-m0">With webhooks GitHub tells Shipcast at once; without them, it polls every {everyText(data.intervalSeconds)}.</p>
        <Copyable label="Payload URL" value={data.webhookUrl} />
        <Copyable label="Content type" value="application/json" copy={false} />
        <div className="k-field">
          <span className="k-lbl">Secret</span>
          <span className="k-input st-kept">
            {data.hasSecret ? <span className="k-mono st-mono">•••••••••••• kept</span> : <span className="k-sm k-muted">Not set yet</span>}
            {data.hasSecret ? (
              <button type="button" className="st-link k-xs" onClick={() => setRotating(true)}>
                Rotate
              </button>
            ) : (
              <button type="button" className="st-link k-xs" onClick={() => void newSecret()}>
                Generate
              </button>
            )}
          </span>
        </div>
        <section className="k-card st-g8" aria-label="On GitHub">
          <span className="k-lbl">On GitHub</span>
          {data.appWebhooks && <p className="k-sm st-m0">The GitHub App already delivers for every repo it is installed on, signed with its own secret. A webhook set by hand keeps working too.</p>}
          <ol className="k-sm st-steps">
            <li>Paste the payload URL, choose application/json and paste the secret.</li>
            <li>
              Pick “Let me select individual events”: Releases, Repositories, and Pull requests on <span className="k-mono k-xs">{data.launchesRepo}</span>.
            </li>
            <li>GitHub sends a ping when the webhook is added; it shows below.</li>
          </ol>
        </section>
        <section className="k-card st-g0" aria-label="Last deliveries">
          <span className="k-lbl st-mb4">Last delivery</span>
          {data.lastDelivery ? (
            <div className="k-row k-sm">
              <span className="k-grow">{data.lastDelivery.summary}</span>
              <span className="k-xs k-muted">{ago(data.lastDelivery.at)}</span>
              <span className="k-dot k-dot-pub" aria-hidden="true" />
            </div>
          ) : (
            <div className="k-row k-sm">
              <span className="k-grow k-muted">No delivery has reached Shipcast yet.</span>
              <span className="k-dot k-dot-quiet" aria-hidden="true" />
            </div>
          )}
        </section>
        <section className="k-card st-g12" aria-labelledby="st-listening">
          <span id="st-listening" className="k-lbl">
            How Shipcast hears about releases
          </span>
          <div className="k-seg" role="radiogroup" aria-labelledby="st-listening">
            {MODES.map((m) => (
              <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} className={mode === m.id ? 'k-on' : undefined} onClick={() => setMode(m.id)}>
                {m.label}
              </button>
            ))}
          </div>
          <span className="k-help">{MODES.find((m) => m.id === mode)?.text}</span>
          {mode !== 'off' && (
            <label className="k-field">
              <span className="k-lbl">{mode === 'poll' ? 'Seconds between rounds' : 'Seconds between maintenance rounds'}</span>
              <input className="k-input st-input" type="number" min={60} step={30} value={interval} onChange={(e) => setIntervalText(e.target.value)} />
              <span className="k-help">
                {mode === 'poll' ? 'At least 60, as GitHub asks of anyone polling its events.' : 'These rounds still publish what is ready, refresh tokens and read the numbers every six hours.'}
              </span>
            </label>
          )}
        </section>
        <SaveBar
          form="listening-form"
          dirty={count > 0}
          busy={busy}
          text={changesText(count)}
          onUndo={() => {
            setMode(data.mode);
            setIntervalText(String(data.intervalSeconds));
          }}
        />
      </form>
      <ConfirmSheet open={rotating} onOpenChange={setRotating} title="Rotate the webhook secret?" keep="Keep it" confirm="Rotate the secret" icon="retry" onConfirm={newSecret}>
        A new secret replaces the current one at once: every webhook on GitHub stops being trusted until it is given the new one.
      </ConfirmSheet>
      <OnceSheet value={secret} title="Copy the secret now" text="It is shown only this once. Paste it into each webhook on GitHub." note="The GitHub webhook secret" onDone={() => setSecret(null)} />
    </div>
  );
}
