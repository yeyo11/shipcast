import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { filtersSet, KIND_NAMES, LAUNCH_STATUS_NAMES, SORT_NAMES, TRIGGER_NAMES, type LaunchesSearch, type LaunchSort } from '../server/launches-search';
import { Icon } from './kit/Icon';
import { Overlay } from './kit/Overlay';
import { PickerSelect } from './kit/Picker';

/*
 * The Launches page's search and filters (boards Main, LaunchFilters, DesktopHome and DesktopDrawer):
 * the words to find, on a desktop the status, the kind and the order as chip pickers beside the
 * search, and a Filters button that opens every filter: the sheet of chips on a phone, the drawer on
 * a desktop. Every change is a change of the address, which
 * is what loads the page, so a view is shareable and Back undoes it (docs/decisions/lists.md).
 */

export interface LaunchFacets {
  repos: Array<{ repo: string; count: number }>;
  statuses: Array<{ status: string; count: number }>;
  triggers: Array<{ trigger: string; count: number }>;
  kinds: Array<{ kind: string; count: number }>;
}

type Patch = { [K in keyof LaunchesSearch]?: LaunchesSearch[K] | undefined };

/** A picker's "every" choice: the filter left unset */
const EVERY = '*';

const NO_FILTERS: Patch = { status: undefined, trigger: undefined, kind: undefined, repo: undefined };

/** The way to the address: any change of filter starts again from the first page */
export function useLaunchesNavigate(search: LaunchesSearch) {
  const navigate = useNavigate();
  return (patch: Patch, page = false) => {
    const next = { ...search, ...(page ? {} : { page: undefined }), ...patch };
    void navigate({ to: '/', search: Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined && v !== '')), resetScroll: page, replace: !page });
  };
}

/** A vocabulary's choices that some launch has, each with how many */
function present<N extends Record<string, string>>(names: N, rows: ReadonlyArray<{ value: string; count: number }>): Array<{ value: keyof N & string; label: string; count: number }> {
  return rows.flatMap((r) => (Object.hasOwn(names, r.value) && r.count > 0 ? [{ value: r.value as keyof N & string, label: names[r.value as keyof N] as string, count: r.count }] : []));
}

