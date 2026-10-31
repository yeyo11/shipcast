import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Icon } from '../../../components/kit/Icon';
import { Sheet } from '../../../components/kit/Sheet';
import { SaveBar } from '../../../components/SaveBar';
import { BUDGETS_OF, lockedRuleCount, promptEdited, promptLabel as promptName, TASK_TEXT, usd } from '../../../components/settings/ai';
import { changesText, hostOf } from '../../../components/settings/view';
import { AI_SETTING_NAMES, SettingsForm, type SettingView } from '../../../components/SettingsForm';
import { useToast } from '../../../components/Toasts';
import { getSettings } from '../../../server/settings.functions';
import { getAiSettings, previewAiPrompt, saveAiSettings } from '../../../server/ai.functions';

export const Route = createFileRoute('/_app/settings/ai')({
  head: () => ({ meta: [{ title: 'AI · Shipcast' }] }),
  loader: async () => {
    const [ai, general] = await Promise.all([getAiSettings(), getSettings()]);
    return { ...ai, runtime: general.settings.filter((s) => AI_SETTING_NAMES.has(s.name)) };
  },
  component: AiSettingsPage,
});

type Data = Awaited<ReturnType<typeof getAiSettings>> & { runtime: SettingView[] };
type Task = Data['tasks'][number];
type ProviderId = Data['providers'][number]['id'];
/** The limits as typed: an empty field keeps the task's default */
type BudgetFields = Record<string, string>;

const budgetFields = (budgets: Data['settings']['budgets']): BudgetFields => Object.fromEntries(Object.entries(budgets ?? {}).map(([task, n]) => [task, String(n)]));

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A native select drawn as the kit's input with the board's chevron */
function ProviderSelect({ data, value, label, onChange }: { data: Data; value: ProviderId; label: string; onChange: (p: ProviderId) => void }) {
  return (
    <span className="k-input k-grow st-select">
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as ProviderId)}>
        {data.providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.connected ? '' : ' (not connected)'}
          </option>
        ))}
      </select>
      <Icon name="chevronDown" size={16} />
    </span>
  );
}

function Providers({ data }: { data: Data }) {
  const [open, setOpen] = useState(false);
  const url = data.runtime.find((s) => s.name === 'claudioUrl');
  const token = data.runtime.find((s) => s.name === 'claudioToken');
  return (
    <section className="k-card st-g0 st-providers" aria-labelledby="st-providers">
      <h2 id="st-providers" className="k-d k-d30 st-mb6">
        Providers
      </h2>
      {data.providers.map((p) =>
        p.id === 'claudio' ? (
          <button key={p.id} type="button" className="k-row" onClick={() => setOpen(true)}>
            <span className="k-grow">
              <strong className="k-sm">{p.name}</strong>
              <br />
              <span className="k-xs k-muted">
                {url?.value ? hostOf(url.value) : 'Its address is not set'} · {token?.set ? 'token kept' : 'no token'}
              </span>
            </span>
            {url?.set ? <span className="k-pill k-p-pub">Connected</span> : <span className="k-pill k-p-fail">Not set</span>}
          </button>
        ) : (
          <Link key={p.id} to="/channels" className="k-row st-rowlink">
            <span className="k-grow">
              <strong className="k-sm">{p.name}</strong>
              <br />
              <span className="k-xs k-muted">{p.connected ? 'A connected account in Channels' : 'Connect it in Channels'}</span>
            </span>
            {p.connected ? <span className="k-pill k-p-pub">Connected</span> : <span className="k-pill k-p-quiet">Not connected</span>}
          </Link>
        ),
      )}
      <Sheet label="claudio" open={open} onOpenChange={setOpen}>
        <h2 className="k-d k-d30">claudio</h2>
        <p className="k-sm k-muted st-m0">Shipcast calls claudio’s OpenAI-compatible API, and Claude Code reads each release in a workspace claudio makes for it.</p>
        <SettingsForm settings={data.runtime} onSaved={() => setOpen(false)} />
      </Sheet>
    </section>
  );
}

/** One task's limits, edited in a sheet on a phone (the board shows them as words under the task) */
function LimitsSheet({ data, task, budgets, onChange, onClose }: { data: Data; task: Task | null; budgets: BudgetFields; onChange: (b: BudgetFields) => void; onClose: () => void }) {
  const list = task ? (BUDGETS_OF[task] ?? []) : [];
  return (
    <Sheet label="Spend limits" open={task !== null} onOpenChange={(open) => !open && onClose()}>
      <h2 className="k-d k-d30">{task ? TASK_TEXT[task]?.label : ''}</h2>
      <p className="k-sm k-muted st-m0">
        What one run may spend, in USD, up to {data.budgets.max}. Empty keeps the default. Only claudio takes a limit today: the providers billed per token are bounded by steps and time.
      </p>
      {list.map((b) => (
        <label className="k-field" key={b.task}>
          <span className="k-lbl">{b.label}</span>
          <input
            className="k-input st-input"
            type="number"
            inputMode="decimal"
            min={0.01}
            max={data.budgets.max}
            step={0.01}
            placeholder={`${(data.budgets.defaults as Record<string, number>)[b.task]?.toFixed(2)} (default)`}
            value={budgets[b.task] ?? ''}
            onChange={(e) => onChange({ ...budgets, [b.task]: e.target.value })}
          />
        </label>
      ))}
      <button type="button" className="k-btn k-full" onClick={onClose}>
        Done
      </button>
    </Sheet>
  );
}

