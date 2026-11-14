import { linkWithApi } from './api';
import { Capture } from './pages/Capture';
import { Dashboard } from './pages/Dashboard';

// Two routes, so no router: the path picks the page and links are plain page loads.
export function App() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return <Dashboard />;
  if (path === '/capture') return <Capture />;
  return (
    <main className="not-found">
      <h1>Home memory</h1>
      <p>There is no page at {path}.</p>
      <p>
        <a href={linkWithApi('/')}>Dashboard</a> or <a href={linkWithApi('/capture')}>Capture page</a>
      </p>
    </main>
  );
}
