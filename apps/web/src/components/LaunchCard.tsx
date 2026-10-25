import { Link } from '@tanstack/react-router';
import type { LaunchView } from '../server/view';
import { ChannelName, number, Pill, when } from './ui';

/** A launch as the specimen's launch card: black, a yellow stamp, one row per channel */
export function LaunchCard({ launch }: { launch: LaunchView }) {
  const failed = new Map(launch.failures.map((f) => [f.channel, f.message]));
  const rows = [
    ...launch.posts.map((p) => ({ channel: p.channel, url: p.url, failure: undefined as string | undefined })),
    ...launch.failures.filter((f) => !launch.posts.some((p) => p.channel === f.channel)).map((f) => ({ channel: f.channel, url: null, failure: f.message })),
  ];
  return (
    <article className="launch">
      <div className="launch-head">
        <div>
          <h2>
            <Link to="/launches/$id" params={{ id: String(launch.id) }}>
              {launch.repo.split('/')[1]} <span className="mono">{launch.ref.startsWith('article:') ? '' : launch.ref}</span>
            </Link>
          </h2>
          <p>
            {launch.repo} · {launch.kind} · {when(launch.createdAt)}
            {launch.headline.length > 0 && <> · {launch.headline.map((h) => `${number(h.value)} ${h.label}`).join(' · ')}</>}
          </p>
        </div>
        <Pill tone={launch.state.tone}>{launch.state.label}</Pill>
      </div>
      {rows.length > 0 ? (
        <ol>
          {rows.map((row) => (
            <li key={row.channel}>
              <ChannelName channel={row.channel} />
              <span className="post">
                {row.url ? (
                  <a href={row.url} target="_blank" rel="noreferrer">
                    {row.url.replace(/^https:\/\//, '')}
                  </a>
                ) : (
                  (row.failure ?? failed.get(row.channel) ?? '')
                )}
              </span>
              {row.failure ? <Pill tone="failed">Failed</Pill> : <Pill tone="published">Published</Pill>}
            </li>
          ))}
        </ol>
      ) : (
        <ol>
          <li>
            <span />
            <span className="post" style={{ gridColumn: 'span 2' }}>
              {launch.problem ? launch.problem.split('\n')[0] : launch.pullRequest ? 'Drafts are waiting in the pull request.' : 'Nothing published yet.'}
            </span>
            <Link className="btn btn-small" style={{ color: 'inherit' }} to="/launches/$id" params={{ id: String(launch.id) }}>
              Open
            </Link>
          </li>
        </ol>
      )}
    </article>
  );
}
