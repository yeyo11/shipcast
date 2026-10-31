import { useState } from 'react';
import { Icon } from '../kit/Icon';
import { Sheet } from '../kit/Sheet';
import type { PieceRow } from '../../server/pieces';
import { channelTitle } from './ChannelGlyph';
import { listWords, unpublishGroups } from './published';

/** A tick in the board's shape over a real checkbox, so the keyboard and screen readers get one */
export function Tick({ checked, disabled, onChange, label }: { checked: boolean; disabled?: boolean; onChange: (on: boolean) => void; label?: string }) {
  return (
    <span className={`k-check pub-tick${checked ? ' k-on' : ''}${disabled ? ' pub-tick-off' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
      {checked && <Icon name="check" size={16} strokeWidth={3} />}
    </span>
  );
}

/**
 * Taking down what a launch published (board Unpublish): every channel whose network lets it go,
 * ticked (or the ones the owner ticked on the page), and one count on the button. What a network
 * cannot delete is not offered; dev.to's articles are unpublished instead.
 */
export function UnpublishSheet({
  name,
  rows,
  preselect,
  onClose,
  onConfirm,
}: {
  /** The launch as the owner says it: `Claudio v1.5.0` */
  name: string;
  rows: readonly PieceRow[];
  /** Channels ticked on the page; all of them when none */
  preselect: readonly string[];
  onClose: () => void;
  onConfirm: (pieces: PieceRow[]) => Promise<void>;
}) {
  const groups = unpublishGroups(rows);
  const start = groups.filter((g) => preselect.length === 0 || preselect.includes(g.channel)).map((g) => g.channel);
  const [ticked, setTicked] = useState<string[]>(start.length > 0 ? start : groups.map((g) => g.channel));
  const [busy, setBusy] = useState(false);
  const chosen = groups.filter((g) => ticked.includes(g.channel)).flatMap((g) => g.pieces);
  const names = groups.map((g) => (g.channel === 'blog' ? 'the article' : channelTitle(g.channel)));
  return (
    <Sheet label="Delete everything it published?" open onOpenChange={(open) => !open && !busy && onClose()}>
      <h2 className="k-d k-d30">Delete everything it published?</h2>
      {groups.length === 0 ? (
        <p className="pub-flush">Nothing of {name} is out on a network that lets it go.</p>
      ) : (
        <p className="pub-flush">
          {name} comes off every network that allows it: {listWords(names)}.
        </p>
      )}
      <p className="k-sm k-muted pub-flush">What a network cannot delete stays. A launch happens once: none of it is published again.</p>
      {groups.length > 0 && (
        <fieldset className="k-stack pub-fieldset">
          <legend className="visually-hidden">Channels to take it off</legend>
          {groups.map((g) => (
            <label key={g.channel} className="k-row pub-pick">
              <Tick checked={ticked.includes(g.channel)} onChange={(on) => setTicked(on ? [...ticked, g.channel] : ticked.filter((c) => c !== g.channel))} />
              <span className="k-grow">
                {channelTitle(g.channel)}
                {g.note && (
                  <>
                    <br />
                    <span className="k-xs k-muted">{g.note}</span>
                  </>
                )}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <div className="k-hrow k-g10">
        <button type="button" className="k-btn" onClick={onClose} disabled={busy}>
          Keep it
        </button>
        <button
          type="button"
          className="k-btn k-danger pub-fill"
          disabled={chosen.length === 0 || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm(chosen);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Unpublishing…' : `Unpublish ${chosen.length} ${chosen.length === 1 ? 'piece' : 'pieces'}`}
        </button>
      </div>
    </Sheet>
  );
}
