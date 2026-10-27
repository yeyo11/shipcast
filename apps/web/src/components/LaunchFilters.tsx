import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Combobox } from './ui/Combobox';
import { Drawer } from './ui/Drawer';
import { Popover } from './ui/Popover';
import { usePhone } from './ui/ResponsiveMenu';
import { Select, type Option } from './ui/Select';
import { filtersSet, KIND_NAMES, LAUNCH_STATUS_NAMES, SORT_NAMES, TRIGGER_NAMES, type KindName, type LaunchesSearch, type LaunchSort, type LaunchStatusName, type TriggerName } from '../server/launches-search';

/*
 * The Launches page's bar, in the Comments page's pattern (docs/decisions/lists.md): the words to
 * find, then Filters (status, what started it, the pack, the project) one click away with a count
 * when any is set, then the order. Every change is a change of the address, which is what loads the
 * page, so a view is shareable and Back undoes it.
 */

export interface LaunchFacets {
  repos: Array<{ repo: string; count: number }>;
  statuses: Array<{ status: string; count: number }>;
  triggers: Array<{ trigger: string; count: number }>;
  kinds: Array<{ kind: string; count: number }>;
}

const ALL = 'all';

type Patch = { [K in keyof LaunchesSearch]?: LaunchesSearch[K] | undefined };

/** The way to the address: any change of filter starts again from the first page */
export function useLaunchesNavigate(search: LaunchesSearch) {
  const navigate = useNavigate();
  return (patch: Patch, page = false) => {
    const next = { ...search, ...(page ? {} : { page: undefined }), ...patch };
    void navigate({ to: '/', search: Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined && v !== '')), resetScroll: page });
  };
}

/** Options from what some launch has, each with how many, in the vocabulary's words */
function choices<V extends string>(names: Record<V, string>, rows: ReadonlyArray<{ value: string; count: number }>, all: string): Array<Option<V | typeof ALL>> {
  return [
    { value: ALL, label: all },
    ...rows.flatMap((r) => (Object.hasOwn(names, r.value) ? [{ value: r.value as V, label: `${names[r.value as V]} (${r.count})` }] : [])),
  ];
}

export function LaunchFilters({ search, facets }: { search: LaunchesSearch; facets: LaunchFacets }) {
  const go = useLaunchesNavigate(search);
  const phone = usePhone();
  const set = filtersSet(search);
  const statuses = choices(LAUNCH_STATUS_NAMES, facets.statuses.map((s) => ({ value: s.status, count: s.count })), 'Every status');
  const triggers = choices(TRIGGER_NAMES, facets.triggers.map((t) => ({ value: t.trigger, count: t.count })), 'Anything');
  const kinds = choices(KIND_NAMES, facets.kinds.map((k) => ({ value: k.kind, count: k.count })), 'Every kind');
  const repos: Array<Option> = facets.repos.map((r) => ({ value: r.repo, label: r.repo, hint: r.count === 1 ? '1 launch' : `${r.count} launches` }));
  const sorts: Array<Option<LaunchSort>> = (Object.keys(SORT_NAMES) as LaunchSort[]).map((s) => ({ value: s, label: SORT_NAMES[s] }));
  const trigger = (
    <button type="button" className="btn btn-small stats-filters-button">
      Filters
      {set > 0 && (
        <span className="stats-filters-count">
          {set}
          <span className="visually-hidden"> set</span>
        </span>
      )}
    </button>
  );
  const fields = (
    <div className="comment-filters">
      <Select<LaunchStatusName | typeof ALL> label="Status" options={statuses} value={search.status ?? ALL} onValueChange={(v) => go({ status: v === ALL ? undefined : v })} />
      <Select<TriggerName | typeof ALL> label="Started by" options={triggers} value={search.trigger ?? ALL} onValueChange={(v) => go({ trigger: v === ALL ? undefined : v })} />
      <Select<KindName | typeof ALL> label="Kind" options={kinds} value={search.kind ?? ALL} onValueChange={(v) => go({ kind: v === ALL ? undefined : v })} />
      <Combobox label="Project" options={repos} value={search.repo ?? null} placeholder="Every project" empty="No project matches." onValueChange={(v) => go({ repo: v ?? undefined })} />
      {set > 0 && (
        <button type="button" className="btn-link launch-filters-clear" onClick={() => go({ status: undefined, trigger: undefined, kind: undefined, repo: undefined })}>
          Clear the filters
        </button>
      )}
    </div>
  );
  return (
    <form
      className="comment-toolbar launch-toolbar"
      role="search"
      aria-label="Filter the launches"
      onSubmit={(e) => {
        e.preventDefault();
      }}
    >
      <SearchBox key={search.q ?? ''} value={search.q ?? ''} onSearch={(q) => go({ q: q || undefined })} />
      {phone ? (
        <Drawer title="Filters" trigger={trigger}>
          {fields}
        </Drawer>
      ) : (
        <Popover title="Filters" className="comment-filters-popup" align="start" trigger={trigger}>
          {fields}
        </Popover>
      )}
      <div className="launch-sort">
        <Select<LaunchSort> label={<span className="visually-hidden">Order</span>} options={sorts} value={search.sort ?? 'newest'} onValueChange={(v) => go({ sort: v === 'oldest' ? 'oldest' : undefined })} />
      </div>
    </form>
  );
}

/** Words to find: applied once the typing pauses, and at Enter */
function SearchBox({ value, onSearch }: { value: string; onSearch: (q: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => {
    if (text.trim() === value) return;
    const timer = setTimeout(() => onSearch(text.trim()), 400);
    return () => clearTimeout(timer);
  }, [text, value, onSearch]);
  return (
    <div className="comment-search">
      <label className="visually-hidden" htmlFor="launch-search">
        Search the launches
      </label>
      <input
        id="launch-search"
        className="input input-small"
        type="search"
        placeholder="A project, a version or an article"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSearch(text.trim());
        }}
      />
    </div>
  );
}

export function LaunchPager({ page, search }: { page: { number: number; pages: number }; search: LaunchesSearch }) {
  const go = useLaunchesNavigate(search);
  if (page.pages <= 1) return null;
  const to = (n: number) => go({ page: n > 1 ? n : undefined }, true);
  return (
    <nav className="row comment-pager" aria-label="Pages of launches">
      <button type="button" className="btn btn-small" disabled={page.number <= 1} onClick={() => to(page.number - 1)}>
        Previous
      </button>
      <span className="muted" aria-live="polite">
        Page {page.number} of {page.pages}
      </span>
      <button type="button" className="btn btn-small" disabled={page.number >= page.pages} onClick={() => to(page.number + 1)}>
        Next
      </button>
    </nav>
  );
}
