import { motion, MotionConfig } from 'motion/react';
import type { ReactNode } from 'react';
import { useBannerState } from './BannerState';
import { MinusIcon, PlusIcon } from './ui/icons';

/** The two sizes of every banner, in px (layout.css draws the same): one height each, whatever the page */
export const BANNER_HEIGHT = { full: 200, compact: 56 } as const;
const MOVE = { duration: 0.25, ease: 'easeOut' } as const;

/** The corner button that folds a banner to its title strip and back; wide screens only (layout.css) */
export function BannerToggle({ compact, onToggle }: { compact: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="ui-icon-button band-toggle" aria-label={compact ? 'Expand the banner' : 'Collapse the banner'} aria-expanded={!compact} onClick={onToggle}>
      {compact ? <PlusIcon size={16} /> : <MinusIcon size={16} />}
    </button>
  );
}

/**
 * A section's header as a Cartel band (docs/decisions/app-design-direction.md): the huge uppercase
 * title, a line under it and the section's illustration. Every band has the same height, so moving
 * between sections never makes the page jump; folded, it is a slim strip with the title alone, a
 * choice kept for every page. The page's actions are in the `PageToolbar` under it, and what waits
 * for the owner is in the top bar's bell.
 */
export function PageHead({ title, children, art }: { title: ReactNode; children?: ReactNode; art?: ReactNode }) {
  const { compact, toggle } = useBannerState();
  return (
    // Height, fades and the title's size move together; instant for whoever asks for reduced motion
    <MotionConfig reducedMotion="user" transition={MOVE}>
      <motion.header
        className={`page-band${art ? ' has-art' : ''}`}
        data-compact={compact || undefined}
        initial={false}
        animate={{ height: compact ? BANNER_HEIGHT.compact : BANNER_HEIGHT.full }}
      >
        <div className="page-band-text">
          <motion.h1 className="ph" initial={false} animate={{ fontSize: compact ? '26px' : '64px' }}>
            {title}
          </motion.h1>
          {children && (
            <motion.div className="page-band-lead" initial={false} animate={{ opacity: compact ? 0 : 1 }} aria-hidden={compact || undefined}>
              {children}
            </motion.div>
          )}
        </div>
        {art && (
          <motion.div className="page-band-art" initial={false} animate={{ opacity: compact ? 0 : 1, scale: compact ? 0.8 : 1 }}>
            {art}
          </motion.div>
        )}
        <BannerToggle compact={compact} onToggle={toggle} />
      </motion.header>
    </MotionConfig>
  );
}

/** An empty list, told with its illustration: what is missing and the one thing that fills it */
export function Empty({ art, title, children, action }: { art: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <section className="empty" aria-label={title}>
      <div className="empty-art">{art}</div>
      <div className="empty-text">
        <h2 className="ph">{title}</h2>
        {children && <p className="muted">{children}</p>}
        {action && <div className="row">{action}</div>}
      </div>
    </section>
  );
}
