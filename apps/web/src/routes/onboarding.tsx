import { createFileRoute, Link, useNavigate, useRouter } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ComponentType, type FormEvent, type ReactNode } from 'react';
import { DiffView } from '../components/assistant/DiffView';
import { OnboardAI, OnboardAutomation, OnboardBrand, OnboardChannels, OnboardMeasure, Shipped, type IllustrationProps } from '../components/illustrations';
import { ToastProvider, useToast } from '../components/Toasts';
import { Notice, Pill } from '../components/ui';
import { Combobox } from '../components/ui/Combobox';
import { CheckIcon } from '../components/ui/icons';
import { TooltipProvider } from '../components/ui/Tooltip';
import { requestTour } from '../components/tour/request';
import { saveAutomation } from '../server/automation.functions';
import {
  answerTourOffer,
  chooseLaunchesRepo,
  createBrand,
  finishOnboarding,
  getOnboarding,
  listLaunchRepos,
  markStep,
  proposeBrand,
  saveClaudio,
  setOnboardingAside,
  testProvider,
  useProviderForAll,
} from '../server/onboarding.functions';
import { STEP_TITLES, STEPS, type Step } from '../server/onboarding';

/*
 * The onboarding, a centred wizard: one step per screen, a thin progress bar, and one primary button
 * that saves the step's choice and moves on. Only the optional steps (Channels, Measurement) offer
 * "Skip this step"; "Finish later" sets the whole thing aside, resumable from Settings. What is
 * already configured shows as done. See docs/decisions/onboarding.md
 */

type Search = { step?: Step | 'end' };

export const Route = createFileRoute('/onboarding')({
  validateSearch: (search: Record<string, unknown>): Search => {
    const step = search.step;
    return step === 'end' || (typeof step === 'string' && (STEPS as readonly string[]).includes(step)) ? { step: step as Step | 'end' } : {};
  },
  head: () => ({ meta: [{ title: 'Set up · Shipcast' }] }),
  loader: () => getOnboarding(),
  component: () => (
    <ToastProvider>
      <TooltipProvider>
        <Onboarding />
      </TooltipProvider>
    </ToastProvider>
  ),
});

type Data = Awaited<ReturnType<typeof getOnboarding>>;

const ART: Record<Step, ComponentType<IllustrationProps>> = {
  brand: OnboardBrand,
  ai: OnboardAI,
  channels: OnboardChannels,
  measure: OnboardMeasure,
  automation: OnboardAutomation,
};

const LEADS: Record<Step, string> = {
  brand: 'The launches repo holds your blog, the drafts and brand.yml: who your launches speak for.',
  ai: 'Who reads your code and writes the drafts: claudio, the Anthropic API, or an OpenAI-compatible server.',
  channels: 'Where your launches go. Connect the accounts you post from; the rest can wait.',
  measure: 'How the numbers come back: search engines and the blog’s visits.',
  automation: 'How Shipcast notices a release on its own, and how often it looks.',
};

/** The steps that can be left empty without the install missing anything it needs to launch */
const OPTIONAL: ReadonlySet<Step> = new Set<Step>(['channels', 'measure']);

