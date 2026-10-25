import { createFileRoute } from '@tanstack/react-router';
import { ILLUSTRATIONS, ILLUSTRATION_NAMES } from '../../../components/illustrations';

// Not in the navigation: a review page for the owner, kept so the set can be checked running, in both
// themes and at the smallest and largest sizes it is drawn for, before it is wired into pages
export const Route = createFileRoute('/_app/design/illustrations')({
  head: () => ({ meta: [{ title: 'Illustrations · Shipcast' }] }),
  component: Gallery,
});

const THEMES = ['night', 'day'] as const;

function Gallery() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="ph">Illustrations</h1>
          <p>
            Postal, with humour: every scene at 320 and 160 px, night and day. Drawn in{' '}
            <code>components/illustrations</code> on Cartel's role tokens.
          </p>
        </div>
      </div>
      <ul className="illo-gallery">
        {ILLUSTRATION_NAMES.map((name) => {
          const { component: Scene, use } = ILLUSTRATIONS[name];
          return (
            <li key={name}>
              <div className="illo-name">
                <h2 className="ph">{name}</h2>
                <span className="muted">{use}</span>
              </div>
              <div className="illo-themes">
                {THEMES.map((theme) => (
                  <div key={theme} className="illo-theme" data-theme={theme}>
                    <Scene width={320} />
                    <Scene width={160} />
                    <span className="illo-tag">{theme}</span>
                  </div>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
