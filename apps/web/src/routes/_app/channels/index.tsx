import { createFileRoute, Link, useNavigate, useRouter } from '@tanstack/react-router';
import { useLenis } from 'lenis/react';
import { useEffect, useRef, useState } from 'react';
import { NoAccounts, Pigeonholes } from '../../../components/illustrations';
import { ChannelIcon } from '../../../components/launch/Glance';
import { Empty, PageHead } from '../../../components/PageHead';
import { useToast } from '../../../components/Toasts';
import { Avatar, number, Pill, Problem, when } from '../../../components/ui';
import { ConfirmDialog } from '../../../components/ui/ConfirmButton';
import { DotsIcon } from '../../../components/ui/icons';
import { Menu } from '../../../components/ui/Menu';
import { Tabs } from '../../../components/ui/Tabs';
import { disconnect, getChannels, importEnv, makePrimary, recheckAccount, renameAccount, syncAccountNow } from '../../../server/channels.functions';
import type { Mark } from '../../../server/launch-summary';
import { groupOf, NETWORK_GROUPS, readGroup, type NetworkGroup } from '../../../server/network-groups';

export const Route = createFileRoute('/_app/channels/')({
  validateSearch: (search: Record<string, unknown>): { connected?: string; focus?: string; tab?: NetworkGroup } => ({
    ...(typeof search.connected === 'string' ? { connected: search.connected } : {}),
    ...(typeof search.focus === 'string' && /^\d+$/.test(search.focus) ? { focus: search.focus } : {}),
    ...(readGroup(search.tab) ? { tab: readGroup(search.tab) } : {}),
  }),
  head: () => ({ meta: [{ title: 'Channels · Shipcast' }] }),
  loader: () => getChannels(),
  component: Channels,
});

type Data = Awaited<ReturnType<typeof getChannels>>;
type NetworkView = Data['networks'][number];
type AccountView = NetworkView['accounts'][number];

/** The key number of an account: what its network counts most, with the other counts as a line under it */
function keyNumber(snapshot: AccountView['snapshot']): { value: number | null; label: string; others: string | null } {
  if (!snapshot) return { value: null, label: 'Followers', others: null };
  const others = [snapshot.following !== null ? `${number(snapshot.following)} following` : null, snapshot.posts !== null ? `${number(snapshot.posts)} posts` : null].filter(Boolean).join(' · ');
  return { value: snapshot.followers, label: 'Followers', others: others || null };
}

/** The card's dot: green when its check passed, red when it failed, the dotted ring while it is unchecked */
const markOf = (status: AccountView['status'] | undefined): Mark => (status === 'ok' ? 'published' : status === 'failed' ? 'failed' : 'off');

/** The glyph tile of a channel card: the network's glyph with its state dot, as on a launch card */
function Tile({ network, mark, word }: { network: NetworkView; mark: Mark; word: string }) {
  return (
    <span className={`mark m-${mark}`} role="img" aria-label={`${network.name}: ${word}`}>
      <ChannelIcon channel={network.channel ?? network.id} size={18} />
      <span className={`dot d-${mark}`} aria-hidden="true">
        <i />
      </span>
    </span>
  );
}

