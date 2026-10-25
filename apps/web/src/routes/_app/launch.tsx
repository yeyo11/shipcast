import type { Preflight as Result } from '@shipcast/engine';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { Preflight } from '../../components/Preflight';
import { Notice, when } from '../../components/ui';
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
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const pick = async (name: string) => {
    setRepo(name);
    setCheck(null);
    setProblem(null);
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
      <div className="page-head">
        <div>
          <h1 className="ph">Launch a repo</h1>
          <p>Pick one of {owner}’s repos and a release. Shipcast reads its code, writes every piece and hands you the drafts.</p>
        </div>
      </div>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy('Starting…');
          setProblem(null);
          const answer = await launchRepo({ data: { repo, ref, direct } });
          setBusy(null);
          if (answer.ok) await navigate({ to: '/' });
          else setProblem(answer.problem);
        }}
      >
        <div className="field">
          <label htmlFor="repo">Repository</label>
          <select id="repo" className="select" value={repo} onChange={(e) => void pick(e.target.value)}>
            <option value="">Choose a repo</option>
            {repos.map((r) => (
              <option key={r.repo} value={r.repo}>
                {r.repo.split('/')[1]} — pushed {when(r.pushedAt).slice(0, 10)}
              </option>
            ))}
          </select>
        </div>
        {repo && (
          <div className="field">
            <label htmlFor="ref">Release</label>
            <select
              id="ref"
              className="select mono"
              value={ref}
              onChange={async (e) => {
                setRef(e.target.value);
                setBusy('Checking…');
                setCheck(await checkRepo({ data: { repo, ref: e.target.value || undefined } }));
                setBusy(null);
              }}
            >
              {releases.length === 0 && <option value="">No published releases</option>}
              {releases.map((r) => (
                <option key={r.tag} value={r.tag}>
                  {r.tag} — {r.name} ({when(r.publishedAt).slice(0, 10)}){r.prerelease ? ' · pre-release' : ''}
                </option>
              ))}
            </select>
          </div>
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
        {problem && <Notice tone="bad">{problem}</Notice>}
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
