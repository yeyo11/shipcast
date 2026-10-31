import { createFileRoute, Link, useNavigate, useRouter } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ComponentType, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { OnboardAI, OnboardAutomation, OnboardBrand, OnboardChannels, OnboardMeasure, Shipped, type IllustrationProps } from '../components/illustrations';
import { Diamond, Icon } from '../components/kit/Icon';
import { Sheet, SheetClose } from '../components/kit/Sheet';
import { ToastProvider, useToast } from '../components/Toasts';
import { Combobox } from '../components/ui/Combobox';
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
 * The onboarding (boards Onboarding, OnboardingBrandYml and OnboardingDone): one step per screen, a
 * bar per step on top, and one primary button at the thumb that saves the step's choice and moves on.
 * An optional step (Channels, Measurement) left empty is skipped for now; "Set up for now" sets the
 * whole thing aside, resumable from Settings. What is already configured shows as done.
 * See docs/decisions/onboarding.md
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
  measure: 'How the numbers come back: search engines and the blog’s visits. Each source is optional.',
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
    <p className="k-xs acc-onb-error" id={`${problem.id}-error`}>
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
    <p className="k-notice acc-onb-done" role="status">
      <Icon name="check" size={18} />
      <span className="k-grow">{children}</span>
    </p>
  );
}

function Trouble({ children }: { children: ReactNode }) {
  return (
    <div className="k-notice k-bad" role="alert">
      <Diamond size={9} />
      <span className="k-grow">{children}</span>
    </div>
  );
}

const BRAND_IDS: Record<BrandField, string> = { displayName: 'b-name', site: 'b-site', github: 'b-gh', languages: 'b-lang' };
const BRAND_SHORT: Record<BrandField, string> = {
  displayName: 'add your name',
  site: 'add your blog’s full address',
  github: 'add your GitHub login',
  languages: 'choose a language',
};
const BRAND_ORDER: BrandField[] = ['displayName', 'site', 'github', 'languages'];

const LANGUAGES = [
  { id: 'es', name: 'Spanish' },
  { id: 'en', name: 'English' },
] as const;

/** "Spanish, English": the blog's languages as a field shows them */
const languageWords = (chosen: readonly string[]) => LANGUAGES.filter((l) => chosen.includes(l.id)).map((l) => l.name).join(', ');

/**
 * The blog's languages: a field that reads like the others ("Spanish, English") and opens a sheet with
 * one check per language, so a phone gets big targets rather than a cramped multi-select.
 */
function LanguagesField({ value, onChange, problem, onLeave }: { value: string[]; onChange: (next: string[]) => void; problem: Problem | undefined; onLeave: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="k-field">
      <span className="k-lbl" id="b-lang-label">
        The blog’s languages
      </span>
      <button
        type="button"
        id="b-lang"
        className={`k-input acc-onb-input acc-onb-pick${value.length === 0 ? ' k-ph' : ''}`}
        aria-labelledby="b-lang-label b-lang"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        {...invalid(problem)}
      >
        {value.length ? languageWords(value) : 'Choose the languages'}
      </button>
      <FieldError problem={problem} />
      <Sheet
        label="The blog’s languages"
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) onLeave();
        }}
      >
        <h2 className="k-d k-d30">Languages</h2>
        <p className="k-sm k-muted acc-onb-sheet-lead">The blog is written in these; every article comes in each of them.</p>
        <div className="k-stack" role="group" aria-label="The blog’s languages">
          {LANGUAGES.map((l) => {
            const on = value.includes(l.id);
            return (
              <button key={l.id} type="button" className="k-row acc-onb-check-row" role="checkbox" aria-checked={on} onClick={() => onChange(on ? value.filter((x) => x !== l.id) : [...value, l.id])}>
                <span className={`k-check${on ? ' k-on' : ''}`} aria-hidden="true">
                  {on && <Icon name="check" size={16} strokeWidth={3} />}
                </span>
                <span className="k-grow">{l.name}</span>
              </button>
            );
          })}
        </div>
        <SheetClose className="k-btn k-pri k-full">Done</SheetClose>
      </Sheet>
    </div>
  );
}

