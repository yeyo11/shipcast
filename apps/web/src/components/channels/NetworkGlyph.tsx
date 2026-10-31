import { GLYPHS } from '../kit/glyphs';
import { Icon } from '../kit/Icon';

/** The glyph a network is drawn with: its channel's (GitHub Discussions wears GitHub's), or its own id's */
function glyphKey(network: { id: string; channel?: string | undefined }): string {
  const key = network.channel ?? network.id;
  return key === 'githubDiscussions' ? 'github' : key;
}

/**
 * A network's mark in the text colour, as the boards inline it. Threads and the newsletter are
 * line glyphs (an outline with a part the path data leaves out); a source of numbers or an AI
 * provider with no glyph of its own takes the line icon of what it does.
 */
export function NetworkGlyph({ network, size = 19 }: { network: { id: string; channel?: string | undefined; ai?: boolean | undefined }; size?: number }) {
  const key = glyphKey(network);
  if (key === 'threads')
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
        <circle cx="12" cy="12" r="3.25" />
        <path d={GLYPHS.threads} />
      </svg>
    );
  if (key === 'newsletter')
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
        <rect x="2.5" y="5" width="19" height="14" rx="1.5" />
        <path d={GLYPHS.newsletter} />
      </svg>
    );
  const path = GLYPHS[key];
  if (path)
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ flex: 'none' }}>
        <path d={path} />
      </svg>
    );
  return <Icon name={network.ai ? 'assist' : 'stats'} size={size} />;
}
