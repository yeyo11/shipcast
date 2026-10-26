import type { ReactNode } from 'react';

/**
 * A section's header as a Cartel band (docs/decisions/app-design-direction.md): the huge uppercase
 * title, a line under it and the section's illustration. Every band has the same height, so moving
 * between sections never makes the page jump; the page's actions are in the `PageToolbar` under it,
 * and what waits for the owner is in the top bar's bell.
 */
export function PageHead({ title, children, art }: { title: ReactNode; children?: ReactNode; art?: ReactNode }) {
  return (
    <header className={`page-band${art ? ' has-art' : ''}`}>
      <div className="page-band-text">
        <h1 className="ph">{title}</h1>
        {children && <div className="page-band-lead">{children}</div>}
      </div>
      {art && <div className="page-band-art">{art}</div>}
    </header>
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
