import type { ReactNode } from 'react';

/**
 * A section's header as a Cartel band (docs/decisions/app-design-direction.md): the huge uppercase
 * title, a line under it, and the section's main action, yellow when there is one. The band is the
 * neutral one: yellow bands stay for what waits for the owner, black for a page's close.
 */
export function PageHead({ title, children, action, art }: { title: ReactNode; children?: ReactNode; action?: ReactNode; art?: ReactNode }) {
  return (
    <header className={`page-band${art ? ' has-art' : ''}`}>
      <div className="page-band-text">
        <h1 className="ph">{title}</h1>
        {children && <div className="page-band-lead">{children}</div>}
      </div>
      {action && <div className="page-band-action">{action}</div>}
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
