/*
 * The charts' series colours. Cartel allows no colour outside its palette (design/README.md), with
 * one exception the owner approved for charts: a series per channel in that network's own colour
 * where it passes contrast (docs/decisions/app-design-direction.md). So the hues live here, not in
 * design/tokens.css, and only charts use them.
 *
 * Seven chromatic slots, each with a night and a day step, picked near the networks' brand hues and
 * checked (test/charts.test.ts, and the dataviz validator recorded in docs/decisions/charts.md) to
 * pass 3:1 against both `--sc-ground` and `--sc-raised` in their theme. dev.to's brand is black and
 * GitHub's near-black, which fail on the night page; dev.to takes the text colour instead, a neutral
 * that every theme already guarantees. Red is left out on purpose: in Cartel red only means failure.
 * Everything past what a chart can tell apart folds into "other", in the muted text colour.
 */

export interface Slot {
  name: string;
  night: string;
  day: string;
}

/** The fixed order: a series takes its channel's slot, or the first free one in this order */
export const SLOTS: readonly Slot[] = [
  { name: 'blue', night: '#3987e5', day: '#2a6fc9' },
  { name: 'violet', night: '#9085e9', day: '#6250d6' },
  { name: 'magenta', night: '#d55181', day: '#c2427a' },
  { name: 'orange', night: '#d95926', day: '#c4501d' },
  { name: 'aqua', night: '#199e70', day: '#13825c' },
  { name: 'yellow', night: '#c98500', day: '#9a6a00' },
  { name: 'green', night: '#008300', day: '#007a00' },
];

/** The surfaces a chart sits on, per theme, from design/tokens.css: every slot passes 3:1 on each */
export const SURFACES = { night: ['#141413', '#1F1F1D'], day: ['#FFFFFF', '#EDEEF0'] } as const;

/** Each network's slot, nearest its own brand colour; dev.to is the ink, see above */
export const CHANNEL_SLOT: Readonly<Record<string, number | 'ink'>> = {
  bluesky: 0,
  mastodon: 1,
  instagram: 2,
  github: 3,
  hashnode: 4,
  blog: 5,
  newsletter: 6,
  devto: 'ink',
};

export const INK = 'var(--sc-text)';
export const OTHER = 'var(--sc-muted)';
export const slotVar = (index: number) => `var(--chart-${index + 1})`;

/** The slots as CSS custom properties, night on the root and day under `[data-theme="day"]` like the tokens */
export const PALETTE_CSS = [
  `:root{${SLOTS.map((s, i) => `--chart-${i + 1}:${s.night};`).join('')}}`,
  `[data-theme="day"]{${SLOTS.map((s, i) => `--chart-${i + 1}:${s.day};`).join('')}}`,
].join('\n');

export interface Colourable {
  key: string;
  /** The network the series belongs to, when it has one: a channel, or an account's network */
  channel?: string | null;
  /** A stable number for the entity (an account or launch id), so its colour survives a filter */
  id?: number;
}

/**
 * A colour per series that follows the entity, never its rank: a channel always gets its own slot,
 * so filtering one out does not repaint the others. An account takes its network's slot unless
 * another account of the same network already has it; a launch takes the slot its id points at.
 * Whoever finds their slot taken gets the next free one, then the ink, and past that the muted
 * "other" colour (the chart asks the engine for no more series than there are colours).
 */
export function assignColours(items: readonly Colourable[]): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<number | 'ink'>();
  const wanted = (item: Colourable): number | 'ink' | undefined => {
    if (item.key === 'other') return undefined;
    const own = item.channel ? CHANNEL_SLOT[item.channel] : undefined;
    if (own !== undefined) return own;
    if (item.id !== undefined) return item.id % SLOTS.length;
    return undefined;
  };
  const colourOf = (slot: number | 'ink') => (slot === 'ink' ? INK : slotVar(slot));
  const pending: Colourable[] = [];
  // Channels first, so a channel's own colour never goes to someone else who came before it
  for (const item of items) {
    const slot = item.channel ? CHANNEL_SLOT[item.channel] : undefined;
    if (slot !== undefined && !taken.has(slot)) {
      taken.add(slot);
      out.set(item.key, colourOf(slot));
    } else pending.push(item);
  }
  for (const item of pending) {
    if (item.key === 'other') {
      out.set(item.key, OTHER);
      continue;
    }
    const first = wanted(item);
    let slot: number | 'ink' | undefined = first !== undefined && !taken.has(first) ? first : undefined;
    if (slot === undefined) {
      const start = typeof first === 'number' ? first : 0;
      for (let step = 0; step < SLOTS.length; step++) {
        const candidate = (start + step) % SLOTS.length;
        if (!taken.has(candidate)) {
          slot = candidate;
          break;
        }
      }
    }
    if (slot === undefined && !taken.has('ink')) slot = 'ink';
    if (slot === undefined) {
      out.set(item.key, OTHER);
      continue;
    }
    taken.add(slot);
    out.set(item.key, colourOf(slot));
  }
  return out;
}

/** How many series a chart asks for one by one: every slot and the ink; the rest come back as "other" */
export const MAX_SERIES = SLOTS.length + 1;

/** WCAG contrast between two `#rrggbb` colours */
export function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}