function ChipGroup<V extends string>({ label, all, value, options, onChange }: { label: string; all: string; value: V | undefined; options: Array<{ value: V; label: string; count: number }>; onChange: (v: V | undefined) => void }) {
  return (
    <fieldset className="k-stack k-g8 home-filter-group">
      <legend className="k-lbl">{label}</legend>
      <div className="k-hrow k-g8 k-wrap">
        <button type="button" className={`k-chip${value === undefined ? ' k-on' : ''}`} aria-pressed={value === undefined} onClick={() => onChange(undefined)}>
          {all}
        </button>
        {options.map((o) => (
          <button key={o.value} type="button" className={`k-chip${value === o.value ? ' k-on' : ''}`} aria-pressed={value === o.value} onClick={() => onChange(value === o.value ? undefined : o.value)}>
            {o.label} ({o.count})
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** The filter sheet (board LaunchFilters): chips that apply at once, and the count they leave */
export function FilterSheet({ search, facets, total }: { search: LaunchesSearch; facets: LaunchFacets; total: number }) {
  const go = useLaunchesNavigate(search);
  const [open, setOpen] = useState(false);
  const set = filtersSet(search);
  const statuses = present(LAUNCH_STATUS_NAMES, facets.statuses.map((s) => ({ value: s.status, count: s.count })));
  const kinds = present(KIND_NAMES, facets.kinds.map((k) => ({ value: k.kind, count: k.count })));
  const triggers = present(TRIGGER_NAMES, facets.triggers.map((t) => ({ value: t.trigger, count: t.count })));
  return (
    <Overlay
      kind="drawer"
      label="Filters"
      heading="Filters"
      footer={
        <div className="k-hrow k-g10 home-filters-foot">
          <button type="button" className="k-btn" disabled={set === 0 && !search.sort} onClick={() => go({ ...NO_FILTERS, sort: undefined })}>
            Clear
          </button>
          <button type="button" className="k-btn k-pri k-grow" onClick={() => setOpen(false)}>
            Show {total === 1 ? '1 launch' : `${total} launches`}
          </button>
        </div>
      }
      open={open}
      onOpenChange={setOpen}
      className="home-filters"
      trigger={
        <button type="button" className="k-btn k-sm k-icon home-filter-button" aria-label={set > 0 ? `Filters, ${set} set` : 'Filters'}>
          <Icon name="filter" />
          {set > 0 && (
            <span className="k-badge" aria-hidden="true">
              {set}
            </span>
          )}
        </button>
      }
    >
      <ChipGroup label="Status" all="Every status" value={search.status} options={statuses} onChange={(v) => go({ status: v })} />
      <ChipGroup label="Kind" all="Every kind" value={search.kind} options={kinds} onChange={(v) => go({ kind: v })} />
      <ChipGroup label="Started by" all="Anyone" value={search.trigger} options={triggers} onChange={(v) => go({ trigger: v })} />
      <PickerSelect
        label="Project"
        value={search.repo ?? EVERY}
        options={[{ value: EVERY, label: 'Every project' }, ...facets.repos.map((r) => ({ value: r.repo, label: `${r.repo} (${r.count})` }))]}
        onValueChange={(v) => go({ repo: v === EVERY ? undefined : v })}
        render={(o) => (o.value === EVERY ? <span className="k-placeholder">{o.label}</span> : o.value)}
      />
      <div className="k-hrow k-between">
        <span className="k-lbl" id="home-order">
          Order
        </span>
        <div className="k-seg home-order" role="radiogroup" aria-labelledby="home-order">
          {(['newest', 'oldest'] as const).map((s) => (
            <button key={s} type="button" role="radio" aria-checked={(search.sort ?? 'newest') === s} className={(search.sort ?? 'newest') === s ? 'k-on' : undefined} onClick={() => go({ sort: s === 'oldest' ? 'oldest' : undefined })}>
              {s === 'newest' ? 'Newest' : 'Oldest'}
            </button>
          ))}
        </div>
      </div>
    </Overlay>
  );
}

/** A desktop filter: the kit's picker drawn as a chip, "every" being the empty choice */
function ChipSelect<V extends string>({ label, value, options, onChange }: { label: string; value: V | ''; options: Array<{ value: V | ''; label: string }>; onChange: (v: V | '') => void }) {
  return (
    <PickerSelect
      variant="chip"
      label={label}
      value={value === '' ? EVERY : value}
      options={options.map((o) => ({ value: o.value === '' ? EVERY : o.value, label: o.label }))}
      onValueChange={(v) => onChange(v === EVERY ? '' : (v as V))}
    />
  );
}

/** The desktop's filters beside the search (board DesktopHome) */
export function FilterMenus({ search, facets }: { search: LaunchesSearch; facets: LaunchFacets }) {
  const go = useLaunchesNavigate(search);
  const statuses = present(LAUNCH_STATUS_NAMES, facets.statuses.map((s) => ({ value: s.status, count: s.count })));
  const kinds = present(KIND_NAMES, facets.kinds.map((k) => ({ value: k.kind, count: k.count })));
  return (
    <>
      <ChipSelect label="Status" value={search.status ?? ''} options={[{ value: '', label: 'Every status' }, ...statuses.map((s) => ({ value: s.value, label: `${s.label} (${s.count})` }))]} onChange={(v) => go({ status: v || undefined })} />
      <ChipSelect label="Kind" value={search.kind ?? ''} options={[{ value: '', label: 'Every kind' }, ...kinds.map((s) => ({ value: s.value, label: `${s.label} (${s.count})` }))]} onChange={(v) => go({ kind: v || undefined })} />
      <ChipSelect<LaunchSort>
        label="Order"
        value={search.sort ?? 'newest'}
        options={(Object.keys(SORT_NAMES) as LaunchSort[]).map((s) => ({ value: s, label: s === 'newest' ? 'Newest' : 'Oldest' }))}
        onChange={(v) => go({ sort: v === 'oldest' ? 'oldest' : undefined })}
      />
    </>
  );
}

/** Words to find: applied once the typing pauses, and at Enter */
export function SearchBox({ search }: { search: LaunchesSearch }) {
  const go = useLaunchesNavigate(search);
  const value = search.q ?? '';
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (text.trim() === value) return;
    const timer = setTimeout(() => go({ q: text.trim() || undefined }), 400);
    return () => clearTimeout(timer);
  }, [text, value]);
  return (
    <label className="k-input home-search" role="search">
      <Icon name="search" size={18} />
      <span className="visually-hidden">Search the launches</span>
      <input
        type="search"
        placeholder="A project, a version or an article"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') go({ q: text.trim() || undefined });
        }}
      />
    </label>
  );
}

export function LaunchPager({ page, search }: { page: { number: number; pages: number }; search: LaunchesSearch }) {
  const go = useLaunchesNavigate(search);
  if (page.pages <= 1) return null;
  const to = (n: number) => go({ page: n > 1 ? n : undefined }, true);
  return (
    <nav className="k-hrow k-between k-g8 home-pager" aria-label="Pages of launches">
      <button type="button" className="k-btn k-sm" disabled={page.number <= 1} onClick={() => to(page.number - 1)}>
        Previous
      </button>
      <span className="k-sm k-muted" aria-live="polite">
        Page {page.number} of {page.pages}
      </span>
      <button type="button" className="k-btn k-sm" disabled={page.number >= page.pages} onClick={() => to(page.number + 1)}>
        Next
      </button>
    </nav>
  );
}
