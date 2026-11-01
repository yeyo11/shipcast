import { Tabs } from '@base-ui/react/tabs';
import { createFileRoute, Link, useNavigate, useRouter } from '@tanstack/react-router';
import { useLenis } from 'lenis/react';
import { useEffect, useRef, useState } from 'react';
import { AccountSheet, AddNetworkSheet, kindOf, type AccountActions, type AccountView, type ChannelsData, type NetworkView } from '../../../components/channels/sheets';
import { NetworkGlyph } from '../../../components/channels/NetworkGlyph';
import { ago, brokenLine, keyMetric, namesToConnect, shortDay, stateOf, STATE_PILL, STATE_WORD } from '../../../components/channels/view';
import { NoAccounts } from '../../../components/illustrations';
import { TopBar } from '../../../components/kit/Bars';
import { Icon } from '../../../components/kit/Icon';
import { useLiveEnabled, useLiveRoute } from '../../../components/live/Live';
import { useToast } from '../../../components/Toasts';
import { number } from '../../../components/ui';
import { disconnect, getChannels, importEnv, makePrimary, recheckAccount, renameAccount, syncAccountNow } from '../../../server/channels.functions';
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

type Target = { network: NetworkView; account: AccountView };

/** The account actions, each a toast when it ends and a fresh read of the page */
function useAccountActions(setBusy: (id: number | null) => void): AccountActions {
  const router = useRouter();
  const toast = useToast();
  const act = async (account: AccountView, fn: () => Promise<unknown>, done?: string): Promise<boolean> => {
    setBusy(account.id);
    try {
      await fn();
      if (done) toast.done(done);
      await router.invalidate();
      return true;
    } catch (error) {
      toast.fail(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy(null);
    }
  };
  return {
    sync: async (account) => {
      await act(account, async () => {
        const result = await syncAccountNow({ data: account.id });
        const details = result.lines.join('\n') || undefined;
        if (result.state === 'completed') toast.done(`${account.label} synced`, details);
        else if (result.state === 'failed') toast.fail(result.lines[0] ?? `${account.label} could not be synced`);
        else toast.done(`Syncing ${account.label}`, 'It is still running: reload the page in a minute to see it.');
      });
    },
    check: async (account) => {
      await act(account, async () => {
        const result = await recheckAccount({ data: account.id });
        if (result.status === 'ok') toast.done(`${account.label} works`, result.identity ? `Signed in as ${result.identity}.` : undefined);
        else toast.fail(result.problem ?? `${account.label} did not answer its check`);
      });
    },
    rename: (account, label) => act(account, () => renameAccount({ data: { id: account.id, label } }), `Renamed to ${label}`),
    makePrimary: async (account) => {
      await act(account, () => makePrimary({ data: account.id }), `${account.label} now publishes for its brand`);
    },
    disconnect: async (account) => {
      await act(account, () => disconnect({ data: account.id }), `${account.label} disconnected`);
    },
  };
}

/**
 * One account's card (boards Channels and DesktopChannels). One markup for both shapes: on a phone
 * the network leads and a broken account says what it stops; on a desktop the account leads, the
 * number grows and the actions sit beside it.
 */
function AccountCard({ network, account, now, siblings, busy, onMore, onSync }: { network: NetworkView; account: AccountView; now: string; siblings: number; busy: boolean; onMore: () => void; onSync: () => void }) {
  const state = stateOf(account.status);
  const failed = state === 'failed';
  const key = keyMetric(network.id, account.snapshot);
  const synced = account.syncedAt ? `Synced ${ago(account.syncedAt, now)}` : 'Never synced';
  const sub = [account.syncedAt ? synced : 'Never synced', siblings > 1 && account.primary ? 'publishes for this brand' : null].filter(Boolean).join(' · ');
  const label = key && [failed && account.syncedAt ? `${key.label}, last read ${shortDay(account.syncedAt)}` : key.label, failed ? null : key.others].filter(Boolean).join(' · ');
  const activity = account.activity.count === 0 ? 'Nothing published with it yet' : `${number(account.activity.count)} ${account.activity.count === 1 ? 'piece' : 'pieces'} published by Shipcast`;
  return (
    <li id={`account-${account.id}`} tabIndex={-1} className={`k-card ch-card${failed ? ' k-fail is-failed' : ''}`}>
      <div className="k-hrow k-g10">
        <span className={`k-ic${failed ? ' ch-ic-fail' : ''}`}>
          <NetworkGlyph network={network} />
        </span>
        <div className="k-grow k-stack">
          <strong className="ch-ph k-ellipsis">{network.name}</strong>
          <strong className="ch-dt k-ellipsis">{account.label}</strong>
          <span className="k-xs k-muted k-ellipsis ch-ph">{account.label}</span>
          {failed ? (
            <span className="k-xs ch-dt ch-bad k-ellipsis">◆ {account.problem ?? 'Its last check failed'}</span>
          ) : (
            <span className={`k-xs k-muted k-ellipsis ch-dt${account.stale ? ' ch-stale' : ''}`}>{sub}</span>
          )}
        </div>
        <span className={`k-pill ${STATE_PILL[state]}`}>{STATE_WORD[state]}</span>
      </div>
      {failed && <p className="k-sm ch-flush ch-ph">{brokenLine(network, account.problem)}</p>}
      <div className="ch-body">
        <div className="k-stack ch-num">
          {key ? (
            <>
              <span className="k-d ch-big" title={key.value === null ? 'Not read yet: Sync now reads it' : undefined}>
                {key.value === null ? '—' : number(key.value)}
              </span>
              <span className="k-xs k-muted">{label}</span>
            </>
          ) : (
            <span className="k-sm k-muted">{network.channel ? activity : 'Nothing to count on this network'}</span>
          )}
        </div>
        <span className={`k-xs k-muted ch-synced${account.stale ? ' ch-stale' : ''}`} title={account.stale ? 'Not synced for over 36 hours' : undefined}>
          {synced}
        </span>
        <div className="k-hrow k-g8 ch-actions">
          {failed ? (
            <Link className="k-btn k-sm" to="/channels/$network" params={{ network: network.id }}>
              Reconnect
            </Link>
          ) : (
            <button type="button" className="k-btn k-sm" disabled={busy} onClick={onSync}>
              <Icon name="retry" size={18} />
              {busy ? 'Syncing…' : 'Sync now'}
            </button>
          )}
          <button type="button" className="k-btn k-icon k-sm" aria-label={`More for ${account.label}`} aria-haspopup="menu" onClick={onMore}>
            <Icon name="more" />
          </button>
        </div>
      </div>
    </li>
  );
}

function ConnectAnother({ names, onOpen }: { names: string[]; onOpen: () => void }) {
  return (
    <button type="button" className="k-card k-quiet ch-another" onClick={onOpen}>
      <span className="k-ic">
        <Icon name="plus" />
      </span>
      <span className="k-grow ch-another-text">
        <strong>Connect another network</strong>
        <span className="k-muted">
          <span className="ch-dt"> · </span>
          {namesToConnect(names)}
        </span>
      </span>
    </button>
  );
}

function ImportNotice({ count, busy, onImport }: { count: number; busy: boolean; onImport: () => void }) {
  return (
    <div className="k-notice k-wait ch-notice">
      <span className="ch-notice-icon">
        <Icon name="download" size={18} />
      </span>
      <div className="k-grow">
        <strong>
          {count} {count === 1 ? 'credential' : 'credentials'} in .env.
        </strong>{' '}
        Import {count === 1 ? 'it' : 'them'} to keep {count === 1 ? 'it' : 'them'} in the keychain instead.{' '}
        <button type="button" className="ch-link" disabled={busy} onClick={onImport}>
          {busy ? 'Importing…' : `Import ${count} from .env`}
        </button>
      </div>
    </div>
  );
}

function Channels() {
  const data = Route.useLoaderData();
  // Live: an account connected, checked or removed, here or in another tab, reloads the list
  useLiveRoute(Route.id, useLiveEnabled() ? ['account'] : null);
  const router = useRouter();
  const toast = useToast();
  const navigate = useNavigate();
  const search = Route.useSearch();
  // Read through a ref: Lenis starting up must not run the arrival effect, and its toast, twice
  const smooth = useLenis();
  const lenis = useRef(smooth);
  lenis.current = smooth;
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [target, setTarget] = useState<Target | null>(null);
  const [view, setView] = useState<'menu' | 'rename' | 'disconnect'>('menu');
  const actions = useAccountActions(setBusy);
  const open = (t: Target) => {
    setView('menu');
    setTarget(t);
  };
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
    setImporting(true);
    const results = await importEnv().catch((error: unknown) => {
      toast.fail(error instanceof Error ? error.message : String(error));
      return null;
    });
    setImporting(false);
    if (results) {
      const imported = results.filter((r) => r.ok).map((r) => r.network);
      if (imported.length > 0) toast.done(`Imported ${imported.length} from .env`, imported.join(', '));
      else if (results.length === 0) toast.done('Nothing to import');
      for (const r of results) if (!r.ok && r.problem) toast.fail(r.problem);
    }
    await router.invalidate();
  };
  const sheets = (
    <>
      <AddNetworkSheet networks={data.networks} open={adding} onOpenChange={setAdding} initialKind={kindOf(tab)} />
      <AccountSheet target={target} view={view} onViewChange={setView} onClose={() => setTarget(null)} actions={actions} busy={busy !== null} />
    </>
  );
  const connectButton = (
    <button type="button" className="k-btn ch-connect" onClick={() => setAdding(true)}>
      <Icon name="plus" size={18} />
      <span className="ch-ph">Connect</span>
      <span className="ch-dt">Connect a network</span>
    </button>
  );

  if (connected.length === 0)
    return (
      <>
        <TopBar back={{ label: 'More', more: true }} />
        <div className="k-page ch-page">
          <div className="k-px ch-head">
            <div className="k-stack k-g12">
              <h1 className="k-d ch-title">Channels</h1>
              <p className="k-lead k-muted ch-flush ch-dt">Where your launches go, and how each account grows.</p>
            </div>
          </div>
          <div className="k-px k-stack k-g16 ch-empty">
            <div className="ch-empty-art" aria-hidden="true">
              <NoAccounts width="100%" />
            </div>
            <h2 className="k-d k-d30">No accounts yet</h2>
            <p className="k-muted ch-flush ch-empty-text">Nothing is connected, so a launch only makes drafts. Connect a network and Shipcast publishes there with your approval.</p>
            <div className="k-stack k-g10 ch-empty-actions">
              <button type="button" className="k-btn k-pri k-full" onClick={() => setAdding(true)}>
                <Icon name="plus" size={18} />
                Connect a network
              </button>
            </div>
            {envCount > 0 && <ImportNotice count={envCount} busy={importing} onImport={() => void importFromEnv()} />}
          </div>
        </div>
        {sheets}
      </>
    );

  return (
    <>
      <TopBar back={{ label: 'More', more: true }} />
      <div className="k-page ch-page">
        <div className="k-px k-hrow k-between ch-head">
          <div className="k-stack k-g12">
            <h1 className="k-d ch-title">Channels</h1>
            <p className="k-lead k-muted ch-flush ch-dt">Where your launches go, and how each account grows.</p>
          </div>
          {connectButton}
        </div>
        <Tabs.Root value={tab} onValueChange={(next) => void navigate({ to: '/channels', search: { tab: next as NetworkGroup }, resetScroll: false })}>
          <div className="ch-tabs-wrap">
            <Tabs.List className="k-tabs ch-tabs" aria-label="Kinds of channel" activateOnFocus>
              {NETWORK_GROUPS.map((g) => {
                const count = data.networks.filter((n) => groupOf(n) === g.id).reduce((sum, n) => sum + n.accounts.length, 0);
                return (
                  <Tabs.Tab key={g.id} value={g.id} className={(s) => `k-tab${s.active ? ' k-on' : ''}`}>
                    <span className="ch-ph">{g.short}</span>
                    <span className="ch-dt">{g.name}</span>
                    {count > 0 && (
                      <span className="k-n" aria-label={`, ${count} connected`}>
                        {count}
                      </span>
                    )}
                  </Tabs.Tab>
                );
              })}
            </Tabs.List>
          </div>
          {NETWORK_GROUPS.map((g) => {
            const networks = data.networks.filter((n) => groupOf(n) === g.id);
            const withAccounts = networks.filter((n) => n.accounts.length > 0);
            const rest = networks.filter((n) => n.accounts.length === 0);
            return (
              <Tabs.Panel key={g.id} value={g.id} className="k-px ch-panel">
                {envCount > 0 && <ImportNotice count={envCount} busy={importing} onImport={() => void importFromEnv()} />}
                {withAccounts.length > 0 ? (
                  <ul className="ch-cards" aria-label={`${g.name}: connected accounts`}>
                    {withAccounts
                      .flatMap((n) => n.accounts.map((a) => ({ n, a })))
                      // What needs the owner first: a broken account leads its tab
                      .sort((x, y) => Number(stateOf(y.a.status) === 'failed') - Number(stateOf(x.a.status) === 'failed'))
                      .map(({ n, a }) => (
                        <AccountCard
                          key={a.id}
                          network={n}
                          account={a}
                          now={data.now}
                          siblings={n.accounts.length}
                          busy={busy === a.id}
                          onMore={() => open({ network: n, account: a })}
                          onSync={() => void actions.sync(a)}
                        />
                      ))}
                  </ul>
                ) : (
                  <p className="k-muted ch-flush">Nothing connected here yet.</p>
                )}
                <ConnectAnother names={rest.map((n) => n.name)} onOpen={() => setAdding(true)} />
              </Tabs.Panel>
            );
          })}
        </Tabs.Root>
      </div>
      {sheets}
    </>
  );
}
