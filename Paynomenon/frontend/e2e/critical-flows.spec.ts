import { expect, test } from '@playwright/test';
import { goTo, login, uiLogin } from './helpers';

test.describe('critical operator workflows', () => {
  test('signs in through the login form, rejects bad credentials and signs out', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Username').fill('viewer');
    await page.getByLabel('Password').fill('definitely-wrong');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText('Invalid username or password');
    await uiLogin(page, 'viewer');
    await expect(page.getByText('viewer', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('opens the dashboard and shows real, labelled synthetic data', async ({ page }) => {
    await login(page, 'viewer');
    await expect(page.getByText('Synthetic demo data.')).toBeVisible();
    await expect(page.getByText('Captured volume')).toBeVisible();
    await expect(page.getByText('Success rate')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Failure rate over time' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Processor comparison' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'MOCK_PROCESSOR_EU' }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: /Active incidents/ })).toBeVisible();
  });

  test('browses payment history with filters and pagination', async ({ page }) => {
    await login(page, 'viewer');
    await goTo(page, 'Payments');
    await expect(page.getByRole('table', { name: 'Payments' })).toBeVisible();
    await expect(page.getByTestId('payment-row')).toHaveCount(15);
    await expect(page.getByText(/Page 1 of \d+/)).toBeVisible();
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText(/Page 2 of \d+/)).toBeVisible();

    await page.getByLabel('Status').selectOption('FAILED');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByTestId('payment-row').first()).toBeVisible();
    const statuses = await page.getByTestId('payment-row').locator('td:nth-child(2) .badge').allTextContents();
    expect(statuses.length).toBeGreaterThan(0);
    expect(new Set(statuses)).toEqual(new Set(['FAILED']));

    await page.getByLabel('Status').selectOption('');
    await page.getByLabel(/Search/).fill('no-such-payment-xyz');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByText('No payments match these filters.')).toBeVisible();
  });

  test('inspects a failed payment: state timeline, processor attempts, correlation ids', async ({ page }) => {
    await login(page, 'viewer');
    await goTo(page, 'Payments');
    await page.getByLabel('Status').selectOption('FAILED');
    await page.getByRole('button', { name: 'Apply' }).click();
    await page.getByTestId('payment-row').first().click();
    await expect(page.getByRole('heading', { name: /Payment/ })).toBeVisible();
    await expect(page.locator('.badge', { hasText: 'FAILED' }).first()).toBeVisible();
    const timeline = page.getByRole('list', { name: 'Audit events' });
    await expect(timeline).toContainText('PAYMENT_CREATED');
    await expect(timeline).toContainText('OPERATION_DECLINED');
    await expect(page.getByRole('table', { name: 'Processor attempts' })).toContainText('DECLINED');
    await expect(page.getByText('Correlation ID')).toBeVisible();
    // a viewer sees no action buttons
    await expect(page.getByText('Read-only (viewer role)')).toBeVisible();
  });

  test('runs an AI investigation with the mock provider and distinguishes facts from interpretation', async ({ page }) => {
    await login(page, 'investigator');
    await goTo(page, 'AI Investigation');
    await expect(page.getByTestId('provider-badge')).toContainText('AI provider');
    await page.getByLabel('Pick subject').selectOption({ index: 1 });
    await page.getByRole('button', { name: 'Run investigation' }).click();

    const result = page.getByTestId('investigation-result');
    await expect(result).toBeVisible({ timeout: 30_000 });
    const facts = result.getByRole('region', { name: 'Verified facts' });
    await expect(facts).toContainText('retrieved from the system');
    await expect(facts.locator('li').first()).toBeVisible();
    const ai = result.getByRole('region', { name: 'AI interpretation' });
    await expect(ai).toContainText('hypothesis, not verified fact');
    await expect(ai).toContainText('Most likely explanation');
    await expect(ai).toContainText('Confidence:');
    await expect(ai).toContainText('Recommended diagnostic steps');
    // every cited evidence id is one of the retrieved facts
    const factIds = await facts.locator('.chip').allTextContents();
    const cited = await ai.locator('.chip').allTextContents();
    expect(cited.length).toBeGreaterThan(0);
    for (const id of cited) expect(factIds).toContain(id);
    await expect(result.getByRole('region', { name: 'Runbook guidance' })).toContainText('reference material, not evidence');
  });

  test('answers a natural-language analytics question from real query results', async ({ page }) => {
    await login(page, 'investigator');
    await goTo(page, 'AI Investigation');
    await page.getByRole('tab', { name: 'Ask analytics' }).click();
    await page.getByRole('button', { name: 'Which processor has the highest failure rate today?' }).click();
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    const answer = page.getByTestId('analytics-answer');
    await expect(answer).toBeVisible({ timeout: 30_000 });
    await expect(answer).toContainText('MOCK_PROCESSOR');
    await expect(answer).toContainText('processor_stats');
    await expect(answer).toContainText('Time range');
  });

  test('reviews a reconciliation discrepancy and acknowledges it with an explanation', async ({ page }) => {
    await login(page, 'investigator');
    await goTo(page, 'Reconciliation');
    const runs = page.getByTestId('recon-run');
    await expect(runs.first()).toBeVisible();
    await runs.filter({ hasText: 'injected defects' }).first().click();
    const table = page.getByRole('table', { name: 'Discrepancies' });
    await expect(table).toBeVisible();
    await page.getByLabel('Filter by type').selectOption('AMOUNT_MISMATCH');
    await expect(page.getByTestId('discrepancy-row')).toHaveCount(1);
    await page.getByTestId('discrepancy-row').click();
    const evidence = page.getByRole('region', { name: 'Discrepancy evidence' });
    await expect(evidence).toContainText('Internal (ledger)');
    await expect(evidence).toContainText('Processor report');
    const ack = evidence.getByRole('form', { name: 'Acknowledge discrepancy' });
    if (await ack.isVisible()) {
      await ack.getByRole('textbox').fill('Processor confirmed a rounding defect on their side (ticket E2E-1).');
      await ack.getByRole('button', { name: 'Acknowledge' }).click();
    }
    await expect(evidence).toContainText('Acknowledged by');
    await expect(evidence).toContainText('rounding defect');
  });

  test('shows system health: services, outbox, dead letters and the AI provider', async ({ page }) => {
    await login(page, 'viewer');
    await goTo(page, 'System Health');
    await expect(page.getByRole('heading', { name: 'System Health' })).toBeVisible();
    await expect(page.getByText('Backend', { exact: true })).toBeVisible();
    await expect(page.locator('.stat', { hasText: 'Database' }).locator('.badge')).toHaveText('UP');
    await expect(page.getByTestId('outbox-pending')).toBeVisible();
    await expect(page.getByRole('heading', { name: /Dead-letter queue/ })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Dead letters' })).toContainText('discrepancy-incident-linker');
    await expect(page.getByRole('heading', { name: 'AI provider' })).toBeVisible();
    // viewers cannot replay
    await expect(page.getByRole('button', { name: 'Replay' })).toHaveCount(0);
  });

  test('views an incident with its timeline and anomaly evidence', async ({ page }) => {
    await login(page, 'viewer');
    await goTo(page, 'Incidents');
    await expect(page.getByTestId('incident-row').first()).toBeVisible();
    await page.getByTestId('incident-row').filter({ hasText: 'Elevated failures' }).first().click();
    await expect(page.getByRole('list', { name: 'Incident timeline' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Linked payments' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Investigation history' })).toBeVisible();
  });

  test('creates, authorizes and captures a payment from the UI', async ({ page }) => {
    await login(page, 'investigator');
    await goTo(page, 'Payments');
    await page.getByRole('button', { name: 'New payment' }).click();
    await page.getByRole('form', { name: 'New payment' }).getByLabel('Amount').fill('12.34');
    await page.getByRole('button', { name: 'Create payment' }).click();
    await expect(page.locator('.badge', { hasText: 'CREATED' }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Authorize' }).click();
    await expect(page.getByText(/authorize finished: payment is now AUTHORIZED/)).toBeVisible();
    await page.getByRole('button', { name: 'Capture' }).click();
    await expect(page.getByText(/capture finished: payment is now CAPTURED/)).toBeVisible();
    await expect(page.getByRole('list', { name: 'Audit events' })).toContainText('OPERATION_SUCCEEDED');
    // refund is an admin-only action
    await expect(page.getByRole('button', { name: /Refund/ })).toBeDisabled();
  });

  test('role boundaries are visible in the UI', async ({ page }) => {
    await login(page, 'viewer');
    await goTo(page, 'Payments');
    await expect(page.getByRole('button', { name: 'New payment' })).toHaveCount(0);
    await goTo(page, 'AI Investigation');
    await expect(page.getByText(/requires the INVESTIGATOR role/)).toBeVisible();
  });
});
