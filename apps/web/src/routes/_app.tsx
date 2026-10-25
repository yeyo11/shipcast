import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { SmoothScroll } from '../components/SmoothScroll';
import { ToastProvider } from '../components/Toasts';
import { Avatar } from '../components/ui';
import { whoAmI } from '../server/session.functions';

export const Route = createFileRoute('/_app')({
  loader: () => whoAmI(),
  component: Shell,
});

const SECTIONS = [
  { to: '/', label: 'Launches' },
  { to: '/launch', label: 'Launch a repo' },
  { to: '/write', label: 'Write' },
  { to: '/channels', label: 'Channels' },
  { to: '/automation', label: 'Automation' },
  { to: '/ai', label: 'AI' },
  { to: '/tokens', label: 'API' },
  { to: '/settings', label: 'Settings' },
] as const;

function Shell() {
  const { login, name, avatarUrl } = Route.useLoaderData();
  return (
    <ToastProvider>
      <SmoothScroll />
      <header className="top wrap">
        <Link to="/" className="lockup" aria-label="Shipcast, the launches">
          <img src="/logo/mark.svg" alt="" />
          <span>Shipcast</span>
        </Link>
        <nav className="nav" aria-label="Sections">
          {SECTIONS.map((s) => (
            <Link key={s.to} to={s.to} activeOptions={{ exact: s.to === '/' }}>
              {s.label}
            </Link>
          ))}
        </nav>
        <div className="who">
          <Avatar src={avatarUrl} alt="" size={28} />
          <span title={name ?? undefined}>@{login}</span>
          <form method="post" action="/auth/logout">
            <button className="btn btn-small" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main className="wrap">
        <Outlet />
      </main>
    </ToastProvider>
  );
}
