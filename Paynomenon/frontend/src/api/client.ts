import type {
  AnalyticsAnswer,
  Anomaly,
  ApiErrorBody,
  Discrepancy,
  DeadLetter,
  FailureReason,
  Incident,
  IncidentDetail,
  IncidentReport,
  Investigation,
  LoginResponse,
  Overview,
  Page,
  Payment,
  PaymentEvent,
  ProcessorStats,
  ProviderStatus,
  ReconRun,
  SystemStatus,
  TrendPoint,
} from './types';

const TOKEN_KEY = 'paysense.token';

// sessionStorage can be unavailable (privacy modes); the app then simply keeps the token in memory for the session.
let memoryToken: string | null = null;
export const tokenStore = {
  get(): string | null {
    try {
      return sessionStorage.getItem(TOKEN_KEY) ?? memoryToken;
    } catch {
      return memoryToken;
    }
  },
  set(token: string | null): void {
    memoryToken = token;
    try {
      if (token) sessionStorage.setItem(TOKEN_KEY, token);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* in-memory only */
    }
  },
};

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorBody | null,
    message: string,
  ) {
    super(message);
  }
  get code(): string {
    return this.body?.code ?? 'NETWORK_ERROR';
  }
  get correlationId(): string | undefined {
    return this.body?.correlationId;
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

type Query = Record<string, string | number | boolean | undefined | null>;

function qs(q?: Query): string {
  if (!q) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

async function request<T>(
  method: string,
  path: string,
  opts: { query?: Query; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  const token = tokenStore.get();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}${qs(opts.query)}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiError(0, null, 'Cannot reach the PaySense API. Check that the backend is running.');
  }
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!res.ok) {
    const body = json && typeof json === 'object' && 'code' in json ? (json as ApiErrorBody) : null;
    if (res.status === 401 && path !== '/auth/login') onUnauthorized();
    throw new ApiError(res.status, body, body?.message ?? `Request failed (${res.status})`);
  }
  return json as T;
}

const get = <T>(path: string, query?: Query) => request<T>('GET', path, { query });
const post = <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
  request<T>('POST', path, { body: body ?? {}, headers });

export const newIdempotencyKey = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const api = {
  login: (username: string, password: string) => post<LoginResponse>('/auth/login', { username, password }),

  overview: (q?: Query) => get<Overview>('/analytics/overview', q),
  trends: (q?: Query) => get<TrendPoint[]>('/analytics/payment-trends', q),
  failureReasons: (q?: Query) => get<FailureReason[]>('/analytics/failure-reasons', q),
  processors: (q?: Query) => get<ProcessorStats[]>('/analytics/processors', q),

  payments: (q?: Query) => get<Page<Payment>>('/payments', q),
  payment: (id: string) => get<Payment>(`/payments/${id}`),
  paymentEvents: (id: string) => get<Page<PaymentEvent>>(`/payments/${id}/events`, { size: 100 }),
  createPayment: (body: { amount: number; currency: string; merchantId: string; processor: string; description?: string }) =>
    post<Payment>('/payments', body, { 'Idempotency-Key': newIdempotencyKey() }),
  operate: (id: string, op: 'authorize' | 'capture' | 'refund' | 'cancel') =>
    post<Payment>(`/payments/${id}/${op}`, {}, { 'Idempotency-Key': newIdempotencyKey() }),

  reconRuns: () => get<Page<ReconRun>>('/reconciliations', { size: 20 }),
  startRecon: (body: { processor: string; scenario?: string }) => post<ReconRun>('/reconciliations', body),
  discrepancies: (runId: string, q?: Query) =>
    get<Page<Discrepancy>>(`/reconciliations/${runId}/discrepancies`, { size: 100, ...q }),
  acknowledge: (id: string, explanation: string) =>
    post<Discrepancy>(`/reconciliations/discrepancies/${id}/acknowledge`, { explanation }),

  incidents: (q?: Query) => get<Page<Incident>>('/incidents', q),
  incident: (id: string) => get<IncidentDetail>(`/incidents/${id}`),
  resolveIncident: (id: string) => post<Incident>(`/incidents/${id}/resolve`),
  summarizeIncident: (id: string) => post<IncidentReport>(`/incidents/${id}/summarize`),
  anomalies: (q?: Query) => get<Page<Anomaly>>('/anomalies', q),
  detectAnomalies: () =>
    post<{ status: string; anomalies?: Anomaly[]; evaluated?: number; errorCategory?: string }>('/ai/anomalies/detect', {
      bucket: 'HOUR',
      evaluate_last: 6,
    }),

  investigate: (subjectType: string, subjectId: string, question: string) =>
    post<Investigation>('/ai/investigations', { subjectType, subjectId, question }),
  investigations: (q?: Query) => get<Page<Investigation>>('/ai/investigations', q),
  analyticsQuery: (question: string) => post<AnalyticsAnswer>('/ai/analytics-queries', { question }),
  runbookQuestion: (question: string) => post<Record<string, unknown>>('/ai/runbook-questions', { question }),
  providerStatus: () => get<ProviderStatus>('/ai/provider-status'),

  systemStatus: () => get<SystemStatus>('/system/status'),
  deadLetters: (status?: string) => get<Page<DeadLetter>>('/events/dead-letters', { status, size: 20 }),
  replayDeadLetter: (id: string, reason: string) =>
    post<{ id: string; status: string; outcome: string }>(`/admin/events/dead-letters/${id}/replay`, { reason }),
  seed: (replace = false) => post<{ payments: number }>('/admin/seed', { seed: 42, replace }),
};
