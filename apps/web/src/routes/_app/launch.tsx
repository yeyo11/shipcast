import type { Preflight as Result } from '@shipcast/engine';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { PageHead } from '../../components/PageHead';
import { Preflight } from '../../components/Preflight';
import { useToast } from '../../components/Toasts';
import { when } from '../../components/ui';
import { Combobox } from '../../components/ui/Combobox';
import { Select } from '../../components/ui/Select';
import { checkRepo, launchRepo, listReleases, listRepos } from '../../server/launches.functions';

export const Route = createFileRoute('/_app/launch')({
  head: () => ({ meta: [{ title: 'Launch a repo · Shipcast' }] }),
  loader: () => listRepos(),
  component: LaunchARepo,
});

function LaunchARepo() {
  const { owner, repos } = Route.useLoaderData();
  const navigate = useNavigate();
  const [repo, setRepo] = useState('');
  const [releases, setReleases] = useState<Awaited<ReturnType<typeof listReleases>>>([]);
  const [ref, setRef] = useState('');
  const [check, setCheck] = useState<Result | null>(null);
  const [direct, setDirect] = useState(false);
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const repoOptions = useMemo(() => repos.map((r) => ({ value: r.repo, label: r.repo.split('/')[1] ?? r.repo, hint: `pushed ${when(r.pushedAt).slice(0, 10)}` })), [repos]);
  const releaseOptions = useMemo(
    () => releases.map((r) => ({ value: r.tag, label: r.tag, hint: `${r.name} · ${when(r.publishedAt).slice(0, 10)}${r.prerelease ? ' · pre-release' : ''}` })),
    [releases],
  );

  const pick = async (name: string) => {
    setRepo(name);
    setCheck(null);
    setRef('');
    if (!name) return;
    setBusy('Reading releases…');
    const found = await listReleases({ data: name }).catch(() => []);
    setReleases(found);
    const latest = found[0]?.tag ?? '';
    setRef(latest);
    setBusy('Checking…');
    setCheck(await checkRepo({ data: { repo: name, ref: latest || undefined } }));
    setBusy(null);
  };

  return (
    <>
      <PageHead title="Launch a repo">Pick one of {owner}’s repos and a release. Shipcast reads its code, writes every piece and hands you the drafts.</PageHead>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
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
        <Combobox
          label="Repository"
          placeholder="Type a repo’s name"
          empty="No repo of yours matches."
          options={repoOptions}
          value={repo || null}
          onValueChange={(name) => void pick(name ?? '')}
        />
        {repo && (
          <Select
            label="Release"
            mono
            placeholder={releases.length === 0 ? 'No published releases' : 'Choose a release'}
            disabled={releases.length === 0}
            options={releaseOptions}
            value={ref || null}
            onValueChange={async (tag) => {
              setRef(tag);
              setBusy('Checking…');
              setCheck(await checkRepo({ data: { repo, ref: tag || undefined } }));
              setBusy(null);
            }}
          />
        )}
        {busy && <p className="muted">{busy}</p>}
        {check && <Preflight result={check} />}
        {check?.ok && (
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="label">How it is published</legend>
            <div className="seg">
              <label>
                <input type="radio" name="mode" checked={!direct} onChange={() => setDirect(false)} />
                <span>Review the drafts first</span>
              </label>
              <label>
                <input type="radio" name="mode" checked={direct} onChange={() => setDirect(true)} />
                <span>Publish without review</span>
              </label>
            </div>
            <small>{direct ? 'The drafts go straight onto the blog’s main branch and every approved channel publishes once the site is live.' : 'The drafts wait in a pull request until you approve them here or merge it on GitHub.'}</small>
          </fieldset>
        )}
        <div className="row">
          <button className="btn btn-primary" type="submit" disabled={!check?.ok || busy !== null}>
            {direct ? 'Draft and publish' : 'Draft the launch'}
          </button>
          <span className="muted" style={{ fontSize: 14 }}>
            The analysis takes a few minutes; you can leave this page.
          </span>
        </div>
      </form>
    </>
  );
}
