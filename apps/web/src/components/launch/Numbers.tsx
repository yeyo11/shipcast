import { networkName, signed, type AccountRow } from '../../server/pieces';
import { Avatar, number } from '../ui';
import { ChannelIcon } from './Glance';

/*
 * The accounts a launch went out with and how their followers moved, in the Details tab: a card like
 * the others, an account per row with its followers as a figure. Each piece's own numbers over time
 * are in its channel's panel (Channels.tsx).
 */
export function AccountNumbers({ accounts }: { accounts: AccountRow[] }) {
  if (accounts.length === 0) return null;
  return (
    <section className="lcard dcard" aria-labelledby="accounts-title">
      <h2 className="dcard-title" id="accounts-title">
        Accounts it went out with
      </h2>
      <ul className="daccounts">
        {accounts.map((a) => (
          <li key={a.id}>
            <span className="daccount-pic">
              <Avatar src={a.avatarUrl} alt="" size={36} />
              <span className="daccount-glyph" aria-hidden="true">
                <ChannelIcon channel={a.network} size={12} />
              </span>
            </span>
            <span className="daccount-name">
              <strong>{a.handle ?? a.label}</strong>
              <span className="muted">{networkName(a.network)}</span>
            </span>
            {a.followers ? (
              <span className="daccount-figure" title={`From ${a.followers.from} to ${a.followers.to}`}>
                <strong>{number(a.followers.now)}</strong>
                <span className="muted">
                  followers{a.followers.change ? `, ${signed(a.followers.change)} since ${a.followers.from === a.followers.to ? 'today' : a.followers.from}` : ''}
                </span>
              </span>
            ) : (
              <span className="daccount-figure muted">No counts</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
