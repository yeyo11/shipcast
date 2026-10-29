import { createFileRoute, Link, useNavigate, useRouter } from '@tanstack/react-router';
import { useLenis } from 'lenis/react';
import { useEffect, useRef, useState } from 'react';
import { NoAccounts, Pigeonholes } from '../../../components/illustrations';
import { useLiveEnabled, useLiveRoute } from '../../../components/live/Live';
import { ChannelIcon } from '../../../components/launch/Glance';
import { Empty, PageHead } from '../../../components/PageHead';
import { PageToolbar, ToolbarAction } from '../../../components/PageToolbar';
import { useToast } from '../../../components/Toasts';
import { Avatar, number, Pill, Problem, when } from '../../../components/ui';
import { ConfirmDialog } from '../../../components/ui/ConfirmButton';
import { DotsIcon, ImportIcon, PlusIcon } from '../../../components/ui/icons';
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

/**
 * The number an account's card leads with: what its network counts that matters (followers on a
 * social network, a channel's members, Reddit's karma, the newsletter's subscribers, the blog's
 * visits, search clicks), under its own name, with the network's other counts on a line below.
 * Null where the network gives nothing to read (Discord, LinkedIn): the card shows its activity only.
 */
export function keyMetric(network: string, snapshot: AccountView['snapshot']): { value: number | null; label: string; others: string | null; followers: boolean } | null {
  const extra = (snapshot?.extra ?? {}) as Record<string, number | undefined>;
  const n = (v: number | null | undefined, word: string) => (v === null || v === undefined ? null : `${number(v)} ${word}`);
  const line = (...parts: Array<string | null>) => parts.filter(Boolean).join(' · ') || null;
  switch (network) {
    case 'discord':
    case 'linkedin':
      return null;
    case 'telegram':
      return { value: snapshot?.followers ?? null, label: 'Members', others: null, followers: true };
    case 'reddit':
      return { value: extra.karma ?? null, label: 'Karma', others: line(n(snapshot?.followers, 'followers')), followers: false };
    case 'brevo':
      return { value: snapshot?.followers ?? null, label: 'Subscribers', others: null, followers: true };
    case 'cloudflare':
      return { value: extra.visits7d ?? null, label: 'Visits, last 7 days', others: null, followers: false };
    case 'searchConsole':
    case 'bingWebmaster':
      return { value: extra.clicks28d ?? null, label: 'Clicks, last 28 days', others: line(n(extra.impressions28d, 'impressions')), followers: false };
    // The account's own insights of the last day, from the daily snapshot
    case 'instagram':
      return { value: snapshot?.followers ?? null, label: 'Followers', others: line(n(snapshot?.following, 'following'), n(snapshot?.posts, 'posts'), n(extra.views1d, 'views, last day'), n(extra.reach1d, 'accounts reached, last day')), followers: true };
    case 'threads':
      return { value: snapshot?.followers ?? null, label: 'Followers', others: line(n(extra.profileViews1d, 'profile views, last day')), followers: true };
    case 'devto':
    case 'hashnode':
      return { value: snapshot?.followers ?? null, label: 'Followers', others: line(n(snapshot?.posts, 'articles')), followers: true };
    default:
      return { value: snapshot?.followers ?? null, label: 'Followers', others: line(n(snapshot?.following, 'following'), n(snapshot?.posts, 'posts')), followers: true };
  }
}

/** What Shipcast published with an account, for a network it publishes on */
function activityLine(activity: AccountView['activity']): string {
  if (activity.count === 0) return 'Nothing published with it yet';
  return `${number(activity.count)} ${activity.count === 1 ? 'piece' : 'pieces'} published by Shipcast, the last on ${(activity.last ?? '').slice(0, 10)}`;
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
  const key = keyMetric(network.id, account.snapshot);
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
      {key && (
        <dl className="lcard-stats ccard-stats">
          <div className="is-lead">
            <dt>{key.label}</dt>
            <dd title={key.value === null ? 'Not read yet: Sync now reads it' : undefined}>
              {key.value === null ? '—' : number(key.value)}
              {key.followers && account.weekChange !== null && account.weekChange !== 0 && (
                <span className={`ccard-delta${account.weekChange > 0 ? ' is-up' : ''}`}>
                  {account.weekChange > 0 ? '+' : ''}
                  {number(account.weekChange)} this week
                </span>
              )}
            </dd>
          </div>
        </dl>
      )}
      {key?.others && <p className="lcard-meta">{key.others}</p>}
      {network.channel && <p className="ccard-activity">{activityLine(account.activity)}</p>}
      <p className="lcard-meta">
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
            { kind: 'link' as const, label: 'Connect another account', href: `/channels/${network.id}` },
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
  const uses = network.ai
    ? 'AI provider, chosen per task in the AI settings'
    : [network.channel ? 'publishes' : null, network.metrics ? 'reads numbers' : null].filter(Boolean).join(' · ');
  const state = network.usesEnv ? 'From .env' : 'Not connected';
  return (
    <li className="lcard ccard ccard-add">
      <header>
        <div className="ccard-title">
          <Tile network={network} mark="off" word={state} />
          <h2>{network.name}</h2>
        </div>
        <Pill tone={network.usesEnv ? 'draft' : 'quiet'}>{state}</Pill>
      </header>
      <p className="lcard-meta">{uses}</p>
      {network.usesEnv && <p className="lcard-meta">Working from the credentials in .env. Import them to keep them in the keychain instead.</p>}
      <div className="ccard-actions">
        <Link className="btn btn-small" to="/channels/$network" params={{ network: network.id }}>
          Connect an account
        </Link>
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
  // Live (realtime-ui): an account connected, checked or removed, here or in another tab, reloads the list
  useLiveRoute(Route.id, useLiveEnabled() ? ['account'] : null);
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
  const importFromEnv = async () => {
    setBusy(true);
    const results = await importEnv().catch((error: unknown) => {
      toast.fail(error instanceof Error ? error.message : String(error));
      return null;
    });
    setBusy(false);
    if (results) {
      const imported = results.filter((r) => r.ok).map((r) => r.network);
      if (imported.length > 0) toast.done(`Imported ${imported.length} from .env`, imported.join(', '));
      else if (results.length === 0) toast.done('Nothing to import');
      for (const r of results) if (!r.ok && r.problem) toast.fail(r.problem);
    }
    await router.invalidate();
  };
  return (
    <>
      <PageHead title="Channels" art={<Pigeonholes width={200} />}>
        Every network Shipcast can publish to or read from, the accounts connected to each, and what they may do. Credentials are kept in {data.secretsKind}.
      </PageHead>
      <PageToolbar
        label="Channels"
        actions={
          <>
            {envCount > 0 && <ToolbarAction label={busy ? 'Importing…' : `Import ${envCount} from .env`} icon={<ImportIcon />} disabled={busy} onClick={importFromEnv} />}
            <Menu
              align="end"
              entries={data.networks.map((n) => ({ kind: 'link' as const, label: n.accounts.length > 0 ? `${n.name} (another account)` : n.name, href: `/channels/${n.id}` }))}
              trigger={
                <button type="button" className="btn btn-small btn-primary tb-action">
                  <PlusIcon />
                  <span className="tb-label">Connect a network</span>
                </button>
              }
            />
          </>
        }
      />
      {envCount > 0 && (
        <div className="strip strip-yellow">
          <p className="strip-text">
            <strong>
              {envCount} {envCount === 1 ? 'network still works' : 'networks still work'} from .env.
            </strong>{' '}
            Import in the bar above checks each credential and moves it into the keychain; your .env stays as it is.
          </p>
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
