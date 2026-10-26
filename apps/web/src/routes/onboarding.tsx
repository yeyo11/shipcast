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
import { checkBrandForm, STEP_TITLES, STEPS, type BrandField, type BrandFieldProblems, type Step } from '../server/onboarding';

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

/** Said when a step saved but is still not set up, which the page could not tell beforehand */
const MISSING: Record<Step, string> = {
  brand: 'Choose the launches repo, with a brand.yml that validates.',
  ai: 'The provider is not set up yet: give claudio its address and token, or connect the account in Channels.',
  channels: '',
  measure: '',
  automation: 'The automation could not be saved.',
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const prefersReducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * What keeps a step from moving on, said where it is: the control to take the focus, the message
 * shown under it, and a few words for the toast and the hint beside Continue.
 */
interface Problem {
  id: string;
  message: string;
  short: string;
}

/** A step tells the wizard what it is missing, so Continue can show itself unavailable and say why */
type Report = (problems: Problem[]) => void;

function useReport(report: Report, problems: Problem[]) {
  const key = JSON.stringify(problems);
  useEffect(() => {
    report(problems);
    // The list is rebuilt on every render; only a change in what it says is news
  }, [key]);
}

/** "add your name and your blog’s full address" */
function listed(problems: Problem[]): string {
  const words = problems.map((p) => p.short);
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;

/** The focus moves to the problem's control, brought into view, once it has rendered */
function pointAt(problem: Problem | undefined) {
  if (!problem) return;
  window.setTimeout(() => {
    const control = document.getElementById(problem.id);
    if (!control) return;
    control.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    control.focus({ preventScroll: true });
  }, 50);
}

function FieldError({ problem }: { problem: Problem | undefined }) {
  if (!problem) return null;
  return (
    <p className="field-error" id={`${problem.id}-error`}>
      {problem.message}
    </p>
  );
}

/**
 * Pressing a button would blur the field being typed in, which shows that field's message and moves
 * the button down before the press ends: the click then lands on nothing. Keeping the focus where it
 * is until the click runs keeps the layout still; the keyboard is unaffected.
 */
const holdFocus = (event: { preventDefault(): void }) => event.preventDefault();

const invalid = (problem: Problem | undefined): { 'aria-invalid'?: true; 'aria-describedby'?: string } => (problem ? { 'aria-invalid': true, 'aria-describedby': `${problem.id}-error` } : {});

/**
 * A step's own save, run by Continue before it moves on: true when saved; a list of problems the
 * save found (the repo has no brand.yml), which the wizard points at; false when the step could
 * not save and already said why. Kept in a ref so the one Continue button drives every step's form.
 */
type Saved = true | false | Problem[];
type Saver = () => Promise<Saved>;
type SaverRef = { current: Saver | null };

function useSaver(ref: SaverRef, save: Saver) {
  useEffect(() => {
    ref.current = save;
    return () => {
      if (ref.current === save) ref.current = null;
    };
  });
}

interface StepProps {
  data: Data;
  saver: SaverRef;
  report: Report;
  /** Continue was pressed: every problem shows under its field, not only those of fields left */
  attempted: boolean;
}

/** Fields left once (blurred), so a message shows after the person has been there, not before */
function useTouched() {
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  return { touched, leave: (id: string) => setTouched((t) => (t.has(id) ? t : new Set(t).add(id))), all: (ids: string[]) => setTouched(new Set(ids)) };
}

function Done({ children }: { children: ReactNode }) {
  return (
    <p className="onb-done">
      <CheckIcon size={18} /> {children}
    </p>
  );
}

const BRAND_IDS: Record<BrandField, string> = { displayName: 'b-name', site: 'b-site', github: 'b-gh', languages: 'b-lang-en' };
const BRAND_SHORT: Record<BrandField, string> = {
  displayName: 'add your name',
  site: 'add your blog’s full address',
  github: 'add your GitHub login',
  languages: 'choose a language',
};
const BRAND_ORDER: BrandField[] = ['displayName', 'site', 'github', 'languages'];

function BrandStep({ data, saver, report, attempted }: StepProps) {
  const router = useRouter();
  const toast = useToast();
  const [repos, setRepos] = useState<Array<{ value: string; label: string; hint?: string }>>([]);
  const [reposProblem, setReposProblem] = useState<string | null>(null);
  const [repo, setRepo] = useState<string | null>(data.brand.launchesRepo);
  const [brandFile, setBrandFile] = useState<{ state: 'missing' | 'valid' | 'invalid'; problems?: string } | null>(null);
  const [form, setForm] = useState({ displayName: '', site: 'https://', github: data.login ?? '', languages: ['en', 'es'] });
  const [serverFields, setServerFields] = useState<BrandFieldProblems>({});
  const [yaml, setYaml] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { touched, leave, all } = useTouched();

  useEffect(() => {
    void listLaunchRepos().then((answer) => {
      if (answer.ok) setRepos(answer.repos.map((r) => ({ value: r.repo, label: r.repo, ...(r.description && { hint: r.description }) })));
      else setReposProblem(answer.problem);
    });
  }, []);

  const saved = repo !== null && repo === data.brand.launchesRepo && data.brand.ok;
  const clientFields = checkBrandForm(form);
  const fieldProblem = (field: BrandField): Problem | undefined => {
    const text = clientFields[field] ?? serverFields[field];
    return text ? { id: BRAND_IDS[field], message: text, short: BRAND_SHORT[field] } : undefined;
  };
  const formProblems = BRAND_ORDER.flatMap((f) => fieldProblem(f) ?? []);

  // What Continue is missing, as far as the page can tell without asking GitHub
  const problems: Problem[] = saved
    ? []
    : !repo
      ? [{ id: 'b-repo', message: 'Choose the repo that holds your blog and brand.yml.', short: 'choose the launches repo' }]
      : brandFile?.state === 'invalid'
        ? [{ id: 'b-repo', message: 'This repo’s brand.yml does not validate: fix it on GitHub, or choose another repo.', short: 'fix brand.yml on GitHub' }]
        : brandFile?.state === 'missing'
          ? formProblems.length > 0
            ? formProblems
            : [{ id: yaml ? 'b-commit' : 'b-show', message: yaml ? 'Commit brand.yml to use this repo.' : 'Look at the file, then commit it.', short: 'commit brand.yml' }]
          : [];
  useReport(report, problems);
  const shown = (p: Problem | undefined) => (p && (attempted || touched.has(p.id)) ? p : undefined);
  const repoProblem = shown(problems.find((p) => p.id === 'b-repo'));
  const commitProblem = shown(problems.find((p) => p.id === 'b-show' || p.id === 'b-commit'));

  const edit = (field: BrandField, value: Partial<typeof form>) => {
    setForm({ ...form, ...value });
    setServerFields((fields) => {
      const next = { ...fields };
      delete next[field];
      return next;
    });
    setYaml(null);
  };

  const choose = async (chosen: string): Promise<Saved> => {
    const answer = await chooseLaunchesRepo({ data: chosen }).catch((error: unknown) => ({ ok: false as const, problem: message(error) }));
    if (!answer.ok) {
      toast.fail(answer.problem);
      return false;
    }
    setBrandFile(answer.brand);
    if (answer.brand.state === 'valid') {
      toast.done('The launches repo is set', `brand.yml speaks for ${answer.brand.name}.`);
      await router.invalidate();
      return true;
    }
    await router.invalidate();
    return answer.brand.state === 'missing'
      ? [{ id: 'b-name', message: 'This repo has no brand.yml yet: fill in the form below to add one.', short: 'add a brand.yml to this repo' }]
      : [{ id: 'b-repo', message: 'This repo’s brand.yml does not validate: fix it on GitHub, or choose another repo.', short: 'fix brand.yml on GitHub' }];
  };

  // No repo, or a known problem, never reaches here: Continue points at it first
  useSaver(saver, async () => (saved || !repo ? true : brandFile?.state === 'valid' ? true : choose(repo)));

  const body = { repo: repo ?? '', ...form };
  const showFile = async () => {
    if (formProblems.length > 0) {
      all(formProblems.map((p) => p.id));
      pointAt(formProblems[0]);
      return;
    }
    const answer = await proposeBrand({ data: body }).catch((error: unknown) => ({ ok: false as const, problem: message(error), fields: {} as BrandFieldProblems }));
    if (answer.ok) return setYaml(answer.yaml);
    if (Object.keys(answer.fields).length > 0) {
      setServerFields(answer.fields);
      const first = BRAND_ORDER.find((f) => answer.fields[f]);
      all(Object.values(BRAND_IDS));
      if (first) pointAt({ id: BRAND_IDS[first], message: '', short: '' });
    } else toast.fail(answer.problem);
  };

  const nameProblem = shown(fieldProblem('displayName'));
  const siteProblem = shown(fieldProblem('site'));
  const ghProblem = shown(fieldProblem('github'));
  const langProblem = shown(fieldProblem('languages'));
  return (
    <>
      {data.brand.ok && <Done>{data.brand.launchesRepo} is your launches repo, speaking for {data.brand.name}.</Done>}
      {data.brand.problem && <Notice tone="bad">{data.brand.problem}</Notice>}
      {reposProblem && <Notice tone="bad">The repos could not be listed: {reposProblem}</Notice>}
      <Combobox
        id="b-repo"
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
        {...(repoProblem && { error: repoProblem.message })}
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
            <input id="b-name" className="input" value={form.displayName} onChange={(e) => edit('displayName', { displayName: e.target.value })} onBlur={() => leave('b-name')} {...invalid(nameProblem)} />
            <FieldError problem={nameProblem} />
          </div>
          <div className="field">
            <label htmlFor="b-site">Your blog’s address</label>
            <input id="b-site" className="input mono" inputMode="url" value={form.site} onChange={(e) => edit('site', { site: e.target.value })} onBlur={() => leave('b-site')} {...invalid(siteProblem)} />
            <FieldError problem={siteProblem} />
          </div>
          <div className="field">
            <label htmlFor="b-gh">Your GitHub login</label>
            <input id="b-gh" className="input mono" value={form.github} onChange={(e) => edit('github', { github: e.target.value })} onBlur={() => leave('b-gh')} {...invalid(ghProblem)} />
            <FieldError problem={ghProblem} />
          </div>
          <fieldset className="field onb-fieldset">
            <legend className="label">The blog’s languages</legend>
            <div className="checks">
              {(['en', 'es'] as const).map((l) => (
                <label className="check" key={l}>
                  <input
                    id={`b-lang-${l}`}
                    type="checkbox"
                    checked={form.languages.includes(l)}
                    {...invalid(langProblem)}
                    onChange={(e) => {
                      leave('b-lang-en');
                      edit('languages', { languages: e.target.checked ? [...form.languages, l] : form.languages.filter((x) => x !== l) });
                    }}
                  />
                  {l === 'en' ? 'English' : 'Spanish'}
                </label>
              ))}
            </div>
            <FieldError problem={langProblem} />
          </fieldset>
          {!yaml && (
            <div className="row" onMouseDown={holdFocus}>
              <button type="button" id="b-show" className="btn" onClick={showFile} {...invalid(commitProblem?.id === 'b-show' ? commitProblem : undefined)}>
                Show the file
              </button>
            </div>
          )}
          {!yaml && <FieldError problem={commitProblem?.id === 'b-show' ? commitProblem : undefined} />}
          {yaml && (
            <>
              <DiffView before="" after={yaml} label="brand.yml, as it would be committed" />
              <div className="row">
                <button
                  type="button"
                  id="b-commit"
                  className="btn btn-primary"
                  disabled={busy}
                  {...invalid(commitProblem?.id === 'b-commit' ? commitProblem : undefined)}
                  onClick={async () => {
                    setBusy(true);
                    const answer = await createBrand({ data: body }).catch((error: unknown) => ({ ok: false as const, problem: message(error) }));
                    setBusy(false);
                    if (!answer.ok) {
                      if ('fields' in answer && Object.keys(answer.fields).length > 0) {
                        setServerFields(answer.fields);
                        setYaml(null);
                        all(Object.values(BRAND_IDS));
                        const first = BRAND_ORDER.find((f) => answer.fields[f]);
                        if (first) pointAt({ id: BRAND_IDS[first], message: '', short: '' });
                      } else toast.fail(answer.problem);
                      return;
                    }
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
              <FieldError problem={commitProblem?.id === 'b-commit' ? commitProblem : undefined} />
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

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
  } catch {
    return false;
  }
}

function AiStep({ data, saver, report, attempted }: StepProps) {
  const toast = useToast();
  const chosen = data.ai.tasks.pack.provider;
  const [provider, setProvider] = useState<(typeof PROVIDERS)[number]['id']>(chosen);
  const [url, setUrl] = useState(data.ai.claudio.url ?? '');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const { touched, leave } = useTouched();
  const ready = data.ai.ready[provider];
  const everyTask = Object.values(data.ai.tasks).every((t) => t.provider === provider);

  const problems: Problem[] =
    provider === 'claudio'
      ? [
          ...(!url.trim()
            ? [{ id: 'c-url', message: 'Write claudio’s address, for example http://localhost:8798.', short: 'add claudio’s address' }]
            : !isHttpUrl(url.trim())
              ? [{ id: 'c-url', message: 'claudio’s address is a full URL, starting with http:// or https://.', short: 'fix claudio’s address' }]
              : []),
          ...(!data.ai.claudio.tokenSet && !token.trim() ? [{ id: 'c-token', message: 'Paste claudio’s token.', short: 'add claudio’s token' }] : []),
        ]
      : ready
        ? []
        : [{ id: 'ai-connect', message: 'Connect the account in Channels first, or choose another provider.', short: 'connect the provider’s account' }];
  useReport(report, problems);
  const shown = (id: string) => {
    const p = problems.find((x) => x.id === id);
    return p && (attempted || touched.has(id)) ? p : undefined;
  };

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

  const urlProblem = shown('c-url');
  const tokenProblem = shown('c-token');
  const connectProblem = shown('ai-connect');
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
            <input id="c-url" className="input mono" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => leave('c-url')} placeholder="http://localhost:8798" {...invalid(urlProblem)} />
            <FieldError problem={urlProblem} />
          </div>
          <div className="field">
            <label htmlFor="c-token">claudio’s token</label>
            <input
              id="c-token"
              className="input mono"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onBlur={() => leave('c-token')}
              placeholder={data.ai.claudio.tokenSet ? 'Set; type a new one to replace it' : 'Not set'}
              {...invalid(tokenProblem)}
            />
            <FieldError problem={tokenProblem} />
          </div>
        </div>
      ) : (
        <>
          <p>
            {ready ? 'An account is connected.' : 'Its key is a connected account, kept in the keychain like any network’s.'}{' '}
            <Link id="ai-connect" to="/channels/$network" params={{ network: provider }} aria-describedby={connectProblem ? 'ai-connect-error' : undefined}>
              {ready ? 'Manage it in Channels' : 'Connect it in Channels'}
            </Link>
            .
          </p>
          <FieldError problem={connectProblem} />
        </>
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

function AutomationStep({ data, saver, report, attempted }: StepProps) {
  const toast = useToast();
  const [mode, setMode] = useState(data.automation.mode);
  const [interval, setIntervalText] = useState(String(data.automation.intervalSeconds));
  const { touched, leave } = useTouched();
  const seconds = Number(interval);
  const problems: Problem[] = mode !== 'off' && (!Number.isFinite(seconds) || seconds < 60) ? [{ id: 'o-interval', message: 'At least 60 seconds between rounds.', short: 'set at least 60 seconds between rounds' }] : [];
  useReport(report, problems);
  const intervalProblem = problems[0] && (attempted || touched.has('o-interval')) ? problems[0] : undefined;

  useSaver(saver, async () => {
    try {
      const saved = await saveAutomation({ data: { mode, intervalSeconds: seconds } });
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
          <input
            id="o-interval"
            className="input mono"
            type="number"
            min={60}
            step={30}
            value={interval}
            onChange={(e) => setIntervalText(e.target.value)}
            onBlur={() => leave('o-interval')}
            style={{ maxWidth: 200 }}
            {...invalid(intervalProblem)}
          />
          <FieldError problem={intervalProblem} />
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

const STATE_WORDS = { done: 'done', skipped: 'skipped for now', pending: 'to do' } as const;

/**
 * "Step n of 5" opens the list of the steps, each with its state: any step up to the furthest one
 * reached is a link, so going back never depends on pressing Back step by step.
 */
function StepList({ data, current, seen }: { data: Data; current: Step; seen: number }) {
  const index = STEPS.indexOf(current);
  const furthest = Math.max(index, seen, ...STEPS.map((s, i) => (data.state.steps[s] === 'pending' ? -1 : i)));
  const state = data.state.steps[current];
  return (
    <details className="onb-steps">
      <summary className="onb-count">
        Step {index + 1} of {STEPS.length}
        {state === 'done' ? ' · done' : state === 'skipped' ? ' · skipped for now' : OPTIONAL.has(current) ? ' · optional' : ''}
        <span className="visually-hidden">; show every step</span>
      </summary>
      <ol aria-label="Set-up steps">
        {STEPS.map((s, i) => {
          const label = (
            <>
              <span className="onb-steps-num" aria-hidden="true">
                {data.state.steps[s] === 'done' ? '✓' : i + 1}
              </span>
              <span>
                {STEP_TITLES[s]}
                <small className="muted"> · {STATE_WORDS[data.state.steps[s]]}</small>
              </span>
            </>
          );
          return (
            <li key={s} data-state={data.state.steps[s]}>
              {/* The router marks the open step's link aria-current="page" itself, the search included */}
              {i <= furthest ? (
                <Link to="/onboarding" search={{ step: s }} activeOptions={{ includeSearch: true }}>
                  {label}
                </Link>
              ) : (
                <span className="onb-steps-later">{label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </details>
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
  // Kept with the step they belong to: a step reports on mounting, before any effect here could reset them
  const [reported, setReported] = useState<{ step: Step | 'end'; list: Problem[] }>({ step: 'end', list: [] });
  const [attemptedOn, setAttemptedOn] = useState<Step | 'end' | null>(null);
  const first = STEPS.find((s) => data.state.steps[s] === 'pending') ?? STEPS.find((s) => data.state.steps[s] === 'skipped') ?? 'end';
  const current: Step | 'end' = step ?? first;

  const problems = reported.step === current ? reported.list : [];
  // The furthest step opened in this visit: Back to the first step still leaves the way forward in the list
  const [seen, setSeen] = useState(0);
  const at = current === 'end' ? STEPS.length - 1 : STEPS.indexOf(current);
  useEffect(() => setSeen((s) => Math.max(s, at)), [at]);
  const attempted = attemptedOn === current;

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
            <button type="button" className="btn" onClick={() => go(STEPS[STEPS.length - 1]!)}>
              Back
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
  const optional = OPTIONAL.has(current);
  const last = index === STEPS.length - 1;
  const blocked = problems.length > 0;

  /** The toast says it wherever the page is scrolled; the focus goes to the first thing to fix */
  const notReady = (list: Problem[]) => {
    toast.show({ tone: 'bad', title: `${STEP_TITLES[current]} isn’t ready`, text: sentence(listed(list)) });
    setAttemptedOn(current);
    pointAt(list[0]);
  };

  /** Continue: the step saves its choice, then the step is done (or, when optional and empty, left for later) */
  const proceed = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (blocked) return notReady(problems);
    setBusy(true);
    try {
      const saved = await (saver.current?.() ?? Promise.resolve<Saved>(true));
      if (saved === false) return;
      if (saved !== true) return notReady(saved);
      // Detected fresh: what the step just saved is what decides whether it is done
      const fresh = await getOnboarding();
      if (fresh.detected[current] || fresh.state.steps[current] === 'done') await markStep({ data: { step: current, as: 'done' } });
      else if (optional) await markStep({ data: { step: current, as: 'skipped' } });
      else {
        await router.invalidate();
        toast.show({ tone: 'bad', title: `${STEP_TITLES[current]} isn’t ready`, text: MISSING[current] });
        return;
      }
      await go(nextOf(current));
    } catch (error) {
      toast.fail(message(error));
    } finally {
      setBusy(false);
    }
  };

  const stepProps = { data, saver, report: (list: Problem[]) => setReported({ step: current, list }), attempted };
  return (
    <div className="onb">
      <Top at={index + 1} current={`Step ${index + 1} of ${STEPS.length}: ${STEP_TITLES[current]}`} onLeave={leave} />
      <main className="onb-main" id="main">
        <div className="onb-art">
          <Art width={220} />
        </div>
        <StepList key={current} data={data} current={current} seen={seen} />
        <h1 className="ph onb-title" id="onb-title" tabIndex={-1}>
          {STEP_TITLES[current]}
        </h1>
        <p className="onb-lead">{LEADS[current]}</p>
        {/* One form per step, so Enter in any of its fields is Continue */}
        <form className="onb-form" onSubmit={proceed} noValidate>
          <div className="onb-step">
            {current === 'brand' && <BrandStep key="brand" {...stepProps} />}
            {current === 'ai' && <AiStep key="ai" {...stepProps} />}
            {current === 'channels' && <AccountsStep networks={data.channels} kind="channels" />}
            {current === 'measure' && <AccountsStep networks={data.measure} kind="measure" />}
            {current === 'automation' && <AutomationStep key="automation" {...stepProps} />}
          </div>
          <div className="onb-actions" onMouseDown={holdFocus}>
            {/* Never disabled: a slow save must not trap anyone on a step */}
            {index > 0 && (
              <button type="button" className="btn" onClick={() => go(STEPS[index - 1]!)}>
                Back
              </button>
            )}
            {/* aria-disabled, not disabled: it stays focusable, and pressing it says what is missing */}
            <button type="submit" className="btn btn-primary" disabled={busy} aria-disabled={blocked || undefined} aria-describedby={blocked ? 'onb-hint' : undefined}>
              {busy ? 'Saving…' : last ? 'Finish' : 'Continue'}
            </button>
            {optional && !data.detected[current] && data.state.steps[current] !== 'done' && (
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
            {blocked && (
              <p className="onb-hint" id="onb-hint">
                To continue: {listed(problems)}.
              </p>
            )}
          </div>
        </form>
      </main>
    </div>
  );
}
