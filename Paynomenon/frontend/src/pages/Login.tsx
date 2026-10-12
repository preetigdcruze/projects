import { useState, type FormEvent } from 'react';
import { describeError, ErrorBanner } from '../components/ui';
import { useAuth } from '../auth/AuthContext';

export function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await login(username, password);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login card">
      <h1>PaySense</h1>
      <p className="muted">Payment intelligence platform · simulated payments only</p>
      <form onSubmit={submit} className="stack" aria-label="Sign in">
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error ? <ErrorBanner error={error} /> : null}
        <button className="primary" disabled={busy} type="submit">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="muted small">
        Development accounts (viewer, investigator, admin) are configured in <code>.env</code>; see the README.
      </p>
      <span className="sr-only">{error ? describeError(error) : ''}</span>
    </div>
  );
}
