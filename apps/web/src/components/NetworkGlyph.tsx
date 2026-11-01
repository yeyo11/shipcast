import type { ReactNode } from 'react';
import { CHANNEL_NAMES } from '../server/view';
import { GLYPHS } from './kit/glyphs';

/** The marks drawn as outlines in design/icons: the rest are filled shapes */
const STROKED: Record<string, ReactNode> = {
  newsletter: (
    <>
      <rect x="2.5" y="5" width="19" height="14" rx="1.5" />
      <path d="m3 6 9 7 9-7" />
    </>
  ),
  threads: (
    <>
      <circle cx="12" cy="12" r="3.25" />
      <path d="M15.25 10.5v2.75c0 1.5.9 2.5 2.25 2.5S20 14.75 20 12a8 8 0 1 0-3.1 6.32" />
    </>
  ),
};

/**
 * A network's mark inline, in the text's colour (the board's glyphs, kit/glyphs.ts); a network with
 * none gets its initial, so no mark is blank. Decorative: the words beside it name the network.
 */
export function NetworkGlyph({ channel, size = 15 }: { channel: string; size?: number }) {
  const key = channel === 'brevo' ? 'newsletter' : channel;
  const stroked = STROKED[key];
  if (stroked)
    return (
      <svg className="home-glyph" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {stroked}
      </svg>
    );
  const path = GLYPHS[key];
  if (path)
    return (
      <svg className="home-glyph" width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d={path} />
      </svg>
    );
  return (
    <span className="home-glyph home-glyph-letter" aria-hidden="true" style={{ width: size, height: size, fontSize: Math.round(size * 0.7) }}>
      {(CHANNEL_NAMES[channel] ?? channel).charAt(0)}
    </span>
  );
}