/** Said when Continue cannot move on a required step: what is still missing */
const MISSING: Record<Step, string> = {
  brand: 'Choose the launches repo, with a brand.yml that validates, to go on; or finish later.',
  ai: 'The provider is not set up yet: give claudio its URL and token, or connect the account in Channels.',
  channels: '',
  measure: '',
  automation: 'The automation could not be saved.',
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A step's own save, run by Continue before it moves on: false when the step could not save and
 * already said why. Kept in a ref so the one Continue button can drive every step's form.
 */
type Saver = () => Promise<boolean>;
type SaverRef = { current: Saver | null };

function useSaver(ref: SaverRef, save: Saver) {
  useEffect(() => {
    ref.current = save;
    return () => {
      if (ref.current === save) ref.current = null;
    };
  });
}

function Done({ children }: { children: ReactNode }) {
  return (
    <p className="onb-done">
      <CheckIcon size={18} /> {children}
    </p>
  );
}

function BrandStep({ data, saver }: { data: Data; saver: SaverRef }) {
  const router = useRouter();
  const toast = useToast();
  const [repos, setRepos] = useState<Array<{ value: string; label: string; hint?: string }>>([]);
  const [reposProblem, setReposProblem] = useState<string | null>(null);
  const [repo, setRepo] = useState<string | null>(data.brand.launchesRepo);
  const [brandFile, setBrandFile] = useState<{ state: 'missing' | 'valid' | 'invalid'; problems?: string } | null>(null);
  const [form, setForm] = useState({ displayName: '', site: 'https://', github: data.login ?? '', languages: ['en', 'es'] });
  const [yaml, setYaml] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void listLaunchRepos().then((answer) => {
      if (answer.ok) setRepos(answer.repos.map((r) => ({ value: r.repo, label: r.repo, ...(r.description && { hint: r.description }) })));
      else setReposProblem(answer.problem);
    });
  }, []);

  const choose = async (chosen: string) => {
    const answer = await chooseLaunchesRepo({ data: chosen }).catch((error: unknown) => ({ ok: false as const, problem: message(error) }));
    if (!answer.ok) {
      toast.fail(answer.problem);
      return false;
    }
    setBrandFile(answer.brand);
    if (answer.brand.state === 'valid') toast.done('The launches repo is set', `brand.yml speaks for ${answer.brand.name}.`);
    await router.invalidate();
    return answer.brand.state === 'valid';
  };

  // No repo chosen saves nothing: Continue then says what is missing
  useSaver(saver, async () => (!repo || (repo === data.brand.launchesRepo && data.brand.ok) ? true : choose(repo)));

  const body = { repo: repo ?? '', ...form };
  return (
    <>
      {data.brand.ok && <Done>{data.brand.launchesRepo} is your launches repo, speaking for {data.brand.name}.</Done>}
      {data.brand.problem && <Notice tone="bad">{data.brand.problem}</Notice>}
      {reposProblem && <Notice tone="bad">The repos could not be listed: {reposProblem}</Notice>}
      <Combobox
        label="The launches repo"
        options={repos}
        value={repo}
        onValueChange={(value) => {
          // The brand.yml check answered for the repo chosen before
          setRepo(value);
          setBrandFile(null);
          setYaml(null);
        }}
        placeholder={repos.length ? 'Search your repos' : 'Loading the repos…'}
        help={data.viaApp ? 'The repos the GitHub App is installed on. Missing one? Add it to the App’s installation on GitHub.' : 'Your public repos.'}
      />
      {brandFile?.state === 'invalid' && (
        <Notice tone="bad">
          brand.yml is there but does not validate; fix it on GitHub:
          <pre className="log">{brandFile.problems}</pre>
        </Notice>
      )}
      {brandFile?.state === 'missing' && (
        <section className="onb-sub" aria-label="Create brand.yml">
          <h3>This repo has no brand.yml</h3>
          <p className="muted">Shipcast can add a minimal one, committed through the GitHub App to the default branch. You see it first.</p>
          <div className="field">
            <label htmlFor="b-name">Your name, as it signs the launches</label>
            <input id="b-name" className="input" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="b-site">Your blog’s address</label>
            <input id="b-site" className="input mono" value={form.site} onChange={(e) => setForm({ ...form, site: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="b-gh">Your GitHub login</label>
            <input id="b-gh" className="input mono" value={form.github} onChange={(e) => setForm({ ...form, github: e.target.value })} />
          </div>
          <fieldset className="field onb-fieldset">
            <legend className="label">The blog’s languages</legend>
            <div className="checks">
              {(['en', 'es'] as const).map((l) => (
                <label className="check" key={l}>
                  <input
                    type="checkbox"
                    checked={form.languages.includes(l)}
                    onChange={(e) => setForm({ ...form, languages: e.target.checked ? [...form.languages, l] : form.languages.filter((x) => x !== l) })}
                  />
                  {l === 'en' ? 'English' : 'Spanish'}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="row">
            <button
              type="button"
              className="btn"
              onClick={async () => {
                const answer = await proposeBrand({ data: body });
                if (answer.ok) setYaml(answer.yaml);
                else toast.fail(answer.problem);
              }}
            >
              Show the file
            </button>
          </div>
          {yaml && (
            <>
              <DiffView before="" after={yaml} label="brand.yml, as it would be committed" />
              <div className="row">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    const answer = await createBrand({ data: body }).catch((error: unknown) => ({ ok: false as const, problem: message(error) }));
                    setBusy(false);
                    if (!answer.ok) return toast.fail(answer.problem);
                    toast.done('brand.yml committed', `It is on ${repo}’s default branch.`);
                    setBrandFile({ state: 'valid' });
                    setYaml(null);
                    await router.invalidate();
                  }}
                >
                  Commit brand.yml
                </button>
                <button type="button" className="btn" onClick={() => setYaml(null)}>
                  Not now
                </button>
              </div>
            </>
          )}
        </section>
      )}
    </>
  );
}

const PROVIDERS = [
  { id: 'claudio', name: 'claudio' },
  { id: 'anthropic', name: 'Anthropic API' },
  { id: 'openaiCompatible', name: 'OpenAI-compatible' },
] as const;

function AiStep({ data, saver }: { data: Data; saver: SaverRef }) {
  const toast = useToast();
  const chosen = data.ai.tasks.pack.provider;
  const [provider, setProvider] = useState<(typeof PROVIDERS)[number]['id']>(chosen);
  const [url, setUrl] = useState(data.ai.claudio.url ?? '');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const ready = data.ai.ready[provider];
  const everyTask = Object.values(data.ai.tasks).every((t) => t.provider === provider);

  useSaver(saver, async () => {
    if (provider === 'claudio' && (token || url !== (data.ai.claudio.url ?? ''))) {
      const answer = await saveClaudio({ data: { url, token } }).catch((error: unknown) => ({ ok: false as const, problem: message(error) }));
      if (!answer.ok) {
        toast.fail(answer.problem);
        return false;
      }
      setToken('');
      toast.done('claudio saved', 'Its token is in the keychain.');
    }
    // A provider picked here does every task; a per-task choice that already works is left alone
    if (provider !== chosen || (!everyTask && !data.detected.ai)) await useProviderForAll({ data: provider });
    return true;
  });

  const test = async () => {
    setBusy(true);
    setResult(null);
    const answer = await testProvider({ data: provider }).catch((error: unknown) => ({ ok: false as const, problem: message(error) }));
    setBusy(false);
    setResult(answer.ok ? { ok: true, text: `Connected: ${answer.detail}.` } : { ok: false, text: answer.problem });
  };

  return (
    <>
      {data.detected.ai && <Done>Every task has a provider that is set up.</Done>}
      <fieldset className="field onb-fieldset">
        <legend className="label">Provider</legend>
        <div className="seg">
          {PROVIDERS.map((p) => (
            <label key={p.id}>
              <input type="radio" name="provider" checked={provider === p.id} onChange={() => setProvider(p.id)} />
              <span>
                {p.name}
                {data.ai.ready[p.id] ? ' ✓' : ''}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {provider === 'claudio' ? (
        <div className="form">
          <div className="field">
            <label htmlFor="c-url">claudio’s URL</label>
            <input id="c-url" className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:8798" />
          </div>
          <div className="field">
            <label htmlFor="c-token">claudio’s token</label>
            <input id="c-token" className="input mono" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={data.ai.claudio.tokenSet ? 'Set; type a new one to replace it' : 'Not set'} />
          </div>
        </div>
      ) : (
        <p>
          {ready ? 'An account is connected.' : 'Its key is a connected account, kept in the keychain like any network’s.'}{' '}
          <Link to="/channels/$network" params={{ network: provider }}>
            {ready ? 'Manage it in Channels' : 'Connect it in Channels'}
          </Link>
          .
        </p>
      )}
      <div className="row">
        <button type="button" className="btn" disabled={busy || !ready} onClick={test}>
          {busy ? 'Testing…' : 'Test the connection'}
        </button>
      </div>
      {result && <Notice tone={result.ok ? 'ok' : 'bad'}>{result.text}</Notice>}
      {!everyTask && <p className="muted">Each task has its own provider in AI settings; choosing another one here gives it every task.</p>}
    </>
  );
}

function AccountsStep({ networks, kind }: { networks: Data['channels']; kind: 'channels' | 'measure' }) {
  return (
    <ul className="onb-networks">
      {networks.map((n) => (
        <li key={n.id}>
          <span className="onb-network-name">{n.name}</span>
          {n.accounts.length > 0 ? (
            <Pill tone="published">{n.accounts.map((a) => a.label).join(', ')}</Pill>
          ) : (
            <Link className="btn btn-small" to="/channels/$network" params={{ network: n.id }}>
              Connect
            </Link>
          )}
        </li>
      ))}
      {kind === 'measure' && <li className="muted">Each source is optional; the numbers simply start once one is connected.</li>}
    </ul>
  );
}

function AutomationStep({ data, saver }: { data: Data; saver: SaverRef }) {
  const toast = useToast();
  const [mode, setMode] = useState(data.automation.mode);
  const [interval, setIntervalText] = useState(String(data.automation.intervalSeconds));
  useSaver(saver, async () => {
    try {
      const saved = await saveAutomation({ data: { mode, intervalSeconds: Number(interval) } });
      toast.done('Automation saved', saved.mode === 'off' ? 'Nothing runs on its own.' : `A round every ${saved.intervalSeconds} seconds.`);
      return true;
    } catch (error) {
      toast.fail(message(error));
      return false;
    }
  });
  return (
    <>
      <fieldset className="field onb-fieldset">
        <legend className="label">Mode</legend>
        <div className="seg">
          {(
            [
              ['poll', 'Rounds'],
              ['webhook', 'GitHub webhooks'],
              ['off', 'Off'],
            ] as const
          ).map(([id, label]) => (
            <label key={id}>
              <input type="radio" name="mode" checked={mode === id} onChange={() => setMode(id)} />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <small>{mode === 'poll' ? 'Shipcast looks at your GitHub activity every interval.' : mode === 'webhook' ? 'GitHub tells Shipcast as it happens; it needs the app reachable from GitHub.' : 'Only what you start by hand.'}</small>
      </fieldset>
      {mode !== 'off' && (
        <div className="field">
          <label htmlFor="o-interval">Seconds between rounds</label>
          <input id="o-interval" className="input mono" type="number" min={60} step={30} value={interval} onChange={(e) => setIntervalText(e.target.value)} style={{ maxWidth: 200 }} />
        </div>
      )}
    </>
  );
}


/** The top bar: the lockup, how far the set-up has come, and the way out */
function Top({ at, current, onLeave }: { at: number; current: string; onLeave?: () => void }) {
  return (
    <header className="onb-top">
      <span className="lockup">
        <img src="/logo/mark.svg" alt="" />
        <span>Shipcast</span>
      </span>
      <div className="onb-bar" role="progressbar" aria-label="Set-up progress" aria-valuemin={1} aria-valuemax={STEPS.length} aria-valuenow={at} aria-valuetext={current}>
        <span style={{ width: `${(at / STEPS.length) * 100}%` }} />
      </div>
      {onLeave && (
        <button type="button" className="btn-link onb-leave" onClick={onLeave}>
          Finish later
        </button>
      )}
    </header>
  );
}

function Onboarding() {
  const data = Route.useLoaderData();
  const { step } = Route.useSearch();
  const navigate = useNavigate();
  const router = useRouter();
  const toast = useToast();
  const saver = useRef<Saver | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const first = STEPS.find((s) => data.state.steps[s] === 'pending') ?? STEPS.find((s) => data.state.steps[s] === 'skipped') ?? 'end';
  const current: Step | 'end' = step ?? first;

  // A step's "what is missing" belongs to that step only
  useEffect(() => setProblem(null), [current]);

  const go = async (to: Step | 'end') => {
    if (to === 'end') await finishOnboarding();
    await navigate({ to: '/onboarding', search: { step: to } });
    await router.invalidate();
    document.getElementById('onb-title')?.focus();
  };
  const nextOf = (s: Step): Step | 'end' => STEPS[STEPS.indexOf(s) + 1] ?? 'end';

  const leave = async () => {
    await setOnboardingAside();
    await navigate({ to: '/' });
  };

  if (current === 'end') {
    const left = STEPS.filter((s) => data.state.steps[s] !== 'done');
    return (
      <div className="onb">
        <Top at={STEPS.length} current="Set-up finished" />
        <main className="onb-main" id="main">
          <div className="onb-art">
            <Shipped width={220} />
          </div>
          <h1 className="ph onb-title" id="onb-title" tabIndex={-1}>
            {left.length === 0 ? 'All set' : 'Set up for now'}
          </h1>
          <p className="onb-lead">
            {left.length === 0
              ? 'Shipcast has what it needs. A short tour shows where things are; it takes a minute.'
              : `Still to do when you like: ${left.map((s) => STEP_TITLES[s]).join(', ')}. Settings has “Finish setting up”.`}
          </p>
          <div className="onb-actions">
            <button
              type="button"
              className="btn"
              onClick={async () => {
                await answerTourOffer({ data: 'declined' });
                await navigate({ to: '/' });
              }}
            >
              Not now, go to Launches
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={async () => {
                await answerTourOffer({ data: 'taken' });
                requestTour();
                await navigate({ to: '/' });
              }}
            >
              Take the tour
            </button>
          </div>
          <p className="muted onb-note">The tour is always in the menu under your name, and in the search (⌘K or Ctrl K).</p>
        </main>
      </div>
    );
  }

  const Art = ART[current];
  const index = STEPS.indexOf(current);
  const state = data.state.steps[current];
  const optional = OPTIONAL.has(current);
  const last = index === STEPS.length - 1;

  /** Continue: the step saves its choice, then the step is done (or, when optional and empty, left for later) */
  const proceed = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      if (!(await (saver.current?.() ?? Promise.resolve(true)))) return;
      // Detected fresh: what the step just saved is what decides whether it is done
      const fresh = await getOnboarding();
      if (fresh.detected[current] || fresh.state.steps[current] === 'done') await markStep({ data: { step: current, as: 'done' } });
      else if (optional) await markStep({ data: { step: current, as: 'skipped' } });
      else {
        await router.invalidate();
        setProblem(MISSING[current]);
        return;
      }
      await go(nextOf(current));
    } catch (error) {
      toast.fail(message(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="onb">
      <Top at={index + 1} current={`Step ${index + 1} of ${STEPS.length}: ${STEP_TITLES[current]}`} onLeave={leave} />
      <main className="onb-main" id="main">
        <div className="onb-art">
          <Art width={220} />
        </div>
        <p className="onb-count">
          Step {index + 1} of {STEPS.length}
          {state === 'done' ? ' · done' : state === 'skipped' ? ' · skipped for now' : optional ? ' · optional' : ''}
        </p>
        <h1 className="ph onb-title" id="onb-title" tabIndex={-1}>
          {STEP_TITLES[current]}
        </h1>
        <p className="onb-lead">{LEADS[current]}</p>
        {/* One form per step, so Enter in any of its fields is Continue */}
        <form className="onb-form" onSubmit={proceed} noValidate>
          <div className="onb-step">
            {current === 'brand' && <BrandStep key="brand" data={data} saver={saver} />}
            {current === 'ai' && <AiStep key="ai" data={data} saver={saver} />}
            {current === 'channels' && <AccountsStep networks={data.channels} kind="channels" />}
            {current === 'measure' && <AccountsStep networks={data.measure} kind="measure" />}
            {current === 'automation' && <AutomationStep key="automation" data={data} saver={saver} />}
          </div>
          {problem && <Notice tone="bad">{problem}</Notice>}
          <div className="onb-actions">
            {index > 0 && (
              <button type="button" className="btn" disabled={busy} onClick={() => go(STEPS[index - 1]!)}>
                Back
              </button>
            )}
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Saving…' : last ? 'Finish' : 'Continue'}
            </button>
            {optional && !data.detected[current] && state !== 'done' && (
              <button
                type="button"
                className="btn-link onb-skip"
                disabled={busy}
                onClick={async () => {
                  await markStep({ data: { step: current, as: 'skipped' } });
                  await go(nextOf(current));
                }}
              >
                Skip this step
              </button>
            )}
          </div>
        </form>
      </main>
    </div>
  );
}
