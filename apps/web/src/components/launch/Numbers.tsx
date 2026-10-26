import { networkName, signed, type AccountRow } from '../../server/pieces';
import { Avatar, number } from '../ui';
import { Sparkline } from './Sparkline';

/*
 * The accounts a launch went out with and how their followers moved, in the Details tab. Each piece's
 * own numbers over time are in its channel's panel (Channels.tsx).
 */

/** The accounts the launch went out with, and how their followers moved: the properties column's last block */
export function AccountNumbers({ accounts }: { accounts: AccountRow[] }) {
  if (accounts.length === 0) return null;
  return (
    <section className="props-block" aria-labelledby="accounts-title">
      <h2 className="props-title" id="accounts-title">
        Accounts
      </h2>
      <ul className="props-accounts">
        {accounts.map((a) => (
          <li key={a.id}>
            <div className="account-who">
              <Avatar src={a.avatarUrl} alt="" size={28} />
              <span>
                <strong className="break">{a.handle ?? a.label}</strong>
                <span className="muted"> {networkName(a.network)}</span>
              </span>
            </div>
            {a.followers ? (
              <div className="props-followers">
                <Sparkline values={a.followers.series} width={88} height={22} />
                <span>
                  <span className="mono">{number(a.followers.now)}</span> followers{' '}
                  <span className="muted" title={`From ${a.followers.from} to ${a.followers.to}`}>
                    {signed(a.followers.change)} since {a.followers.from === a.followers.to ? 'today' : a.followers.from}
                  </span>
                </span>
              </div>
            ) : (
              <p className="muted props-followers">No follower counts recorded yet</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
