import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { TopBar } from '../../components/kit/Bars';
import { SaveBarSlot } from '../../components/SaveBar';

export const Route = createFileRoute('/_app/settings')({
  component: SettingsLayout,
});

const SECTIONS = [
  { to: '/settings', label: 'General', exact: true },
  { to: '/settings/ai', label: 'AI', exact: false },
  { to: '/settings/automation', label: 'Automation', exact: false },
  { to: '/settings/api', label: 'API', exact: false },
] as const;

/**
 * Settings is one area of four sections (boards Settings*, DesktopSettings): on a phone, inside More,
 * the title and tabs under a way back to More; from 960 px the title over a column of the sections.
 * Links rather than tabs, since each section is a route with its own data and address.
 */
function SettingsLayout() {
  return (
    <SaveBarSlot>
      {(slot) => (
        <div className="st-page">
          <TopBar back={{ label: 'More', more: true }} />
          <h1 className="k-d st-title">Settings</h1>
          <nav className="k-tabs st-tabs" aria-label="Settings sections">
            {SECTIONS.map((s) => (
              <Link key={s.to} to={s.to} className="k-tab" activeOptions={{ exact: s.exact }} activeProps={{ className: 'k-on' }}>
                {s.label}
              </Link>
            ))}
          </nav>
          <div className="st-grid">
            <nav className="st-nav" aria-label="Settings sections">
              {SECTIONS.map((s) => (
                <Link key={s.to} to={s.to} className="k-mi" activeOptions={{ exact: s.exact }} activeProps={{ className: 'k-on' }}>
                  {s.label}
                </Link>
              ))}
            </nav>
            <div className="st-body">
              <Outlet />
            </div>
          </div>
          <div ref={slot} className="st-savebar-slot" />
        </div>
      )}
    </SaveBarSlot>
  );
}