/** One text field in the board's shape: the label above, the input in its rounded box, the problem under it */
function TextField({ id, label, problem, mono, ...input }: { id: string; label: string; problem: Problem | undefined; mono?: boolean } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="k-field">
      <label className="k-lbl" htmlFor={id}>
        {label}
      </label>
      <input id={id} {...input} className={`k-input acc-onb-input${mono ? ' k-mono' : ''}${input.className ? ` ${input.className}` : ''}`} {...invalid(problem)} />
      <FieldError problem={problem} />
    </div>
  );
}

function BrandStep({ data, saver, report, attempted }: StepProps) {
  const router = useRouter();
  const toast = useToast();
  const [repos, setRepos] = useState<Array<{ value: string; label: string; hint?: string }>>([]);
  const [reposProblem, setReposProblem] = useState<string | null>(null);
  const [repo, setRepo] = useState<string | null>(data.brand.launchesRepo);
  const [brandFile, setBrandFile] = useState<{ state: 'missing' | 'valid' | 'invalid'; problems?: string } | null>(null);
  const [form, setForm] = useState({ displayName: '', site: 'https://', github: data.login ?? '', languages: ['es', 'en'] });
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
            : [{ id: 'b-show', message: 'Look at brand.yml, then commit it.', short: 'commit brand.yml' }]
          : [];
  useReport(report, problems);
  const shown = (p: Problem | undefined) => (p && (attempted || touched.has(p.id)) ? p : undefined);
  const repoProblem = shown(problems.find((p) => p.id === 'b-repo'));
  const commitProblem = shown(problems.find((p) => p.id === 'b-show'));

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
      ? [{ id: 'b-name', message: 'This repo has no brand.yml yet: fill in the fields to add one.', short: 'add a brand.yml to this repo' }]
      : [{ id: 'b-repo', message: 'This repo’s brand.yml does not validate: fix it on GitHub, or choose another repo.', short: 'fix brand.yml on GitHub' }];
  };

  // No repo, or a known problem, never reaches here: Continue points at it first
  useSaver(saver, async () => (saved || !repo ? true : brandFile?.state === 'valid' ? true : choose(repo)));

  const body = { repo: repo ?? '', ...form };
  const pointAtFields = (fields: BrandFieldProblems) => {
    all(Object.values(BRAND_IDS));
    const first = BRAND_ORDER.find((f) => fields[f]);
    if (first) pointAt({ id: BRAND_IDS[first], message: '', short: '' });
  };
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
      pointAtFields(answer.fields);
    } else toast.fail(answer.problem);
  };

  const commit = async () => {
    setBusy(true);
    const answer = await createBrand({ data: body }).catch((error: unknown) => ({ ok: false as const, problem: message(error) }));
    setBusy(false);
    if (!answer.ok) {
      if ('fields' in answer && Object.keys(answer.fields).length > 0) {
        setServerFields(answer.fields);
        setYaml(null);
        pointAtFields(answer.fields);
      } else toast.fail(answer.problem);
      return;
    }
    toast.done('brand.yml committed', `It is on ${repo}’s default branch.`);
    setBrandFile({ state: 'valid' });
    setYaml(null);
    await router.invalidate();
  };

  const missing = brandFile?.state === 'missing';
  const nameProblem = shown(fieldProblem('displayName'));
  const siteProblem = shown(fieldProblem('site'));
  const ghProblem = shown(fieldProblem('github'));
  const langProblem = shown(fieldProblem('languages'));
  return (
    <>
      {data.brand.ok && (
        <Done>
          {data.brand.launchesRepo} is your launches repo, speaking for {data.brand.name}.
        </Done>
      )}
      {data.brand.problem && <Trouble>{data.brand.problem}</Trouble>}
      {reposProblem && <Trouble>The repos could not be listed: {reposProblem}</Trouble>}
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
        {...(missing || repoProblem ? {} : { help: data.viaApp ? 'The repos the GitHub App is installed on. Missing one? Add it to the App’s installation on GitHub.' : 'Your public repos.' })}
        {...(repoProblem && { error: repoProblem.message })}
      />
      {brandFile?.state === 'invalid' && (
        <Trouble>
          <strong>brand.yml is there but does not validate;</strong> fix it on GitHub:
          <pre className="k-mono k-xs acc-onb-log">{brandFile.problems}</pre>
        </Trouble>
      )}
      {missing && (
        <>
          <TextField id="b-name" label="Your name, as it signs the launches" value={form.displayName} onChange={(e) => edit('displayName', { displayName: e.target.value })} onBlur={() => leave('b-name')} problem={nameProblem} autoComplete="name" />
          <TextField id="b-site" label="Your blog’s address" inputMode="url" value={form.site} onChange={(e) => edit('site', { site: e.target.value })} onBlur={() => leave('b-site')} problem={siteProblem} />
          {/* The login is the one signed in: asked only when the page could not tell it */}
          {(!data.login || ghProblem) && <TextField id="b-gh" label="Your GitHub login" value={form.github} onChange={(e) => edit('github', { github: e.target.value })} onBlur={() => leave('b-gh')} problem={ghProblem} />}
          <LanguagesField value={form.languages} onChange={(languages) => edit('languages', { languages })} problem={langProblem} onLeave={() => leave('b-lang')} />
          <div className="k-notice k-bad acc-onb-missing" onMouseDown={holdFocus}>
            <Diamond size={9} />
            <span className="k-grow">
              <strong>This repo has no brand.yml.</strong> Shipcast can add a minimal one, committed to the default branch. You see it first.{' '}
              <button type="button" id="b-show" className="acc-onb-link" onClick={showFile} {...invalid(commitProblem)}>
                Show it
              </button>
            </span>
          </div>
          <FieldError problem={commitProblem} />
          <Sheet label="Add brand.yml?" open={yaml !== null} onOpenChange={(open) => !open && setYaml(null)}>
            <h2 className="k-d k-d30">Add brand.yml?</h2>
            <p className="k-sm k-muted acc-onb-sheet-lead">
              Committed {data.viaApp ? 'through the GitHub App ' : ''}to the default branch of {repo}.
            </p>
            <div className="k-input k-mono acc-onb-yaml" role="region" aria-label="brand.yml, as it would be committed" tabIndex={0}>
              {(yaml ?? '')
                .split('\n')
                .filter((line) => line.trim() !== '')
                .map((line, i) => (
                  <span key={i} className="k-diff-add">
                    <span className="visually-hidden">added: </span>
                    {line}
                  </span>
                ))}
            </div>
            <div className="k-hrow k-g10">
              <SheetClose className="k-btn">Not now</SheetClose>
              <button type="button" id="b-commit" className="k-btn k-pri k-grow" disabled={busy} onClick={commit}>
                {busy ? 'Committing…' : 'Commit brand.yml'}
              </button>
            </div>
          </Sheet>
        </>
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

/** A choice of a few, drawn as the board's field: the value in the rounded box, a chevron to say it opens */
function ChoiceField<V extends string>({ id, label, value, options, onChange }: { id: string; label: string; value: V; options: ReadonlyArray<{ id: V; name: string }>; onChange: (value: V) => void }) {
  return (
    <div className="k-field">
      <label className="k-lbl" htmlFor={id}>
        {label}
      </label>
      <span className="acc-onb-select">
        <select id={id} className="k-input acc-onb-input" value={value} onChange={(e) => onChange(e.target.value as V)}>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </span>
    </div>
  );
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

  const connectProblem = shown('ai-connect');
  return (
    <>
      <ChoiceField id="ai-provider" label="Provider" value={provider} options={PROVIDERS} onChange={setProvider} />
      {provider === 'claudio' ? (
        <>
          <TextField id="c-url" label="claudio’s URL" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => leave('c-url')} placeholder="http://localhost:8798" problem={shown('c-url')} />
          <TextField
            id="c-token"
            label="claudio’s token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onBlur={() => leave('c-token')}
            placeholder={data.ai.claudio.tokenSet ? 'Its token is in the keychain.' : 'Paste claudio’s token'}
            {...(data.ai.claudio.tokenSet && { className: 'acc-onb-kept' })}
            problem={shown('c-token')}
          />
        </>
      ) : (
        <div className="k-field">
          <span className="k-lbl">The account</span>
          {ready ? (
            <Link id="ai-connect" className="k-input acc-onb-input" to="/channels/$network" params={{ network: provider }}>
              Connected · manage it in Channels
            </Link>
          ) : (
            <Link id="ai-connect" className="k-input acc-onb-input acc-onb-connect" to="/channels/$network" params={{ network: provider }} aria-describedby={connectProblem ? 'ai-connect-error' : undefined}>
              Connect it
            </Link>
          )}
          <FieldError problem={connectProblem} />
        </div>
      )}
      <div className="k-hrow k-g10 k-wrap">
        <button type="button" className="k-btn k-sm" disabled={busy || !ready} onClick={test}>
          {busy ? 'Testing…' : 'Test the connection'}
        </button>
        {data.detected.ai && <span className="k-sm k-muted">Every task has a provider that is set up.</span>}
      </div>
      {result && (result.ok ? <Done>{result.text}</Done> : <Trouble>{result.text}</Trouble>)}
      {!everyTask && <p className="k-xs k-muted acc-onb-note">Each task has its own provider in AI settings; choosing another one here gives it every task.</p>}
    </>
  );
}

/** Channels and Measurement: each network with its connected accounts, or the way to connect one */
function AccountsStep({ networks }: { networks: Data['channels'] }) {
  return (
    <>
      {networks.map((n) => (
        <div className="k-field" key={n.id}>
          <span className="k-lbl" id={`net-${n.id}`}>
            {n.name}
          </span>
          {n.accounts.length > 0 ? (
            <Link className="k-input acc-onb-input" to="/channels/$network" params={{ network: n.id }} aria-describedby={`net-${n.id}`}>
              <span className="k-ellipsis">{n.accounts.map((a) => a.label).join(', ')} · connected</span>
            </Link>
          ) : (
            <Link className="k-input acc-onb-input acc-onb-connect" to="/channels/$network" params={{ network: n.id }} aria-describedby={`net-${n.id}`}>
              Connect it
            </Link>
          )}
        </div>
      ))}
    </>
  );
}

const MODES = [
  { id: 'poll', name: 'Rounds: it looks at your GitHub activity every interval' },
  { id: 'webhook', name: 'GitHub webhooks: GitHub tells Shipcast as it happens' },
  { id: 'off', name: 'Off: only what you start by hand' },
] as const;

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
      <ChoiceField id="o-mode" label="Mode" value={mode} options={MODES} onChange={setMode} />
      {mode === 'webhook' && <p className="k-xs k-muted acc-onb-note">GitHub webhooks need the app reachable from GitHub.</p>}
      {mode !== 'off' && (
        <TextField id="o-interval" label="Seconds between rounds" type="number" min={60} step={30} value={interval} onChange={(e) => setIntervalText(e.target.value)} onBlur={() => leave('o-interval')} problem={intervalProblem} />
      )}
    </>
  );
}

