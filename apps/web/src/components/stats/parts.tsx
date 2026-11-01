import type { ReactNode } from 'react';
import { NetworkGlyph } from '../kit/NetworkGlyph';

/*
 * The Stats section's small shared pieces: a network's glyph and the empty state every tab ends on
 * when there is nothing to show; its words are in words.ts.
 */

/** A network's mark, inline so it takes the text colour (the board's glyphs); nothing for a row with no channel */
export function Glyph({ channel, size = 14 }: { channel: string | null; size?: number }) {
  // The kit's mark always draws something (a line icon or an initial): no empty tile beside a name
  return channel ? <NetworkGlyph channel={channel} size={size} /> : null;
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
