import { motion, MotionConfig } from 'motion/react';
import type { ReactNode } from 'react';
import { useBannerState } from './BannerState';

/** A section head's two sizes, in px (layout.css draws the same) */
const SECTION_HEIGHT = { full: 140, compact: 80 } as const;

/**
 * The title of one Settings section: the page's own h1 is Settings, so each section is an h2 with its
 * lead; its actions are in the toolbar. It folds with the page's banner (whose corner button sets
 * the size for every page) and has no button of its own, so one page never offers two.
 */
export function SectionHead({ title, children, art }: { title: ReactNode; children?: ReactNode; art?: ReactNode }) {
  const { compact } = useBannerState();
  return (
    <MotionConfig reducedMotion="user" transition={{ duration: 0.25, ease: 'easeOut' }}>
      <motion.header className="section-intro" data-compact={compact || undefined} initial={false} animate={{ height: compact ? SECTION_HEIGHT.compact : SECTION_HEIGHT.full }}>
        <div className="section-intro-text">
          <h2 className="ph settings-title">{title}</h2>
          {children && (
            <motion.p
              className="muted"
              initial={false}
              animate={{ opacity: compact ? 0 : 1, height: compact ? 0 : 'auto', marginTop: compact ? 0 : 8 }}
              aria-hidden={compact || undefined}
            >
              {children}
            </motion.p>
          )}
        </div>
        {art && (
          <motion.div className="section-intro-art" initial={false} animate={{ opacity: compact ? 0 : 1 }}>
            {art}
          </motion.div>
        )}
      </motion.header>
    </MotionConfig>
  );
}
