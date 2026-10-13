import type { FullConfig } from '@playwright/test';

/** Makes sure the stack has synthetic data: logs in as admin and seeds if the database is empty. */
export default async function globalSetup(config: FullConfig) {
  const base = process.env.E2E_BASE_URL ?? config.projects[0]!.use.baseURL ?? 'http://localhost:5173';
  const login = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: process.env.E2E_ADMIN_PASSWORD ?? 'admin-demo-pass' }),
  });
  if (!login.ok)
    throw new Error(`E2E setup: cannot log in as admin (${login.status}). Is the backend running with demo users enabled?`);
  const { accessToken } = (await login.json()) as { accessToken: string };
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  const list = await fetch(`${base}/api/v1/payments?size=1`, { headers });
  const { totalItems } = (await list.json()) as { totalItems: number };
  if (totalItems === 0) {
    const seed = await fetch(`${base}/api/v1/admin/seed`, { method: 'POST', headers, body: JSON.stringify({ seed: 42 }) });
    if (!seed.ok) throw new Error(`E2E setup: seeding failed (${seed.status}). Simulation must be enabled.`);
  }
}
