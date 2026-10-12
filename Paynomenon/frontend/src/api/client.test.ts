import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, newIdempotencyKey, tokenStore } from './client';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('api client', () => {
  beforeEach(() => tokenStore.set(null));
  afterEach(() => vi.restoreAllMocks());

  it('sends the bearer token and builds query strings without empty values', async () => {
    tokenStore.set('tok');
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(json(200, { items: [], page: 0, size: 20, totalItems: 0, totalPages: 0 }));
    await api.payments({ page: 0, status: undefined, q: '', processor: 'MOCK_PROCESSOR' });
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe('/api/v1/payments?page=0&processor=MOCK_PROCESSOR');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('turns structured error bodies into ApiError with code and correlation id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(409, { code: 'INVALID_STATE_TRANSITION', message: 'nope', status: 409, correlationId: 'abc' }),
    );
    const err = await api.operate('p1', 'capture').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('INVALID_STATE_TRANSITION');
    expect(err.correlationId).toBe('abc');
  });

  it('reports network failures distinctly', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('failed'));
    const err = await api.overview().catch((e) => e);
    expect(err.status).toBe(0);
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.message).toMatch(/Cannot reach/);
  });

  it('calls the unauthorized handler on 401 except for login', async () => {
    const { setUnauthorizedHandler } = await import('./client');
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(401, { code: 'UNAUTHENTICATED', message: 'x', status: 401 }));
    await api.overview().catch(() => {});
    expect(handler).toHaveBeenCalledTimes(1);
    await api.login('a', 'b').catch(() => {});
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('adds an idempotency key to mutating payment calls, a fresh one each time', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json(200, {}));
    await api.operate('p1', 'authorize');
    await api.operate('p1', 'authorize');
    const keys = spy.mock.calls.map(([, init]) => (init!.headers as Record<string, string>)['Idempotency-Key']);
    expect(keys[0]).toBeTruthy();
    expect(keys[0]).not.toBe(keys[1]);
    expect(newIdempotencyKey()).toMatch(/[0-9a-f-]{8,}/);
  });
});
