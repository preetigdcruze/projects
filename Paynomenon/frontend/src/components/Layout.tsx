import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

const LINKS = [
  ['/', 'Overview'],
  ['/payments', 'Payments'],
  ['/reconciliation', 'Reconciliation'],
  ['/investigations', 'AI Investigation'],
  ['/incidents', 'Incidents'],
  ['/system', 'System Health'],
] as const;

export function Layout() {
  const { session, logout } = useAuth();
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" /> PaySense
        </div>
        <nav aria-label="Main" style={{ display: 'contents' }}>
          {LINKS.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="spacer" />
        <div className="userbox">
          <div>
            <strong>{session?.username}</strong> <span className="badge">{session?.role}</span>
          </div>
          <button style={{ marginTop: 8 }} onClick={logout}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="main" id="main">
        <Outlet />
      </main>
    </div>
  );
}
