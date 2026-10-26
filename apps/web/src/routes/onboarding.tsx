import { createFileRoute, Link, useNavigate, useRouter } from '@tanstack/react-router';
import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
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
 * The onboarding: full-screen steps with one illustration each and a progress line, after the
 * approved design direction. Every step can be skipped for now and resumed from Settings; what is
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

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function Progress({ data, current }: { data: Data; current: Step | 'end' }) {
  return (
    <ol className="onb-progress" aria-label="Setup steps">
      {STEPS.map((s, i) => {
        const state = data.state.steps[s];
        return (
          <li key={s} data-state={state} aria-current={s === current ? 'step' : undefined}>
            <Link to="/onboarding" search={{ step: s }}>
              <span className="onb-progress-bar" aria-hidden="true" />
              <span className="onb-progress-label">
                {i + 1}. {STEP_TITLES[s]}
                <span className="visually-hidden">, {state === 'done' ? 'done' : state === 'skipped' ? 'skipped for now' : 'to do'}</span>
              </span>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}

function Done({ children }: { children: ReactNode }) {
  return (
    <p className="onb-done">
      <CheckIcon size={18} /> {children}
    </p>
  );
}

function BrandStep({ data }: { data: Data }) {
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

  const choose = async () => {
    if (!repo) return;
    setBusy(true);
    const answer = await chooseLaunchesRepo({ data: repo }).catch((error: unknown) => ({ ok: false as const, problem: message(error) }));
    setBusy(false);
    if (!answer.ok) return toast.fail(answer.problem);
    setBrandFile(answer.brand);
    if (answer.brand.state === 'valid') toast.done('The launches repo is set', `brand.yml speaks for ${answer.brand.name}.`);
    await router.invalidate();
  };

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
        onValueChange={setRepo}
        placeholder={repos.length ? 'Search your repos' : 'Loading the repos…'}
        help={data.viaApp ? 'The repos the GitHub App is installed on. Missing one? Add it to the App’s installation on GitHub.' : 'Your public repos.'}
      />
      <div className="row">
        <button type="button" className="btn" disabled={!repo || busy || (repo === data.brand.launchesRepo && data.brand.ok)} onClick={choose}>
          {busy ? 'Checking…' : 'Use this repo'}
        </button>
      </div>
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

function AiStep({ data }: { data: Data }) {
  const router = useRouter();
  const toast = useToast();
  const chosen = data.ai.tasks.pack.provider;
  const [provider, setProvider] = useState<(typeof PROVIDERS)[number]['id']>(chosen);
  const [url, setUrl] = useState(data.ai.claudio.url ?? '');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const ready = data.ai.ready[provider];
  const everyTask = Object.values(data.ai.tasks).every((t) => t.provider === provider);

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
        <form
          className="form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const answer = await saveClaudio({ data: { url, token } }).catch((error: unknown) => ({ ok: false as const, problem: message(error) }));
            setBusy(false);
            if (!answer.ok) return toast.fail(answer.problem);
            setToken('');
            toast.done('claudio saved', 'Its token is in the keychain.');
            await router.invalidate();
          }}
        >
          <div className="field">
            <label htmlFor="c-url">claudio’s URL</label>
            <input id="c-url" className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:8798" />
          </div>
          <div className="field">
            <label htmlFor="c-token">claudio’s token</label>
            <input id="c-token" className="input mono" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={data.ai.claudio.tokenSet ? 'Set; type a new one to replace it' : 'Not set'} />
          </div>
          <div className="row">
            <button type="submit" className="btn" disabled={busy || !url}>
              Save
            </button>
          </div>
        </form>
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
        {!everyTask && (
          <button
            type="button"
            className="btn"
            disabled={!ready}
            onClick={async () => {
              await useProviderForAll({ data: provider });
              toast.done(`${PROVIDERS.find((p) => p.id === provider)?.name} does every task`, 'Choose per task in AI settings.');
              await router.invalidate();
            }}
          >
            Use it for every task
          </button>
        )}
      </div>
      {result && <Notice tone={result.ok ? 'ok' : 'bad'}>{result.text}</Notice>}
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

function AutomationStep({ data }: { data: Data }) {
  const toast = useToast();
  const router = useRouter();
  const [mode, setMode] = useState(data.automation.mode);
  const [interval, setIntervalText] = useState(String(data.automation.intervalSeconds));
  return (
    <form
      className="form"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          const saved = await saveAutomation({ data: { mode, intervalSeconds: Number(interval) } });
          await markStep({ data: { step: 'automation', as: 'done' } });
          toast.done('Automation saved', saved.mode === 'off' ? 'Nothing runs on its own.' : `A round every ${saved.intervalSeconds} seconds.`);
          await router.invalidate();
        } catch (error) {
          toast.fail(message(error));
        }
      }}
    >
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
      <div className="row">
        <button type="submit" className="btn">
          Save
        </button>
      </div>
    </form>
  );
}

function Onboarding() {
  const data = Route.useLoaderData();
  const { step } = Route.useSearch();
  const navigate = useNavigate();
  const router = useRouter();
  const first = STEPS.find((s) => data.state.steps[s] === 'pending') ?? STEPS.find((s) => data.state.steps[s] === 'skipped') ?? 'end';
  const current: Step | 'end' = step ?? first;

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
        <header className="onb-top">
          <span className="lockup">
            <img src="/logo/mark.svg" alt="" />
            <span>Shipcast</span>
          </span>
          <Progress data={data} current="end" />
        </header>
        <main className="onb-main" id="main">
          <div className="onb-art">
            <Shipped />
          </div>
          <div className="onb-body">
            <h1 className="ph onb-title" id="onb-title" tabIndex={-1}>
              {left.length === 0 ? 'All set' : 'Set up for now'}
            </h1>
            <p className="onb-lead">
              {left.length === 0
                ? 'Shipcast has what it needs. A short tour shows where things are; it takes a minute.'
                : `Still to do when you like: ${left.map((s) => STEP_TITLES[s]).join(', ')}. Settings has “Finish setting up”.`}
            </p>
            <div className="row">
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
            </div>
            <p className="muted">The tour is always in the menu under your name, and in the search (⌘K or Ctrl K).</p>
          </div>
        </main>
      </div>
    );
  }

  const Art = ART[current];
  const index = STEPS.indexOf(current);
  const state = data.state.steps[current];
  const detected = data.detected[current];
  return (
    <div className="onb">
      <header className="onb-top">
        <span className="lockup">
          <img src="/logo/mark.svg" alt="" />
          <span>Shipcast</span>
        </span>
        <Progress data={data} current={current} />
        <button type="button" className="btn-link onb-leave" onClick={leave}>
          Set it up later
        </button>
      </header>
      <main className="onb-main" id="main">
        <div className="onb-art">
          <Art />
        </div>
        <div className="onb-body">
          <p className="onb-count">
            Step {index + 1} of {STEPS.length}
            {state === 'done' ? ' · done' : state === 'skipped' ? ' · skipped for now' : ''}
          </p>
          <h1 className="ph onb-title" id="onb-title" tabIndex={-1}>
            {STEP_TITLES[current]}
          </h1>
          <p className="onb-lead">{LEADS[current]}</p>
          <div className="onb-step">
            {current === 'brand' && <BrandStep data={data} />}
            {current === 'ai' && <AiStep data={data} />}
            {current === 'channels' && <AccountsStep networks={data.channels} kind="channels" />}
            {current === 'measure' && <AccountsStep networks={data.measure} kind="measure" />}
            {current === 'automation' && <AutomationStep data={data} />}
          </div>
          <nav className="onb-nav" aria-label="Setup navigation">
            {index > 0 && (
              <button type="button" className="btn" onClick={() => go(STEPS[index - 1]!)}>
                Back
              </button>
            )}
            <span className="onb-nav-gap" />
            {!detected && state !== 'done' && (
              <button
                type="button"
                className="btn"
                onClick={async () => {
                  await markStep({ data: { step: current, as: 'skipped' } });
                  await go(nextOf(current));
                }}
              >
                Skip for now
              </button>
            )}
            {(detected || state === 'done') && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={async () => {
                  await markStep({ data: { step: current, as: 'done' } });
                  await go(nextOf(current));
                }}
              >
                {index === STEPS.length - 1 ? 'Finish' : 'Continue'}
              </button>
            )}
          </nav>
        </div>
      </main>
    </div>
  );
}