/** The top bar: the mark and the set-up's name, and the way out */
function Top({ onLeave }: { onLeave?: () => void }) {
  return (
    <header className="k-hrow k-between acc-onb-top">
      <span className="k-hrow k-g10">
        <span className="acc-onb-mark" aria-hidden="true" />
        <span className="k-d k-d24">Set up</span>
      </span>
      {onLeave && (
        <button type="button" className="k-sm acc-onb-leave" onClick={onLeave}>
          Set up for now
        </button>
      )}
    </header>
  );
}

const STATE_WORDS = { done: 'done', skipped: 'skipped for now', pending: 'to do' } as const;

/**
 * How far the set-up has come, one bar per step: any step up to the furthest one reached is a link,
 * so going back never depends on pressing Back step by step.
 */
function Progress({ data, current, seen }: { data: Data; current: Step; seen: number }) {
  const index = STEPS.indexOf(current);
  const furthest = Math.max(index, seen, ...STEPS.map((s, i) => (data.state.steps[s] === 'pending' ? -1 : i)));
  return (
    <nav aria-label="Set-up steps">
      <ol className="k-hrow k-g6 acc-onb-progress">
        {STEPS.map((s, i) => {
          const label = `Step ${i + 1}: ${STEP_TITLES[s]}, ${STATE_WORDS[data.state.steps[s]]}`;
          const bar = <span className={`acc-onb-seg${i <= index ? ' k-on' : ''}`} />;
          return (
            <li key={s}>
              {/* The router marks the open step's link aria-current="page" itself, the search included */}
              {i <= furthest ? (
                <Link to="/onboarding" search={{ step: s }} activeOptions={{ includeSearch: true }} aria-label={label}>
                  {bar}
                </Link>
              ) : (
                <span aria-label={label} role="img">
                  {bar}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
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
  // The furthest step opened in this visit: Back to the first step still leaves the way forward in the bars
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
      <main className="acc-onb acc-onb-end" id="main">
        <div className="acc-onb-band">
          <Shipped className="acc-onb-end-art" />
        </div>
        <div className="k-px k-stack k-g16 acc-onb-end-body">
          <h1 className="k-d acc-onb-end-title" id="onb-title" tabIndex={-1}>
            {left.length === 0 ? 'All set' : 'Set up for now'}
          </h1>
          <p className="k-lead acc-onb-end-lead">
            {left.length === 0
              ? 'Shipcast has what it needs. A short tour shows where things are; it takes a minute.'
              : `Still to do when you like: ${left.map((s) => STEP_TITLES[s]).join(', ')}. Settings has “Finish setting up”.`}
          </p>
          <button
            type="button"
            className="k-btn k-pri k-full"
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
            className="k-btn k-full"
            onClick={async () => {
              await answerTourOffer({ data: 'declined' });
              await navigate({ to: '/' });
            }}
          >
            Go to Launches
          </button>
          <p className="k-xs k-muted acc-onb-end-note">The tour is always in More, and in the search.</p>
        </div>
      </main>
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
  const state = data.state.steps[current];
  return (
    <div className="acc-onb">
      <Top onLeave={leave} />
      <main id="main" className="k-px k-stack acc-onb-main">
        <Progress key={current} data={data} current={current} seen={seen} />
        <p className="k-xs k-muted acc-onb-count" aria-live="polite">
          Step {index + 1} of {STEPS.length}: {STEP_TITLES[current]}
          {state === 'done' ? ' · done' : state === 'skipped' ? ' · skipped for now' : optional ? ' · optional' : ''}
        </p>
        <div className="acc-onb-art">
          <Art className="acc-onb-art-svg" />
        </div>
        <h1 className="k-d k-d48 acc-onb-title" id="onb-title" tabIndex={-1}>
          {STEP_TITLES[current]}
        </h1>
        <p className="k-muted acc-onb-lead">{LEADS[current]}</p>
        {/* One form per step, so Enter in any of its fields is Continue */}
        <form className="k-stack acc-onb-form" id="onb-form" onSubmit={proceed} noValidate>
          {current === 'brand' && <BrandStep key="brand" {...stepProps} />}
          {current === 'ai' && <AiStep key="ai" {...stepProps} />}
          {current === 'channels' && <AccountsStep networks={data.channels} />}
          {current === 'measure' && <AccountsStep networks={data.measure} />}
          {current === 'automation' && <AutomationStep key="automation" {...stepProps} />}
          {blocked && (
            <p className={`k-xs k-muted acc-onb-hint${attempted ? '' : ' visually-hidden'}`} id="onb-hint">
              To continue: {listed(problems)}.
            </p>
          )}
        </form>
      </main>
      <div className="k-bar acc-onb-bar" onMouseDown={holdFocus}>
        {/* Never disabled: a slow save must not trap anyone on a step */}
        <button type="button" className="k-btn" onClick={() => index > 0 && go(STEPS[index - 1]!)} style={index === 0 ? { visibility: 'hidden' } : undefined} aria-hidden={index === 0 || undefined} tabIndex={index === 0 ? -1 : undefined}>
          Back
        </button>
        {/* aria-disabled, not disabled: it stays focusable, and pressing it says what is missing */}
        <button type="submit" form="onb-form" className="k-btn k-pri k-grow" disabled={busy} aria-disabled={blocked || undefined} aria-describedby={blocked ? 'onb-hint' : undefined}>
          {busy ? 'Saving…' : last ? 'Finish' : 'Continue'}
        </button>
      </div>
    </div>
  );
}
