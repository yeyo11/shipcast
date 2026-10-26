import { Link } from '@tanstack/react-router';
import { launchDateLabel } from '../server/launch-summary';
import type { LaunchView } from '../server/view';
import { Pill } from './ui';

/*
 * The launches that wait, above the grid as slim full-width rows (docs/web-app.md): the yellow one
 * for drafts waiting for the owner's approval, a quiet dashed one for a launch that is not out and
 * not waiting for the owner (drafting, or not launched).
 */

const titleOf = (launch: LaunchView) => (launch.ref.startsWith('article:') ? 'Article' : (launch.repo.split('/')[1] ?? launch.repo));

function Who({ launch, timezone }: { launch: LaunchView; timezone: string }) {
  const article = launch.ref.startsWith('article:');
  return (
    <div className="lrow-who">
      <h2 className="lrow-title">
        <Link to="/launches/$id" params={{ id: String(launch.id) }}>
          {titleOf(launch)} {!article && <span className="lcard-ref">{launch.ref}</span>}
        </Link>
      </h2>
      <p className="lrow-meta">
        {launch.repo} · {launchDateLabel(launch.createdAt, timezone)}
      </p>
    </div>
  );
}

export function ApprovalRow({ launch, timezone }: { launch: LaunchView; timezone: string }) {
  return (
    <li className="lrow lrow-approval">
      <Who launch={launch} timezone={timezone} />
      <p className="lrow-text">Drafts are waiting in the pull request.</p>
      <div className="lrow-actions">
        {launch.pullRequest && (
          <Link className="lrow-link" to="/launches/$id/edit" params={{ id: String(launch.id) }}>
            Edit the drafts
          </Link>
        )}
        <Link className="btn btn-small lrow-review" to="/launches/$id" params={{ id: String(launch.id) }} search={{ tab: 'content' }}>
          Review the drafts
        </Link>
      </div>
    </li>
  );
}

export function PendingRow({ launch, timezone }: { launch: LaunchView; timezone: string }) {
  const drafting = launch.status === 'detected' || launch.status === 'generating';
  return (
    <li className="lrow lrow-pending">
      <Who launch={launch} timezone={timezone} />
      <Pill tone={launch.state.tone}>{launch.state.label}</Pill>
      <p className="lrow-text">{drafting ? 'Shipcast is reading the code and writing each piece.' : 'Nothing was published for this release.'}</p>
      <div className="lrow-actions">
        <Link className="btn btn-small" to="/launches/$id" params={{ id: String(launch.id) }} search={drafting ? { tab: 'details' } : {}}>
          {drafting ? 'Follow it' : 'Open it'}
        </Link>
      </div>
    </li>
  );
}
