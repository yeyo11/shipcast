import { Link, useRouterState } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { attentionLabel, type Attention, type AttentionItem } from '../server/attention';
import { getAttention } from '../server/attention.functions';
import { BellIcon } from './ui/icons';
import { ResponsiveMenu } from './ui/ResponsiveMenu';

/** Fresh enough that a failure shows without a click, calm enough not to hammer the engine */
const REFRESH_MS = 3 * 60_000;

function ItemLink({ item, onGo }: { item: AttentionItem; onGo: () => void }) {
  const body = (
    <>
      <span className="attention-text">{item.text}</span>
      <span className="attention-action">{item.action}</span>
    </>
  );
  const className = `attention-item attention-${item.kind}`;
  const t = item.target;
  // One branch per route: the router checks each link's params and search at compile time
  if (t.to === '/launches/$id')
    return (
      <Link className={className} to={t.to} params={t.params} onClick={onGo}>
        {body}
      </Link>
    );
  if (t.to === '/comments')
    return (
      <Link className={className} to={t.to} search={t.search} onClick={onGo}>
        {body}
      </Link>
    );
  return (
    <Link className={className} to={t.to} search={t.search} onClick={onGo}>
      {body}
    </Link>
  );
}

/**
 * The top bar's bell: a yellow count when something needs the owner, and what, one link per line, in
 * a popover on a desktop or the bottom sheet on a phone. It replaced the yellow bands on top of the
 * pages. The list is read again on every navigation, when it opens and every few minutes.
 */
export function AttentionBell() {
  const [attention, setAttention] = useState<Attention | null>(null);
  const [open, setOpen] = useState(false);
  const path = useRouterState({ select: (s) => s.location.pathname });

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
  useEffect(() => {
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const count = attention?.count ?? 0;
  const label = attentionLabel(count);
  const items = attention?.items ?? [];

  return (
    <ResponsiveMenu
      label="What needs you"
      align="end"
      className="attention-popup"
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button type="button" className="ui-icon-button attention-button" aria-label={label} data-count={count > 0 ? count : undefined}>
          <BellIcon />
          {count > 0 && (
            <span className="attention-badge" aria-hidden="true">
              {count > 9 ? '9+' : count}
            </span>
          )}
        </button>
      }
    >
      {items.length === 0 ? (
        <p className="attention-empty muted">Nothing needs you.</p>
      ) : (
        <ul className="attention-list">
          {items.map((item) => (
            <li key={item.key}>
              <ItemLink item={item} onGo={() => setOpen(false)} />
            </li>
          ))}
        </ul>
      )}
    </ResponsiveMenu>
  );
}
