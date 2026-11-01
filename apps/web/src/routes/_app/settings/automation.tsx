import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { JobsPanel } from '../../../components/Jobs';
import { Icon } from '../../../components/kit/Icon';
import { Overlay } from '../../../components/kit/Overlay';
import { useLiveEnabled, useLiveRoute } from '../../../components/live/Live';
import { SaveBar } from '../../../components/SaveBar';
import { RuleEditor, ruleTitle, ruleWithout, type RuleDraft } from '../../../components/TriggerRules';
import { ago, listeningText } from '../../../components/settings/view';
import { useToast } from '../../../components/Toasts';
import { getAutomation, runRoundNow, saveTriggers } from '../../../server/automation.functions';

export const Route = createFileRoute('/_app/settings/automation')({
  head: () => ({ meta: [{ title: 'Automation · Shipcast' }] }),
  loader: () => getAutomation(),
  component: Automation,
});

/** A new rule's id, unlike every other's */
function freshId(rules: readonly RuleDraft[]): string {
  for (let n = rules.length + 1; ; n++) if (!rules.some((r) => r.id === `rule-${n}`)) return `rule-${n}`;
}

function Automation() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [sheet, setSheet] = useState<'round' | 'jobs' | null>(null);
  // With launch-triggers: the rules, saved from the save bar
  const [rules, setRules] = useState<RuleDraft[] | null>(data.triggers);
  const savedRules = JSON.stringify(data.triggers);
  const rulesChanged = JSON.stringify(rules) !== savedRules;
  // By value: the page reloads every few seconds while a round runs, and an unsaved edit must survive that
  useEffect(() => setRules(JSON.parse(savedRules) as RuleDraft[] | null), [savedRules]);
  // Live: any job's row or a saved setting reloads it; otherwise, while a round runs, it polls
  const live = useLiveEnabled();
  useLiveRoute(Route.id, live ? ['job', 'settings'] : null);
  const working = data.running || data.jobs.counts.running > 0;
  useEffect(() => {
    if (live || !working) return;
    const timer = window.setInterval(() => void router.invalidate(), 4000);
    return () => window.clearInterval(timer);
  }, [live, working, router]);

  const save = async () => {
    if (!rules) return;
    setBusy(true);
    try {
      const answer = await saveTriggers({ data: rules });
      if (!answer.ok) {
        toast.fail(answer.problem);
        return;
      }
      toast.done('Rules saved', 'The next GitHub event follows them.');
      await router.invalidate();
    } catch (error) {
      toast.fail(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const set = (i: number, change: Partial<RuleDraft>) => rules && setRules(rules.map((r, j) => (j === i ? { ...r, ...change } : r)));
  const runningJob = data.jobs.jobs.find((j) => j.state === 'running' && !j.queued);

  return (
    <div className="st-content">
      <form
        id="automation-form"
        hidden
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      />
      <div className="st-cards st-first">
        {rules && (
          <section className="k-card st-g12" aria-labelledby="st-triggers">
            <h2 id="st-triggers" className="k-d k-d30">
              Triggers
            </h2>
            <p className="k-sm k-muted st-m0">Which GitHub events create a launch. An event takes the first rule it matches; a repo’s own launch.yml can still say no.</p>
            {rules.length === 0 && <p className="k-sm k-muted st-m0">No rules: no GitHub event creates a launch. Launch by hand, or add a rule.</p>}
            {rules.map((rule, i) => (
              <div key={rule.id} className={`st-rule${rule.enabled ? '' : ' st-off'}`}>
                <div className="k-hrow k-g10">
                  <span className="k-d k-d24 st-rule-n">{i + 1}</span>
                  <button type="button" className="st-rule-title k-sm k-grow" onClick={() => setEditing(i)} aria-label={`Rule ${i + 1}, ${ruleTitle(rule)}: edit`}>
                    {ruleTitle(rule)}
                  </button>
                  <button type="button" className={`k-sw${rule.enabled ? ' k-on' : ''}`} role="switch" aria-checked={rule.enabled} aria-label={`Rule ${i + 1} on`} onClick={() => set(i, { enabled: !rule.enabled })} />
                </div>
                <div className="k-xs">
                  <span className="k-muted">Repos</span> <span className="k-mono">{rule.repos}</span>
                </div>
                <div className="k-xs">
                  <span className="k-muted">Without launch.yml</span> {ruleWithout(rule)}
                </div>
              </div>
            ))}
            <button
              type="button"
              className="k-btn k-sm st-start"
              onClick={() => {
                setRules([...rules, { id: freshId(rules), enabled: true, event: 'release', repos: '*', prereleases: false, channels: null }]);
                setEditing(rules.length);
              }}
            >
              <Icon name="plus" size={18} />
              Add a rule
            </button>
          </section>
        )}

        <section className="k-card st-g0" aria-labelledby="st-happened">
          <h2 id="st-happened" className="k-d k-d30 st-mb6">
            What happened
          </h2>
          <button type="button" className="k-row k-sm" onClick={() => setSheet('round')}>
            <span className="k-muted st-key">Last round</span>
            <span className="k-grow">{data.running ? 'Running now' : data.lastRound ? `${ago(data.lastRound.at)} · ${data.lastRound.summary}` : 'None yet'}</span>
            <span className={`k-dot ${data.running ? 'st-dot-run' : data.lastRound ? 'k-dot-pub' : 'k-dot-quiet'}`} aria-hidden="true" />
          </button>
          <div className="k-row k-sm">
            <span className="k-muted st-key">Last delivery</span>
            <span className="k-grow">{data.lastDelivery ? `${data.lastDelivery.summary} · ${ago(data.lastDelivery.at)}` : 'None yet'}</span>
            <span className={`k-dot ${data.lastDelivery ? 'k-dot-pub' : 'k-dot-quiet'}`} aria-hidden="true" />
          </div>
          <button type="button" className="k-row k-sm" onClick={() => setSheet('jobs')}>
            <span className="k-muted st-key">Running</span>
            <span className="k-grow">
              {runningJob ? runningJob.title : 'Nothing'}
              {data.jobs.counts.running > 1 ? <span className="k-muted"> and {data.jobs.counts.running - 1} more</span> : null}
            </span>
            <span className={`k-dot ${runningJob ? 'st-dot-run' : 'k-dot-quiet'}`} aria-hidden="true" />
          </button>
        </section>

        <Link to="/settings/automation/webhooks" className="k-card st-rowcard">
          <span className="k-grow">
            <strong>GitHub webhooks</strong>
            <br />
            <span className="k-xs k-muted">{listeningText(data)}</span>
          </span>
          <Icon name="chevronRight" />
        </Link>
      </div>

      {rules && <SaveBar form="automation-form" dirty={rulesChanged} busy={busy} text="Rules changed" />}

      <Overlay kind="drawer" label={editing === null ? 'Rule' : `Rule ${editing + 1}`} open={editing !== null && rules?.[editing] !== undefined} onOpenChange={(open) => !open && setEditing(null)}>
        {editing !== null && rules?.[editing] && (
          <RuleEditor
            n={editing + 1}
            rule={rules[editing]}
            channels={data.channels}
            onChange={(change) => set(editing, change)}
            onRemove={() => {
              setRules(rules.filter((_, j) => j !== editing));
              setEditing(null);
            }}
            onDone={() => setEditing(null)}
          />
        )}
      </Overlay>

      <Overlay kind="drawer" wide label="Last round" open={sheet === 'round'} onOpenChange={(open) => !open && setSheet(null)} heading="Rounds">
        <p className="k-sm k-muted st-m0">Each round checks for releases, publishes what is ready and reads the numbers when due.</p>
        {data.lastRound ? (
          <>
            <span className="k-lbl">
              Last round, {ago(data.lastRound.at)} · {data.lastRound.summary}
            </span>
            {data.lastRound.lines.length > 0 && <pre className="st-log">{data.lastRound.lines.join('\n')}</pre>}
          </>
        ) : (
          <p className="k-sm st-m0">The app runs its first round shortly after it starts.</p>
        )}
        <button
          type="button"
          className="k-btn k-full"
          disabled={data.running}
          onClick={async () => {
            const answer = await runRoundNow();
            if (answer.started) toast.done('A round has started', 'It checks for releases, publishes what is ready and reads the numbers when due.');
            else toast.show({ tone: 'wait', title: 'A round is already running' });
            await router.invalidate();
          }}
        >
          <Icon name="retry" size={18} />
          {data.running ? 'A round is running…' : 'Run a round now'}
        </button>
      </Overlay>

      <Overlay kind="drawer" wide label="Work in progress" open={sheet === 'jobs'} onOpenChange={(open) => !open && setSheet(null)} heading="Work">
        <JobsPanel initial={data.jobs} />
      </Overlay>
    </div>
  );
}
