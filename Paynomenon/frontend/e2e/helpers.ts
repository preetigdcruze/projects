import { expect, type Page } from '@playwright/test';

export const USERS = {
  viewer: { user: 'viewer', password: process.env.E2E_VIEWER_PASSWORD ?? 'viewer-demo-pass' },
  investigator: { user: 'investigator', password: process.env.E2E_INVESTIGATOR_PASSWORD ?? 'investigator-demo-pass' },
  admin: { user: 'admin', password: process.env.E2E_ADMIN_PASSWORD ?? 'admin-demo-pass' },
} as const;

const sessions = new Map<string, { token: string; role: string }>();

/**
 * Signs in through the real API once per role (tokens are cached for the whole run, which also keeps the suite clear of
 * the login rate limit) and primes the app's session storage. `uiLogin` exercises the actual login form.
 */
export async function login(page: Page, who: keyof typeof USERS) {
  let s = sessions.get(who);
  if (!s) {
    const res = await page.request.post('/api/v1/auth/login', {
      data: { username: USERS[who].user, password: USERS[who].password },
    });
    expect(res.ok(), `login as ${who}`).toBeTruthy();
    const body = (await res.json()) as { accessToken: string; role: string };
    s = { token: body.accessToken, role: body.role };
    sessions.set(who, s);
  }
  const { token, role } = s;
  await page.addInitScript(
    ([t, session]) => {
      sessionStorage.setItem('paysense.token', t!);
      sessionStorage.setItem('paysense.session', session!);
    },
    [token, JSON.stringify({ username: USERS[who].user, role })],
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
}

export async function uiLogin(page: Page, who: keyof typeof USERS) {
  await page.goto('/');
  await page.getByLabel('Username').fill(USERS[who].user);
  await page.getByLabel('Password').fill(USERS[who].password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
}

/** Clicks an item of the main navigation (other links on a page may share the same text). */
export async function goTo(page: Page, name: string) {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true }).click();
}
