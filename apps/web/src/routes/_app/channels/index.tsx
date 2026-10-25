import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { useToast } from '../../../components/Toasts';
import { Pill, Problem, when } from '../../../components/ui';
import { disconnect, getChannels, importEnv, makePrimary, recheckAccount, renameAccount } from '../../../server/channels.functions';
import { channelIcon } from '../../../server/view';

export const Route = createFileRoute('/_app/channels/')({
  head: () => ({ meta: [{ title: 'Channels · Shipcast' }] }),
  loader: () => getChannels(),
  component: Channels,
});

type Data = Awaited<ReturnType<typeof getChannels>>;
type NetworkView = Data['networks'][number];
type AccountView = NetworkView['accounts'][number];

function AccountRow({ account, brands }: { account: AccountView; brands: Data['brands'] }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [label, setLabel] = useState(account.label);
  /** Runs an action; a thrown error becomes a toast instead of a silent failure */
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      if (done) toast.done(done);
      await router.invalidate();
    } catch (error) {
      toast.fail(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const check = () =>
    act(async () => {
      const result = await recheckAccount({ data: account.id });
      if (result.status === 'ok') toast.done(`${account.label} works`, result.identity ? `Signed in as ${result.identity}.` : undefined);
      else toast.fail(result.problem ?? `${account.label} did not answer its check`);
    });
  const brand = brands.find((b) => b.id === account.brand)?.name ?? account.brand;
  return (
    <li>
      <div style={{ minWidth: 0, flex: 1 }}>
        {renaming ? (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await renameAccount({ data: { id: account.id, label } });
                toast.done(`Renamed to ${label}`);
                setRenaming(false);
              });
            }}
          >
            <label className="visually-hidden" htmlFor={`label-${account.id}`}>
              Name
            </label>
            <input id={`label-${account.id}`} className="input" style={{ maxWidth: 280 }} value={label} onChange={(e) => setLabel(e.target.value)} />
            <button className="btn btn-small" disabled={busy} type="submit">
              Save
            </button>
          </form>
        ) : (
          <strong>{account.label}</strong>
        )}
        <div className="muted" style={{ fontSize: 14 }}>
          {brand}
          {account.primary ? ' · publishes for this brand' : ''}
          {account.identity && account.identity !== account.label ? ` · ${account.identity}` : ''}
          {account.checkedAt ? ` · checked ${when(account.checkedAt)}` : ''}
        </div>
        {account.problem && <Problem text={account.problem} />}
      </div>
      <div className="row">
        {account.status === 'ok' ? <Pill tone="published">Connected</Pill> : account.status === 'failed' ? <Pill tone="failed">Not working</Pill> : <Pill tone="draft">Not checked</Pill>}
        <button className="btn btn-small" disabled={busy} onClick={() => void check()}>
          {busy ? 'Checking…' : 'Check'}
        </button>
        {!account.primary && (
          <button className="btn btn-small" disabled={busy} onClick={() => act(() => makePrimary({ data: account.id }), `${account.label} now publishes for ${brand}`)}>
            Publish with this one
          </button>
        )}
        <button className="btn btn-small" disabled={busy} onClick={() => setRenaming((r) => !r)}>
          Rename
        </button>
        <button
          className="btn btn-small btn-danger"
          disabled={busy}
          onClick={() => {
            if (window.confirm(`Disconnect ${account.label}? Its credential is deleted from the keychain.`)) void act(() => disconnect({ data: account.id }), `${account.label} disconnected`);
          }}
        >
          Disconnect
        </button>
      </div>
    </li>
  );
}

function NetworkCard({ network, brands }: { network: NetworkView; brands: Data['brands'] }) {
  const icon = channelIcon(network.channel ?? network.id) ?? channelIcon(network.id);
  const uses =
    network.auth === 'none' ? 'Drafts for you to post' : [network.channel ? 'publishes' : null, network.metrics ? 'reads numbers' : null].filter(Boolean).join(' · ');
  const failed = network.accounts.some((a) => a.status === 'failed');
  return (
    <article className={`card${failed ? ' failed' : ''}`} style={{ gridColumn: network.accounts.length > 0 ? '1 / -1' : undefined }}>
      <header>
        <h3 className="ph" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {icon && <img className="icon" src={icon} alt="" style={{ width: 28, height: 28 }} />}
          {network.name}
        </h3>
        {network.auth === 'none' ? (
          <Pill tone="manual">Drafts only</Pill>
        ) : network.accounts.length > 0 ? (
          <Pill tone={failed ? 'failed' : 'published'}>{network.accounts.length === 1 ? '1 account' : `${network.accounts.length} accounts`}</Pill>
        ) : network.usesEnv ? (
          <Pill tone="draft">From .env</Pill>
        ) : (
          <Pill tone="manual">Not connected</Pill>
        )}
      </header>
      <p className="muted">{uses}</p>
      {network.accounts.length > 0 && (
        <ul className="list">
          {network.accounts.map((a) => (
            <AccountRow key={a.id} account={a} brands={brands} />
          ))}
        </ul>
      )}
      {network.usesEnv && network.accounts.length === 0 && <p className="muted">Working from the credentials in .env. Import them to keep them in the keychain instead.</p>}
      <div className="foot">
        {network.auth === 'none' ? (
          <span className="muted" style={{ fontSize: 14 }}>
            {network.howTo}
          </span>
        ) : (
          <Link className="btn btn-small" to="/channels/$network" params={{ network: network.id }}>
            {network.accounts.length > 0 ? 'Connect another account' : 'Connect an account'}
          </Link>
        )}
      </div>
    </article>
  );
}

function Channels() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const connected = data.networks.filter((n) => n.accounts.length > 0);
  const rest = data.networks.filter((n) => n.accounts.length === 0);
  const envCount = data.networks.filter((n) => n.usesEnv).length;
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="ph">Channels</h1>
          <p>Every network Shipcast can publish to or read from, the accounts connected to each, and what they may do. Credentials are kept in {data.secretsKind}.</p>
        </div>
      </div>
      {envCount > 0 && (
        <div className="band band-yellow">
          <h2 className="ph" style={{ margin: 0 }}>
            {envCount} {envCount === 1 ? 'network still works' : 'networks still work'} from .env
          </h2>
          <p className="muted" style={{ margin: '10px 0 20px' }}>
            Importing checks each credential and moves it into the keychain as a connected account. Your .env stays as it is.
          </p>
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const results = await importEnv().catch((error: unknown) => {
                toast.fail(error instanceof Error ? error.message : String(error));
                return null;
              });
              setBusy(false);
              if (results) {
                const connected = results.filter((r) => r.ok).map((r) => r.network);
                if (connected.length > 0) toast.done(`Imported ${connected.length} from .env`, connected.join(', '));
                else if (results.length === 0) toast.done('Nothing to import');
                for (const r of results) if (!r.ok && r.problem) toast.fail(r.problem);
              }
              await router.invalidate();
            }}
          >
            {busy ? 'Importing…' : `Import ${envCount} from .env`}
          </button>
        </div>
      )}
      {connected.length > 0 && (
        <>
          <h2 className="ph">Connected</h2>
          <div className="cards">
            {connected.map((n) => (
              <NetworkCard key={n.id} network={n} brands={data.brands} />
            ))}
          </div>
        </>
      )}
      <h2 className="ph">{connected.length > 0 ? 'Add a network' : 'Networks'}</h2>
      <div className="cards">
        {rest.map((n) => (
          <NetworkCard key={n.id} network={n} brands={data.brands} />
        ))}
      </div>
    </>
  );
}
