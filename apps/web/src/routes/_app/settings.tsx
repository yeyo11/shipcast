import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { Toolbox } from '../../components/illustrations';
import { PageHead } from '../../components/PageHead';

export const Route = createFileRoute('/_app/settings')({
  component: SettingsLayout,
});

/**
 * Settings is one area with a submenu: a column beside the page on wide screens, tabs that scroll
 * sideways on phones. Links rather than Tabs, since each section is a route of its own with its own
 * data and its own address.
 */
function SettingsLayout() {
  return (
    <>
      <PageHead title="Settings" art={<Toolbox width={200} />}>Everything that is configured, in one place: the app, the AI, how releases are noticed and the API.</PageHead>
      <div className="settings-shell">
        <nav className="settings-nav" aria-label="Settings sections">
          <Link to="/settings" activeOptions={{ exact: true }}>
            General
          </Link>
          <Link to="/settings/ai">AI</Link>
          <Link to="/settings/automation">Automation</Link>
          <Link to="/settings/api">API</Link>
        </nav>
        <div className="settings-body">
          <Outlet />
        </div>
      </div>
    </>
  );
}
