import { Fragment } from 'react';
import { networkName, signed, type AccountRow, type PieceRow } from '../../server/pieces';
import { Avatar, ChannelName, number, when } from '../ui';
import { Sparkline } from './Sparkline';

/*
 * A launch's numbers over time, calm: a table per piece (each number with its line, the latest value
 * and how much it grew since it was first read) and the followers of each account it went out with.
 * Inline SVG lines rather than charts: the analysis with periods, comparison and zoom is the Stats
 * section's; here the question is only "is it still moving?".
 */

const label = (name: string) => name.replace(/_/g, ' ');

export function NumbersOverTime({ rows }: { rows: PieceRow[] }) {
  const read = rows.filter((r) => r.numbers.length > 0);
  if (read.length === 0) return null;
  return (
    <section aria-labelledby="numbers-title">
      <h2 className="ph section" id="numbers-title">
        Numbers over time
      </h2>
      <p className="muted">Read every six hours on each piece. The change is since its first reading.</p>
      <div className="numbers">
        <table className="table numbers-table">
          <thead>
            <tr>
              <th scope="col">Piece</th>
              <th scope="col">Number</th>
              <th scope="col">
                <span className="visually-hidden">Over time</span>
              </th>
              <th scope="col" className="num">
                Now
              </th>
              <th scope="col" className="num">
                Change
              </th>
            </tr>
          </thead>
          <tbody>
            {read.map((row) => (
              <Fragment key={row.id}>
                {row.numbers.map((n, i) => (
                  <tr key={n.name} data-first={i === 0 || undefined}>
                    {i === 0 && (
                      <th scope="rowgroup" rowSpan={row.numbers.length} className="numbers-piece">
                        <span className="numbers-name">
                          <ChannelName channel={row.channel} />
                          {row.piece && <span className="mono"> {row.piece}</span>}
                        </span>
                        <span className="muted numbers-when">
                          {n.series.length} {n.series.length === 1 ? 'reading' : 'readings'}, last {when(n.to)}
                        </span>
                      </th>
                    )}
                    <td>{label(n.name)}</td>
                    <td className="numbers-line">
                      <Sparkline values={n.series} width={120} height={26} />
                    </td>
                    <td className="num">{number(n.value)}</td>
                    <td className="num muted">{n.series.length > 1 ? signed(n.value - n.first) : ''}</td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

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
