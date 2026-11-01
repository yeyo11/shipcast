import type { Preflight as Result } from '@shipcast/engine';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { TopBar } from '../../components/kit/Bars';
import { Preflight } from '../../components/Preflight';
import { useToast } from '../../components/Toasts';
import { ActionBar, RadioCard } from '../../components/write/Form';
import { ago } from '../../components/write/format';
import { PickerCombobox, PickerSelect, type PickerOption } from '../../components/kit/Picker';
import { checkRepo, launchRepo, listReleases, listRepos } from '../../server/launches.functions';

interface LaunchSearch {
  /** A repo to start with, as `owner/name` (a link from elsewhere that means "launch this one") */
  repo?: string;
}

export const Route = createFileRoute('/_app/launch')({
  head: () => ({ meta: [{ title: 'Launch a repo · Shipcast' }] }),
  validateSearch: (search: Record<string, unknown>): LaunchSearch => (typeof search.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(search.repo) ? { repo: search.repo } : {}),
  loader: () => listRepos(),
  component: LaunchARepo,
});

type Release = Awaited<ReturnType<typeof listReleases>>[number];

/** How a release shows in its field: the tag in mono, then whether it is the latest and how old */
function releaseWords(release: Release, latest: boolean): string {
  return [latest ? 'latest' : '', ago(release.publishedAt), release.prerelease ? 'pre-release' : ''].filter(Boolean).join(', ');
}

function LaunchARepo() {
  const { repos, sources, appReview } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [repo, setRepo] = useState('');
  const [releases, setReleases] = useState<Release[]>([]);
  const [ref, setRef] = useState('');
  const [check, setCheck] = useState<Result | null>(null);
  const [direct, setDirect] = useState(false);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const repoOptions = useMemo<PickerOption[]>(() => repos.map((r) => ({ value: r.repo, label: r.repo, hint: `pushed ${ago(r.pushedAt)}` })), [repos]);
  const releaseOptions = useMemo<PickerOption[]>(() => releases.map((r, i) => ({ value: r.tag, label: r.tag, hint: releaseWords(r, i === 0) })), [releases]);
  // The latest answer wins: picking again while a check runs drops the older one
  const asked = useRef(0);

  const runCheck = async (name: string, tag: string) => {
    const mine = ++asked.current;
    setBusy('Checking…');
    const result = await checkRepo({ data: { repo: name, ref: tag || undefined } }).catch((error: unknown) => {
      toast.fail(error instanceof Error ? error.message : String(error));
      return null;
    });
    if (mine !== asked.current) return;
    setCheck(result);
    setBusy(null);
  };

  const pick = async (name: string) => {
    const mine = ++asked.current;
    setRepo(name);
    setCheck(null);
    setRef('');
    setReleases([]);
    if (!name) return setBusy(null);
    setBusy('Reading releases…');
    const found = await listReleases({ data: name }).catch(() => []);
    if (mine !== asked.current) return;
    setReleases(found);
    const latest = found[0]?.tag ?? '';
    setRef(latest);
    await runCheck(name, latest);
  };

  useEffect(() => {
    if (search.repo && repos.some((r) => r.repo === search.repo)) void pick(search.repo);
    // Only the address the page opened with: later picks are the owner's
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <TopBar back={{ label: 'Launches', to: '/' }} />
      <div className="wr-page">
        <form
          id="launch-form"
          className="k-stack wr-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!check?.ok) return;
            setBusy('Starting…');
            const answer = await launchRepo({ data: { repo, ref, direct } }).catch((error: unknown) => ({
              ok: false as const,
              problem: error instanceof Error ? error.message : String(error),
            }));
            setBusy(null);
            if (answer.ok) {
              toast.done(`Drafting ${repo.split('/')[1]} ${ref}`, 'The analysis takes a few minutes; it shows on Launches while it runs.');
              await navigate({ to: '/' });
            } else toast.fail(answer.problem);
          }}
        >
          <h1 className="k-d k-d48">Launch a repo</h1>
          <p className="k-muted wr-flush">
            Pick a release. Shipcast reads the code and drafts every piece; the analysis takes a few minutes.
            {sources && (
              <>
                {' '}
                Text, pages or images instead? <Link to="/sources">Launch from sources</Link>
              </>
            )}
          </p>
          <PickerCombobox label="Repository" placeholder="Type a repo’s name" empty="No repo of yours matches." options={repoOptions} value={repo || null} onValueChange={(name) => void pick(name ?? '')} />
          {repo && (
            <PickerSelect
              label="Release"
              mono
              placeholder={busy === 'Reading releases…' ? 'Reading releases…' : releases.length === 0 ? 'No published releases' : 'Choose a release'}
              disabled={releases.length === 0}
              options={releaseOptions}
              value={ref || null}
              render={(o) => (
                <>
                  <span className="k-mono wr-tag">{o.label}</span> · {o.hint}
                </>
              )}
              onValueChange={(tag) => {
                setRef(tag);
                void runCheck(repo, tag);
              }}
            />
          )}
          {busy && (
            <p className="k-sm k-muted wr-flush" role="status">
              {busy}
            </p>
          )}
          {check && <Preflight result={check} />}
          {check && (
            <fieldset className="k-stack k-g8 wr-fieldset">
              <legend className="k-lbl wr-legend">How it is published</legend>
              <RadioCard
                name="mode"
                checked={!direct}
                onChange={() => setDirect(false)}
                title="Review the drafts first"
                detail={appReview ? 'They wait in Shipcast until you approve them here.' : 'They wait in a pull request until you approve them here or merge it on GitHub.'}
              />
              <RadioCard name="mode" checked={direct} onChange={() => setDirect(true)} title="Publish without review" detail="Every channel publishes once the site is live." />
            </fieldset>
          )}
        </form>
        <ActionBar>
          <button className="k-btn k-pri k-full" type="submit" form="launch-form" disabled={!check?.ok || busy !== null}>
            {direct ? 'Draft and publish' : 'Draft the launch'}
          </button>
        </ActionBar>
      </div>
    </>
  );
}