function AccountCard({ network, account, brands }: { network: NetworkView; account: AccountView; brands: Data['brands'] }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [leaving, setLeaving] = useState(false);
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
  const sync = () =>
    act(async () => {
      const result = await syncAccountNow({ data: account.id });
      const details = result.lines.join('\n') || undefined;
      if (result.state === 'completed') toast.done(`${account.label} synced`, details);
      else if (result.state === 'failed') toast.fail(result.lines[0] ?? `${account.label} could not be synced`);
      else toast.done(`Syncing ${account.label}`, 'It is still running: reload the page in a minute to see it.');
    });
  const brand = brands.find((b) => b.id === account.brand)?.name ?? account.brand;
  const key = keyNumber(account.snapshot);
  const status = account.status === 'ok' ? 'Connected' : account.status === 'failed' ? 'Not working' : 'Not checked';
  return (
    <li id={`account-${account.id}`} tabIndex={-1} className={`lcard ccard${account.status === 'failed' ? ' is-failed' : ''}`}>
      <header>
        <div className="ccard-title">
          <Tile network={network} mark={markOf(account.status)} word={status} />
          <h2>{network.name}</h2>
        </div>
        <Pill tone={account.status === 'ok' ? 'published' : account.status === 'failed' ? 'failed' : 'draft'}>{status}</Pill>
      </header>
      <div className="ccard-who">
        <Avatar src={account.avatarUrl} alt="" size={40} />
        <div className="ccard-name">
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
              <input id={`label-${account.id}`} className="input" style={{ maxWidth: 240 }} value={label} onChange={(e) => setLabel(e.target.value)} />
              <button className="btn btn-small" disabled={busy} type="submit">
                Save
              </button>
            </form>
          ) : (
            <strong>{account.label}</strong>
          )}
          <p className="lcard-meta">
            {account.identity && account.identity !== account.label ? `${account.identity} · ` : ''}
            {brand}
            {account.primary ? ' · publishes for this brand' : ''}
          </p>
        </div>
      </div>
      <dl className="lcard-stats ccard-stats">
        <div className="is-lead">
          <dt>{key.label}</dt>
          <dd title={key.value === null ? 'This network does not count it' : undefined}>{key.value === null ? '—' : number(key.value)}</dd>
        </div>
      </dl>
      <p className="lcard-meta">
        {key.others ? `${key.others} · ` : ''}
        {account.syncedAt ? `synced ${when(account.syncedAt)}` : 'never synced'}
        {account.stale && <span className="stale"> · not synced for over 36 hours</span>}
      </p>
      {account.problem && <Problem text={account.problem} />}
      <div className="ccard-actions">
        <button className="btn btn-small" disabled={busy} onClick={() => void sync()}>
          {busy ? 'Working…' : 'Sync now'}
        </button>
        <Menu
          trigger={
            <button type="button" className="btn btn-small" disabled={busy} aria-label={`More for ${account.label}`}>
              <DotsIcon />
            </button>
          }
          entries={[
            { label: 'Check the credential', onSelect: () => void check() },
            ...(account.primary ? [] : [{ label: 'Publish with this one', onSelect: () => void act(() => makePrimary({ data: account.id }), `${account.label} now publishes for ${brand}`) }]),
            { label: renaming ? 'Stop renaming' : 'Rename', onSelect: () => setRenaming((r) => !r) },
            ...(network.auth === 'none' ? [] : [{ kind: 'link' as const, label: 'Connect another account', href: `/channels/${network.id}` }]),
            { kind: 'separator' as const },
            { label: 'Disconnect', tone: 'danger' as const, onSelect: () => setLeaving(true) },
          ]}
        />
      </div>
      <ConfirmDialog
        open={leaving}
        onOpenChange={setLeaving}
        title={`Disconnect ${account.label}?`}
        description="Its credential is deleted from the keychain and it stops publishing and reading numbers. Connecting it again needs a new credential."
        confirm="Disconnect"
        onConfirm={() => act(() => disconnect({ data: account.id }), `${account.label} disconnected`)}
      />
    </li>
  );
}

/** A network with no account yet: what it does and how to connect it */
function NetworkCard({ network }: { network: NetworkView }) {
  const uses =
    network.auth === 'none'
      ? 'Drafts for you to post'
      : network.ai
        ? 'AI provider, chosen per task in the AI settings'
        : [network.channel ? 'publishes' : null, network.metrics ? 'reads numbers' : null].filter(Boolean).join(' · ');
  const state = network.auth === 'none' ? 'Drafts only' : network.usesEnv ? 'From .env' : 'Not connected';
  return (
    <li className="lcard ccard ccard-add">
      <header>
        <div className="ccard-title">
          <Tile network={network} mark="off" word={state} />
          <h2>{network.name}</h2>
        </div>
        <Pill tone={network.usesEnv ? 'draft' : 'manual'}>{state}</Pill>
      </header>
      <p className="lcard-meta">{uses}</p>
      {network.usesEnv && <p className="lcard-meta">Working from the credentials in .env. Import them to keep them in the keychain instead.</p>}
      <div className="ccard-actions">
        {network.auth === 'none' ? (
          <span className="lcard-meta">{network.howTo}</span>
        ) : (
          <Link className="btn btn-small" to="/channels/$network" params={{ network: network.id }}>
            Connect an account
          </Link>
        )}
      </div>
    </li>
  );
}

