import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { countOf, type AttentionItem } from '../server/attention';
import { clearAttention, dismissAttention } from '../server/attention.functions';
import { Icon } from './kit/Icon';
import { Sheet } from './kit/Sheet';
import { useShell } from './kit/shell';
import { AttentionLink, AttentionMark, Subject } from './LaunchRows';

/**
 * What needs the owner (board Notifications), opened by the bars' bell: a line per thing with its
 * mark, its words and the link to act on it, in the bottom sheet. Each line can be dismissed (its ×,
 * or Delete on its link) and the sheet cleared at once; the registry keeps the dismissals, so they
 * hold on every device until the condition behind a line changes. The scheduled posts only inform:
 * they are not counted and not dismissed. The shell reads the list (kit/shell.tsx); it is read again
 * when the sheet opens.
 */
export function Notifications() {
  const { attention, setAttention, reloadAttention: load, notificationsOpen: open, setNotificationsOpen: setOpen } = useShell();
  const [said, setSaid] = useState('');
  const panel = useRef<HTMLDivElement>(null);
  /** Where focus goes once a dismissed line has left the list: the line now at that place */
  const focusAt = useRef<number | null>(null);

  useEffect(() => {
    if (open) void load();
    else setSaid('');
  }, [open, load]);

  const items = attention?.items ?? [];
  const counted = items.filter((i) => i.kind !== 'scheduled');
  const scheduled = items.some((i) => i.kind === 'scheduled');

  // The focused line (or its ×) is gone: focus the next line, the last one, or the empty sheet,
  // never the page behind it
  useEffect(() => {
    const at = focusAt.current;
    if (at === null || !panel.current) return;
    focusAt.current = null;
    const links = panel.current.querySelectorAll<HTMLElement>('.home-bell-link');
    (links[Math.min(at, links.length - 1)] ?? panel.current.querySelector<HTMLElement>('.home-bell-empty'))?.focus();
  }, [items]);

  async function dismiss(keys: string[], all: boolean, index: number) {
    if (keys.length === 0) return;
    const gone = new Set(keys);
    // Emptied first, so a second "Dismissed" in a row is a change the live region reads again
    setSaid('');
    // Optimistic: the line leaves at once and the count drops; the read after the write settles it
    setAttention((now) => {
      if (!now) return now;
      const left = now.items.filter((i) => !gone.has(i.key));
      return { items: left, count: countOf(left) };
    });
    focusAt.current = index;
    try {
      await (all ? clearAttention : dismissAttention)({ data: { keys } });
      setSaid(all ? 'All cleared' : 'Dismissed');
    } catch {
      setSaid('Could not dismiss it; it is back in the list');
    }
    await load();
  }

  function onItemKey(event: KeyboardEvent<HTMLElement>, item: AttentionItem, index: number) {
    if (item.kind === 'scheduled' || (event.key !== 'Delete' && event.key !== 'Backspace')) return;
    event.preventDefault();
    void dismiss([item.key], false, index);
  }

  return (
    <Sheet label="What needs you" open={open} onOpenChange={setOpen} className="home-bell">
      <div className="home-bell-body" ref={panel}>
        <h2 className="k-d k-d30">What needs you</h2>
        {items.length === 0 ? (
          <p className="k-muted home-bell-empty" tabIndex={-1}>
            Nothing needs you.
          </p>
        ) : (
          <>
            <ul className="k-stack home-bell-list">
              {items.map((item, index) => {
                const quiet = item.kind === 'scheduled';
                return (
                  <li key={item.key} className={`k-row home-bell-row${quiet ? ' k-muted' : ''}`}>
                    <AttentionMark item={item} small />
                    <span className="k-grow k-sm" onKeyDown={(event) => onItemKey(event, item, index)}>
                      <Subject item={item} />
                      <br />
                      <AttentionLink item={item} className="home-bell-link" onClick={() => setOpen(false)}>
                        {item.action}
                        <span className="visually-hidden">: {item.text}</span>
                      </AttentionLink>
                    </span>
                    {!quiet && (
                      <button type="button" className="k-btn k-icon k-sm k-ghost home-bell-dismiss" aria-label={`Dismiss: ${item.text}`} onClick={() => void dismiss([item.key], false, index)}>
                        <Icon name="close" size={20} />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="k-hrow k-between k-g12">
              <span className="k-xs k-muted">{scheduled ? 'Scheduled posts don’t count in the badge.' : ''}</span>
              {counted.length > 0 && (
                <button type="button" className="k-btn k-sm" onClick={() => void dismiss(counted.map((i) => i.key), true, 0)}>
                  Clear all
                </button>
              )}
            </div>
          </>
        )}
        <p className="visually-hidden" role="status" aria-live="polite">
          {said}
        </p>
      </div>
    </Sheet>
  );
}