function Preview({ data }: { data: Data }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [launchId, setLaunchId] = useState(data.launches[0]?.id);
  const [shown, setShown] = useState<{ system: string; prompt: string } | null>(null);
  return (
    <>
      <button type="button" className="k-card k-flat st-rowcard st-g0 st-preview" onClick={() => setOpen(true)}>
        <span className="k-grow">
          <strong>Preview a prompt</strong>
          <br />
          <span className="k-xs k-muted">With the saved prompts and tone. Nothing is sent to an AI.</span>
        </span>
        <Icon name="chevronRight" />
      </button>
      <Sheet label="Preview a prompt" open={open} onOpenChange={setOpen}>
        <h2 className="k-d k-d30">Preview a prompt</h2>
        {data.launches.length === 0 ? (
          <p className="k-sm k-muted st-m0">No launches yet: a preview renders the prompt a past launch would get.</p>
        ) : (
          <>
            <label className="k-field">
              <span className="k-lbl">The prompt a launch would get</span>
              <span className="k-input st-select">
                <select value={launchId === undefined ? '' : String(launchId)} onChange={(e) => setLaunchId(Number(e.target.value))}>
                  {data.launches.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.label}
                    </option>
                  ))}
                </select>
                <Icon name="chevronDown" size={16} />
              </span>
            </label>
            <button
              type="button"
              className="k-btn k-full"
              onClick={async () => {
                if (launchId === undefined) return;
                try {
                  setShown(await previewAiPrompt({ data: { launchId } }));
                } catch (error) {
                  toast.fail(errorText(error));
                }
              }}
            >
              <Icon name="eye" size={18} />
              Preview
            </button>
            {shown && (
              <>
                <span className="k-lbl">System</span>
                <pre className="st-log">{shown.system}</pre>
                <span className="k-lbl">Prompt</span>
                <pre className="st-log">{shown.prompt}</pre>
              </>
            )}
          </>
        )}
      </Sheet>
    </>
  );
}

