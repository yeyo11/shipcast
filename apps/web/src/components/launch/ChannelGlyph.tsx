import { GLYPHS } from '../kit/glyphs';
import { CHANNEL_NAMES } from '../../server/view';

/** The marks drawn as a line rather than a filled shape */
const STROKED = new Set(['newsletter', 'threads']);

/**
 * A network's mark inline, in the text's colour as the board draws it; a network with no glyph gets
 * its initial, so no tile is blank
 */
export function ChannelGlyph({ channel, size = 19 }: { channel: string; size?: number }) {
  const key = channel === 'brevo' ? 'newsletter' : channel;
  const path = GLYPHS[key];
  if (!path) {
    return (
      <span aria-hidden="true" style={{ width: size, height: size, fontSize: Math.round(size * 0.7), fontWeight: 800, lineHeight: `${size}px`, textAlign: 'center' }}>
        {(CHANNEL_NAMES[channel] ?? channel).charAt(0).toUpperCase()}
      </span>
    );
  }
  return STROKED.has(key) ? (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
      {key === 'newsletter' && <rect x="3" y="5" width="18" height="14" rx="2" />}
      <path d={path} />
    </svg>
  ) : (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ flex: 'none' }}>
      <path d={path} />
    </svg>
  );
}

/** A channel's name as the app writes it everywhere */
export const channelTitle = (channel: string) => CHANNEL_NAMES[channel] ?? channel;
