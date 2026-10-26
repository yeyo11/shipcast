import type { ReactNode } from 'react';

/** The title of one Settings section: the page's own h1 is Settings, so each section is an h2 with its lead; its actions are in the toolbar */
export function SectionHead({ title, children, art }: { title: ReactNode; children?: ReactNode; art?: ReactNode }) {
  return (
    <header className="section-intro">
      <div>
        <h2 className="ph settings-title">{title}</h2>
        {children && <p className="muted">{children}</p>}
      </div>
      {art && <div className="section-intro-art">{art}</div>}
    </header>
  );
}
