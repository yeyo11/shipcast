import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { groupOf, type NetworkGroup } from '../../server/network-groups';
import { Diamond, Icon } from '../kit/Icon';
import { Overlay } from '../kit/Overlay';
import type { getChannels } from '../../server/channels.functions';
import { NetworkGlyph } from './NetworkGlyph';
import { credentialWord, stateOf, STATE_WORD } from './view';

export type ChannelsData = Awaited<ReturnType<typeof getChannels>>;
export type NetworkView = ChannelsData['networks'][number];
export type AccountView = NetworkView['accounts'][number];

/** What a network's tile says under its name: how its accounts stand, or that it can be connected */
function tileWord(network: NetworkView): { word: string; connected: boolean } {
  if (network.accounts.length === 0) return { word: network.usesEnv ? 'From .env' : 'Connect', connected: false };
  const failed = network.accounts.some((a) => stateOf(a.status) === 'failed');
  return { word: failed ? STATE_WORD.failed : STATE_WORD.ok, connected: true };
}

/** The sheet's kinds: where posts and articles go together, then what only reads numbers, then the AI */
const KINDS = [
  { id: 'publish', name: 'Where posts go', groups: ['social', 'blog'] },
  { id: 'measurement', name: 'Measurement', groups: ['measurement'] },
  { id: 'ai', name: 'AI providers', groups: ['ai'] },
] as const satisfies ReadonlyArray<{ id: string; name: string; groups: readonly NetworkGroup[] }>;

type Kind = (typeof KINDS)[number]['id'];

export const kindOf = (group: NetworkGroup): Kind => (group === 'measurement' || group === 'ai' ? group : 'publish');

/**
 * Connect a network (board AddNetwork): the networks of one kind as tiles, their state under their
 * names (the tab it was opened from says which; the others are a tap away). A connected network
 * is open too: it takes another account.
 */
