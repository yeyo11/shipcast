import type { ReactNode } from 'react';
import { GLYPHS } from '../kit/glyphs';

/*
 * The Stats section's small shared pieces: a network's glyph and the empty state every tab ends on
 * when there is nothing to show; its words are in words.ts.
 */

/** The networks' glyph names, where a channel or an account's network is not one by itself */
const GLYPH_OF: Record<string, string> = { brevo: 'newsletter' };

/** A network's mark, inline so it takes the text colour (the board's glyphs) */
export function Glyph({ channel, size = 14 }: { channel: string | null; size?: number }) {
  const path = channel ? GLYPHS[GLYPH_OF[channel] ?? channel] : undefined;
  if (!path) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ flex: 'none' }}>
      <path d={path} />
    </svg>
  );
}

/** The empty and nothing-yet state (board StatsEmpty): the section's art, a title, a line and a way on */
export function StatsEmpty({ art, title, children, actions }: { art: ReactNode; title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="k-px k-stack k-g16 stats-empty">
      <div className="stats-empty-art" aria-hidden="true">
        {art}
      </div>
      <h2 className="k-d k-d30">{title}</h2>
      <p className="k-muted stats-empty-text">{children}</p>
      {actions && <div className="k-hrow k-g8 k-wrap stats-empty-actions">{actions}</div>}
    </div>
  );
}

export { ago, counted, daysSince, METRIC_NAMES, PERIOD_CHIPS, periodChip, periodWords } from './words';
