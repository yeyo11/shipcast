import type { Option } from '../ui/Select';

/** A choice in a filter's list; `group` is the heading it sits under (an account's network, a launch's project) */
export interface FilterOption extends Option {
  group?: string;
}

/** What a pill says it holds: the one choice by name, several by how many */
export function summarize(chosen: readonly string[], options: readonly FilterOption[], plural: string): string | null {
  if (chosen.length === 0) return null;
  if (chosen.length === 1) return options.find((o) => o.value === chosen[0])?.label ?? `1 ${plural.replace(/e?s$/, '')}`;
  return `${chosen.length} ${plural}`;
}

/** The options a search keeps, in their groups and in their order; a search matches a label or a group */
export function grouped(options: readonly FilterOption[], query: string): Array<{ group: string | null; options: FilterOption[] }> {
  const q = query.trim().toLowerCase();
  const kept = q ? options.filter((o) => o.label.toLowerCase().includes(q) || (o.group ?? '').toLowerCase().includes(q) || (o.hint ?? '').toLowerCase().includes(q)) : options;
  const groups = new Map<string | null, FilterOption[]>();
  for (const o of kept) groups.set(o.group ?? null, [...(groups.get(o.group ?? null) ?? []), o]);
  return [...groups].map(([group, list]) => ({ group, options: list }));
}
