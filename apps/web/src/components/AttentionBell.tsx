import { Link, useRouterState } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { attentionLabel, countOf, type Attention, type AttentionItem } from '../server/attention';
import { clearAttention, dismissAttention, getAttention } from '../server/attention.functions';
import { useLiveEnabled, useLiveInterest } from './live/Live';
import { BellIcon, CloseIcon } from './ui/icons';
import { ResponsiveMenu } from './ui/ResponsiveMenu';

/** Fresh enough that a failure shows without a click, calm enough not to hammer the engine */
const REFRESH_MS = 3 * 60_000;

interface ItemLinkProps {
  item: AttentionItem;
  onGo: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLAnchorElement>) => void;
}

function ItemLink({ item, onGo, onKeyDown }: ItemLinkProps) {
  const body = (
    <>
      <span className="attention-text">{item.text}</span>
      <span className="attention-action">{item.action}</span>
    </>
  );
  const className = `attention-item attention-${item.kind}`;
  const shared = { className, onClick: onGo, onKeyDown, 'aria-keyshortcuts': 'Delete' };
  const t = item.target;
  // One branch per route: the router checks each link's params and search at compile time
  if (t.to === '/launches/$id')
    return (
      <Link {...shared} to={t.to} params={t.params}>
        {body}
      </Link>
    );
  if (t.to === '/comments')
    return (
      <Link {...shared} to={t.to} search={t.search}>
        {body}
      </Link>
    );
  if (t.to === '/settings')
    return (
      <Link {...shared} to={t.to}>
        {body}
      </Link>
    );
  return (
    <Link {...shared} to={t.to} search={t.search}>
      {body}
    </Link>
  );
}

/**
 * The top bar's bell: a yellow count when something needs the owner, and what, one link per line, in
 * a popover on a desktop or the bottom sheet on a phone. Each line can be dismissed (its × or Delete
 * on the line) and the panel cleared at once; the registry keeps the dismissals, so they hold on
 * every device until the condition behind a line changes. The list is read again on every
 * navigation, when it opens and every few minutes.
 */
export function AttentionBell() {
  const [attention, setAttention] = useState<Attention | null>(null);
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState('');
  const path = useRouterState({ select: (s) => s.location.pathname });
  const panel = useRef<HTMLDivElement>(null);
  /** Where focus goes once a dismissed line has left the list: the line now at that place */
  const focusAt = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      setAttention(await getAttention());
    } catch {
      // A failed read keeps what was shown: the bell must never turn into an error of its own
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, path]);
  // Live (realtime-ui): read again when something its lines come from changes, never on a timer
  const live = useLiveEnabled();
  useLiveInterest(live ? ['attention', 'launch', 'post', 'comment', 'account'] : null, { reload: () => void load(), debounceMs: 1000 });
  useEffect(() => {
    if (live) return;
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [live, load]);
  useEffect(() => {
    if (open) void load();
    else setSaid('');
  }, [open, load]);

  const items = attention?.items ?? [];
  const count = attention?.count ?? 0;
  const label = attentionLabel(count);

  // The focused line (or its ×) is gone: focus the next line, the last one, or the empty panel,
  // never the page behind the popup
  useEffect(() => {
    const at = focusAt.current;
    if (at === null || !panel.current) return;
    focusAt.current = null;
    const links = panel.current.querySelectorAll<HTMLElement>('.attention-item');
    (links[Math.min(at, links.length - 1)] ?? panel.current.querySelector<HTMLElement>('.attention-empty'))?.focus();
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

  function onItemKey(event: KeyboardEvent<HTMLAnchorElement>, item: AttentionItem, index: number) {
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    event.preventDefault();
    void dismiss([item.key], false, index);
  }

  return (
    <ResponsiveMenu
      label="What needs you"
      align="end"
      className="attention-popup"
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button type="button" className="ui-icon-button attention-button" aria-label={label}>
          <BellIcon size={22} />
          {count > 0 && (
            <span className="attention-badge" aria-hidden="true">
              {count > 9 ? '9+' : count}
            </span>
          )}
        </button>
      }
    >
      <div className="attention-panel" ref={panel}>
        {items.length === 0 ? (
          <p className="attention-empty muted" tabIndex={-1}>
            Nothing needs you.
          </p>
        ) : (
          <>
            <div className="attention-head">
              <button type="button" className="btn-link attention-clear" onClick={() => void dismiss(items.map((i) => i.key), true, 0)}>
                Clear all
              </button>
            </div>
            <ul className="attention-list">
              {items.map((item, index) => (
                <li key={item.key} className="attention-row">
                  <ItemLink item={item} onGo={() => setOpen(false)} onKeyDown={(event) => onItemKey(event, item, index)} />
                  <button type="button" className="ui-icon-button attention-dismiss" aria-label={`Dismiss: ${item.text}`} onClick={() => void dismiss([item.key], false, index)}>
                    <CloseIcon size={16} />
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="visually-hidden" role="status" aria-live="polite">
          {said}
        </p>
      </div>
    </ResponsiveMenu>
  );
}