function AiSettingsPage() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const toast = useToast();
  const [tasks, setTasks] = useState(data.settings.tasks);
  const [tone, setTone] = useState(data.settings.tone ?? '');
  const [budgets, setBudgets] = useState<BudgetFields>(budgetFields(data.settings.budgets));
  const [limitsOf, setLimitsOf] = useState<Task | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (task: Task, change: { provider?: ProviderId; model?: string }) => setTasks((all) => ({ ...all, [task]: { ...all[task], ...change } }));
  const reset = () => {
    setTasks(data.settings.tasks);
    setTone(data.settings.tone ?? '');
    setBudgets(budgetFields(data.settings.budgets));
  };
  // What was saved comes back from the server: the form starts again from it, so the save bar closes.
  // Keyed on the saved values, not the object: saving a prompt reloads the page's data too
  const saved = JSON.stringify([data.settings.tasks, data.settings.tone ?? '', data.settings.budgets ?? {}]);
  useEffect(reset, [saved]);

  const defaults = data.budgets.defaults as Record<string, number>;
  // Only the limits that were set: the server validates them and an empty one keeps the default
  const typedBudgets = Object.fromEntries(
    data.budgets.tasks.flatMap((task) => {
      const typed = budgets[task]?.trim();
      return typed ? [[task, Number(typed)]] : [];
    }),
  );
  const savedBudgets = (data.settings.budgets ?? {}) as Record<string, number>;
  const count =
    data.tasks.filter((t) => JSON.stringify(tasks[t]) !== JSON.stringify(data.settings.tasks[t])).length +
    (tone !== (data.settings.tone ?? '') ? 1 : 0) +
    data.budgets.tasks.filter((t) => typedBudgets[t] !== savedBudgets[t]).length;
  const limitOf = (task: string) => typedBudgets[task] ?? defaults[task];

  const save = async () => {
    setBusy(true);
    try {
      const clean = Object.fromEntries(
        data.tasks.map((task) => {
          const model = tasks[task].model?.trim();
          return [task, model ? { provider: tasks[task].provider, model } : { provider: tasks[task].provider }];
        }),
      );
      await saveAiSettings({ data: { tasks: clean, ...(tone.trim() && { tone: tone.trim() }), budgets: typedBudgets } });
      toast.done('AI settings saved', 'The next draft uses them.');
      await router.invalidate();
    } catch (error) {
      toast.fail(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const edited = data.prompts.filter(promptEdited).length;
  const lockedRules = lockedRuleCount(data.locked);

  return (
    <div className="st-content">
      {/* The fields are kept in state; the save bar's Save submits this form (sheets' own forms stay apart from it) */}
      <form
        id="ai-form"
        hidden
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      />
      <p className="st-lead">Which AI writes each task, in what tone and with which prompts.</p>
      <div className="st-cards">
        <Providers data={data} />

        <section className="k-card st-g0 st-tasks k-phone" aria-labelledby="st-tasks">
          <h2 id="st-tasks" className="k-d k-d30">
            Tasks
          </h2>
          {data.tasks.map((task) => {
            const text = TASK_TEXT[task] ?? { label: task, text: '' };
            return (
              <div key={task} className="st-task">
                <strong className="k-sm">{text.label}</strong>
                <div className="k-hrow k-g8">
                  <ProviderSelect data={data} label={`${text.label}: provider`} value={tasks[task].provider} onChange={(provider) => set(task, { provider })} />
                  <input className="k-input st-input st-model" placeholder="default" aria-label={`${text.label}: model`} value={tasks[task].model ?? ''} onChange={(e) => set(task, { model: e.target.value })} />
                </div>
                <span className="k-xs k-muted">
                  {text.text} ·{' '}
                  <button type="button" className="st-link st-plain" onClick={() => setLimitsOf(task)} aria-label={`${text.label}: spend limit, ${usd(limitOf(task) ?? 0)}`}>
                    limit {usd(limitOf(task) ?? 0)}
                  </button>
                </span>
              </div>
            );
          })}
        </section>

        <section className="k-card st-g0 k-desktop" aria-labelledby="st-tasks-d">
          <h2 id="st-tasks-d" className="k-d k-d30 st-mb8">
            Tasks
          </h2>
          <div className="st-taskgrid k-sm">
            <span className="k-lbl">Task</span>
            <span className="k-lbl">Provider</span>
            <span className="k-lbl">Model</span>
            <span className="k-lbl">Limit, USD</span>
            {data.tasks.map((task) => {
              const text = TASK_TEXT[task] ?? { label: task, text: '' };
              const main = BUDGETS_OF[task]?.[0]?.task ?? task;
              return (
                <div key={task} className="st-taskgrid-row">
                  <strong>{text.label}</strong>
                  <ProviderSelect data={data} label={`${text.label}: provider`} value={tasks[task].provider} onChange={(provider) => set(task, { provider })} />
                  <input className="k-input st-input st-cell" placeholder="default" aria-label={`${text.label}: model`} value={tasks[task].model ?? ''} onChange={(e) => set(task, { model: e.target.value })} />
                  <input
                    className="k-input st-input st-cell"
                    type="number"
                    inputMode="decimal"
                    min={0.01}
                    max={data.budgets.max}
                    step={0.01}
                    aria-label={`${text.label}: spend limit, USD`}
                    placeholder={defaults[main]?.toFixed(2)}
                    value={budgets[main] ?? ''}
                    onChange={(e) => setBudgets({ ...budgets, [main]: e.target.value })}
                  />
                </div>
              );
            })}
          </div>
          <p className="k-xs k-muted st-taskgrid-note">
            Up to {data.budgets.max} USD a run; empty keeps the default. The writing assistant’s check against the code has its own,{' '}
            <button type="button" className="st-link" onClick={() => setLimitsOf('assistant')}>
              {usd(limitOf('assistant-check') ?? 0)}
            </button>
            .
          </p>
        </section>

        <section className="k-card st-g8" aria-labelledby="st-tone">
          <h2 id="st-tone" className="k-d k-d30">
            <label htmlFor="st-tone-text">Tone</label>
          </h2>
          <textarea id="st-tone-text" className="k-input st-tone" value={tone} placeholder={data.brandTone ?? 'First person, direct and technical, no hype.'} onChange={(e) => setTone(e.target.value)} />
          <span className="k-help">Replaces brand.yml’s tone in every prompt. Empty keeps brand.yml’s{data.brandTone ? '' : ' (it has none: the default applies)'}.</span>
        </section>

        <Link to="/settings/ai/prompts" className="k-card st-g0 k-phone">
          <span className="k-hrow k-between">
            <h2 className="k-d k-d30">Prompts</h2>
            <Icon name="chevronRight" />
          </span>
          <span className="k-sm k-muted st-mt6">
            {data.prompts.length} prompts · {edited} edited · {lockedRules} locked rules
          </span>
        </Link>

        <section className="k-card st-g0 k-desktop" aria-labelledby="st-prompts-d">
          <div className="k-hrow k-between st-mb8">
            <h2 id="st-prompts-d" className="k-d k-d30">
              Prompts
            </h2>
            <Link to="/settings/ai/prompts" className="k-sm">
              Edit
            </Link>
          </div>
          {data.prompts.map((p) => (
            <div key={p.id} className="k-row">
              <span className="k-grow">{promptName(p.id)}</span>
              {promptEdited(p) ? <span className="k-pill k-p-draft">Edited</span> : <span className="k-pill k-p-quiet">Default</span>}
            </div>
          ))}
        </section>

        <Preview data={data} />
      </div>
      <LimitsSheet data={data} task={limitsOf} budgets={budgets} onChange={setBudgets} onClose={() => setLimitsOf(null)} />
      <SaveBar form="ai-form" dirty={count > 0} busy={busy} text={changesText(count)} onUndo={reset} />
    </div>
  );
}