function Group({ networks, brands }: { networks: NetworkView[]; brands: Data['brands'] }) {
  const connected = networks.filter((n) => n.accounts.length > 0);
  const rest = networks.filter((n) => n.accounts.length === 0);
  return (
    <>
      {connected.length > 0 && (
        <>
          <h2 className="ph">Connected</h2>
          <ul className="ccards" aria-label="Connected accounts">
            {connected.flatMap((n) => n.accounts.map((a) => <AccountCard key={a.id} network={n} account={a} brands={brands} />))}
          </ul>
        </>
      )}
      {rest.length > 0 && (
        <>
          <h2 className="ph" id="add" tabIndex={-1}>
            {connected.length > 0 ? 'Add a network' : 'Networks'}
          </h2>
          <ul className="ccards" aria-label="Networks to connect">
            {rest.map((n) => (
              <NetworkCard key={n.id} network={n} />
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function Channels() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const toast = useToast();
  const navigate = useNavigate();
  const search = Route.useSearch();
  // Read through a ref: Lenis starting up must not run the arrival effect, and its toast, twice
  const smooth = useLenis();
  const lenis = useRef(smooth);
  lenis.current = smooth;
  const [busy, setBusy] = useState(false);
  // The tab in the address; a new account's arrival opens the tab its network is in
  const focused = search.focus ? data.networks.find((n) => n.accounts.some((a) => String(a.id) === search.focus)) : undefined;
  const tab: NetworkGroup = search.tab ?? (focused ? groupOf(focused) : (NETWORK_GROUPS.find((g) => data.networks.some((n) => groupOf(n) === g.id && n.accounts.length > 0))?.id ?? 'social'));
  // Just connected: say so, then bring the new account into view and give it the focus
  useEffect(() => {
    if (!search.connected && !search.focus) return;
    if (search.connected) toast.done(search.connected, 'It is checked and ready to publish.');
    const focus = search.focus;
    // Clearing the address is a navigation, which would scroll back to the top: scroll after it
    void navigate({ to: '/channels', search: { tab }, replace: true, resetScroll: false }).then(() => {
      const row = focus ? document.getElementById(`account-${focus}`) : null;
      if (!row) return;
      // With smooth scrolling on, Lenis owns the scroll position; without it, the browser's own scroll
      if (lenis.current) lenis.current.scrollTo(row, { offset: -(window.innerHeight - row.offsetHeight) / 2 });
      else row.scrollIntoView({ block: 'center' });
      row.focus({ preventScroll: true });
    });
  }, [search.connected, search.focus, tab, navigate, toast]);
  const connected = data.networks.filter((n) => n.accounts.length > 0);
  const envCount = data.networks.filter((n) => n.usesEnv).length;
  return (
    <>
      <PageHead title="Channels" art={<Pigeonholes width={200} />}>
        Every network Shipcast can publish to or read from, the accounts connected to each, and what they may do. Credentials are kept in {data.secretsKind}.
      </PageHead>
      {envCount > 0 && (
        <div className="strip strip-yellow">
          <p className="strip-text">
            <strong>
              {envCount} {envCount === 1 ? 'network still works' : 'networks still work'} from .env.
            </strong>{' '}
            Importing checks each credential and moves it into the keychain; your .env stays as it is.
          </p>
          <button
            className="btn btn-primary btn-small"
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
      {connected.length === 0 && (
        <Empty art={<NoAccounts width={280} />} title="No accounts yet">
          Nothing is connected, so a launch only makes drafts. Connect a network below and Shipcast publishes there with your approval.
        </Empty>
      )}
      <Tabs<NetworkGroup>
        label="Kinds of channel"
        variant="underline"
        value={tab}
        onValueChange={(next) => void navigate({ to: '/channels', search: { tab: next }, resetScroll: false })}
        tabs={NETWORK_GROUPS.map((g) => {
          const networks = data.networks.filter((n) => groupOf(n) === g.id);
          const count = networks.reduce((sum, n) => sum + n.accounts.length, 0);
          return {
            value: g.id,
            label: (
              <>
                {g.name}
                {count > 0 && <span className="ui-tab-count"> {count}</span>}
              </>
            ),
            panel: <Group networks={networks} brands={data.brands} />,
          };
        })}
      />
    </>
  );
}