export function AddNetworkSheet({ networks, open, onOpenChange, initialKind }: { networks: readonly NetworkView[]; open: boolean; onOpenChange: (open: boolean) => void; initialKind: Kind }) {
  const [kind, setKind] = useState<Kind>(initialKind);
  useEffect(() => {
    if (open) setKind(initialKind);
  }, [open, initialKind]);
  const current = KINDS.find((k) => k.id === kind) ?? KINDS[0];
  const shown = networks.filter((n) => (current.groups as readonly NetworkGroup[]).includes(groupOf(n)));
  return (
    <Overlay kind="drawer" label="Connect a network" heading="Connect a network" open={open} onOpenChange={onOpenChange} className="ch-sheet">
      <p className="k-sm k-muted ch-flush">Pick one. A connected network can take another account.</p>
      <ul className="ch-tiles" aria-label={current.name}>
        {shown.map((n) => {
          const { word, connected } = tileWord(n);
          return (
            <li key={n.id}>
              <Link to="/channels/$network" params={{ network: n.id }} className={`ch-tile${connected ? ' is-connected' : ''}`} onClick={() => onOpenChange(false)}>
                <NetworkGlyph network={n} size={26} />
                <span className="k-xs ch-tile-name">{n.name}</span>
                <span className="k-muted ch-tile-word">{word}</span>
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="k-chips" role="group" aria-label="Other kinds of network">
        {KINDS.filter((k) => k.id !== kind).map((k) => (
          <button key={k.id} type="button" className="k-chip" onClick={() => setKind(k.id)}>
            {k.name}
          </button>
        ))}
      </div>
    </Overlay>
  );
}

export interface AccountActions {
  sync: (account: AccountView) => Promise<void>;
  check: (account: AccountView) => Promise<void>;
  rename: (account: AccountView, label: string) => Promise<boolean>;
  makePrimary: (account: AccountView) => Promise<void>;
  disconnect: (account: AccountView) => Promise<void>;
}

/**
 * An account's actions (board AccountMenu) and, from Disconnect, the confirmation (board
 * Disconnect) in the same sheet: the owner's thumb stays where it was.
 */
export function AccountSheet({
  target,
  view,
  onViewChange,
  onClose,
  actions,
  busy,
}: {
  target: { network: NetworkView; account: AccountView } | null;
  view: 'menu' | 'rename' | 'disconnect';
  onViewChange: (view: 'menu' | 'rename' | 'disconnect') => void;
  onClose: () => void;
  actions: AccountActions;
  busy: boolean;
}) {
  const [label, setLabel] = useState('');
  useEffect(() => {
    if (target) setLabel(target.account.label);
  }, [target]);
  const close = () => onClose();
  // Switched after the click has finished: the sheet's outside-press check would otherwise find its
  // target already gone from the sheet and close it
  const go = (next: 'menu' | 'rename' | 'disconnect') => setTimeout(() => onViewChange(next), 0);
  const run = (fn: () => Promise<unknown>) => {
    close();
    void fn();
  };
  return (
    <Overlay kind={view === 'menu' ? 'menu' : 'dialog'} label={target ? (view === 'disconnect' ? `Disconnect ${target.account.label}?` : target.account.label) : 'Account'} open={target !== null} onOpenChange={(o) => !o && close()} className="ch-sheet">
      {target && view === 'disconnect' && (
        <>
          <h2 className="k-d k-d30">Disconnect {target.account.label}?</h2>
          <p className="ch-flush">Its credential is deleted from the keychain and it stops publishing and reading numbers.</p>
          <p className="k-sm k-muted ch-flush">
            {target.network.channel ? `Its posts stay on ${target.network.name}. ` : ''}Connecting it again needs {credentialWord(target.network)}.
          </p>
          <div className="k-hrow k-g10">
            <button type="button" className="k-btn" onClick={close}>
              Keep it
            </button>
            <button type="button" className="k-btn k-danger k-grow" disabled={busy} onClick={() => run(() => actions.disconnect(target.account))}>
              Disconnect
            </button>
          </div>
        </>
      )}
      {target && view === 'rename' && (
        <form
          className="k-stack k-g16"
          onSubmit={(e) => {
            e.preventDefault();
            void actions.rename(target.account, label).then((ok) => ok && close());
          }}
        >
          <h2 className="k-d k-d30">Rename</h2>
          <label className="k-field">
            <span className="k-lbl">Name</span>
            <input className="k-input ch-input" value={label} onChange={(e) => setLabel(e.target.value)} autoComplete="off" required />
            <span className="k-help">How Shipcast names this {target.network.name} account; the network keeps its own.</span>
          </label>
          <div className="k-hrow k-g10">
            <button type="button" className="k-btn" onClick={() => go('menu')}>
              Back
            </button>
            <button type="submit" className="k-btn k-pri k-grow" disabled={busy || !label.trim()}>
              Save the name
            </button>
          </div>
        </form>
      )}
      {target && view === 'menu' && (
        <>
          <div className="k-hrow k-g10 ch-sheet-who">
            <NetworkGlyph network={target.network} size={22} />
            <strong>{target.account.label}</strong>
          </div>
          <div className="k-stack" role="menu" aria-label={`${target.account.label}: actions`}>
            <button type="button" role="menuitem" className="k-mi" onClick={() => run(() => actions.sync(target.account))}>
              <Icon name="retry" />
              Sync now
            </button>
            <button type="button" role="menuitem" className="k-mi" onClick={() => run(() => actions.check(target.account))}>
              <Icon name="check" />
              Check the credential
            </button>
            <button type="button" role="menuitem" className="k-mi" onClick={() => go('rename')}>
              <Icon name="write" />
              Rename
            </button>
            {!target.account.primary && (
              <button type="button" role="menuitem" className="k-mi" onClick={() => run(() => actions.makePrimary(target.account))}>
                <Icon name="send" />
                Publish with this one
              </button>
            )}
            <Link role="menuitem" className="k-mi" to="/channels/$network" params={{ network: target.network.id }} onClick={close}>
              <Icon name="plus" />
              Connect another account
            </Link>
            <div className="k-sep" role="separator" />
            <button type="button" role="menuitem" className="k-mi k-bad" onClick={() => go('disconnect')}>
              <span className="ch-mi-diamond">
                <Diamond size={10} />
              </span>
              Disconnect
            </button>
          </div>
          <button type="button" className="k-btn k-full k-sheet-only" onClick={close}>
            Close
          </button>
        </>
      )}
    </Overlay>
  );
}
