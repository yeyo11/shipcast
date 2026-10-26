import type { ReactNode } from 'react';

/** The title of one Settings section: the page's own h1 is Settings, so each section is an h2 with its lead and main action */
export function SectionHead({ title, children, action, art }: { title: ReactNode; children?: ReactNode; action?: ReactNode; art?: ReactNode }) {
  return (
    <header className="section-intro">
      <div>
        <h2 className="ph settings-title">{title}</h2>
        {children && <p className="muted">{children}</p>}
      </div>
      {action && <div className="row">{action}</div>}
      {art && <div className="section-intro-art">{art}</div>}
    </header>
  );
}
