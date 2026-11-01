import { createElement } from 'react';
import { CHANNEL_NAMES } from '../../server/view';
import { GLYPHS } from './glyphs';
import { Icon, type IconName } from './Icon';

/** Where a network wears another's mark: Brevo is the newsletter, GitHub Discussions is GitHub */
const GLYPH_OF: Record<string, string> = { brevo: 'newsletter', githubDiscussions: 'github' };

/** SVG attributes as React spells them (fill-rule → fillRule) */
const reactAttrs = (attrs: Record<string, string>) => Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k.replace(/-(\w)/g, (_, c: string) => c.toUpperCase()), v]));

/**
 * The sources of numbers and the AI providers have no brand mark in the set: each takes the kit's line
 * icon of what it is (a search console the search, Bing's crawler the globe, the CDN a cloud, a
 * visits counter the chart), so no tile is ever blank. Keys are networks and the metric sources the
 * stats name (`search`, `bing`).
 */
export const SOURCE_ICON: Readonly<Record<string, IconName>> = {
  searchConsole: 'search',
  search: 'search',
  bingWebmaster: 'globe',
  bing: 'globe',
  cloudflare: 'cloud',
  umami: 'stats',
  anthropic: 'assist',
  openaiCompatible: 'assist',
};

export const hasGlyph = (channel: string) => (GLYPH_OF[channel] ?? channel) in GLYPHS;

/**
 * A network's mark inline, in the text's colour, whole: a filled mark filled, a line mark (the
 * newsletter, Threads) drawn as a line with every part of it. A source takes its line icon
 * (SOURCE_ICON), and anything else with no mark its initial, so no tile is ever blank. Decorative: the words beside it name the network.
 */
export function NetworkGlyph({ channel, size = 19, className }: { channel: string; size?: number; className?: string }) {
  const glyph = GLYPHS[GLYPH_OF[channel] ?? channel];
  const icon = SOURCE_ICON[channel];
  if (!glyph && icon) return <Icon name={icon} size={size} className={className} />;
  if (!glyph) {
    return (
      <span className={className} aria-hidden="true" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none', width: size, height: size, fontSize: Math.round(size * 0.7), fontWeight: 800, lineHeight: 1 }}>
        {(CHANNEL_NAMES[channel] ?? channel).charAt(0).toUpperCase()}
      </span>
    );
  }
  const paint = glyph.stroke ? { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const } : { fill: 'currentColor' };
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ flex: 'none' }} {...paint}>
      {glyph.shapes.map((s, i) => createElement(s.tag, { key: i, ...reactAttrs(s.attrs) }))}
    </svg>
  );
}
