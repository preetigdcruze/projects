// Types mirror the backend's JSON. Optional fields are omitted by the API when null.

export interface Page<T> {
  items: T[];
  page: number;
  size: number;
  totalItems: number;
  totalPages: number;
}

export type Role = 'VIEWER' | 'INVESTIGATOR' | 'ADMIN';
export interface LoginResponse {
  accessToken: string;
  tokenType: string;
  expiresInSeconds: number;
  username: string;
  role: Role;
}

export type PaymentStatus =
  | 'CREATED'
  | 'PROCESSING'
  | 'AUTHORIZED'
  | 'CAPTURING'
  | 'CAPTURED'
  | 'REFUNDING'
  | 'REFUNDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'UNCERTAIN';

export interface Attempt {
  id: string;
  operation: string;
  attemptNumber: number;
  processor: string;
  processorRequestId: string;
  status: string;
  responseCode?: string;
  failureCategory?: string;
  responseTimeMs?: number;
  sanitizedResponse?: Record<string, unknown>;
  correlationId: string;
  startedAt: string;
  completedAt?: string;
}

export interface Payment {
  id: string;
  merchantId: string;
  amount: number;
  currency: string;
  processor: string;
  description?: string;
  status: PaymentStatus;
  pendingOperation?: string;
  failureCode?: string;
  failureCategory?: string;
  correlationId: string;
  synthetic: boolean;
  createdAt: string;
  updatedAt: string;
  authorizedAt?: string;
  capturedAt?: string;
  refundedAt?: string;
  failedAt?: string;
  attempts?: Attempt[];
}

export interface PaymentEvent {
  id: string;
  sequence: number;
  eventType: string;
  fromStatus?: string;
  toStatus?: string;
  source: string;
  actor: string;
  correlationId: string;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

export interface LatencySummary {
  p50?: number;
  p95?: number;
  p99?: number;
  sampleSize: number;
  sufficientSample: boolean;
  minSample: number;
}

export interface Overview {
  range: { from: string; to: string };
  totals: { total: number; successful: number; failed: number; pending: number; uncertain: number; cancelled: number };
  successRate?: number;
  volume: { currency: string; capturedAmount: number; capturedCount: number }[];
  latency: LatencySummary;
  syntheticDataPresent: boolean;
  openDiscrepancies: number;
  openIncidents: number;
  deadLetters: number;
  generatedAt: string;
}

export interface TrendPoint {
  bucketStart: string;
  total: number;
  successful: number;
  failed: number;
  uncertain: number;
  failureRate?: number;
}

export interface FailureReason {
  reason: string;
  category: string;
  count: number;
  share: number;
}

export interface ProcessorStats {
  processor: string;
  attempts: number;
  approved: number;
  declined: number;
  invalid: number;
  unavailable: number;
  timeouts: number;
  failureRate?: number;
  timeoutRate?: number;
  latency: LatencySummary;
}

export interface Anomaly {
  id: string;
  metric: string;
  dimension: string;
  windowStart: string;
  windowEnd: string;
  observed: number;
  baseline: number;
  threshold: number;
  score: number;
  direction: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  method: string;
  sampleSize: number;
  details: Record<string, unknown>;
  detectedAt: string;
}

export interface ReconRun {
  id: string;
  processor: string;
  windowFrom: string;
  windowTo: string;
  scenario: string;
  reportId: string;
  status: string;
  internalCount: number;
  reportCount: number;
  matchedCount: number;
  discrepancyCount: number;
  startedBy: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export type DiscrepancyType =
  | 'MISSING_FROM_REPORT'
  | 'MISSING_INTERNALLY'
  | 'AMOUNT_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'DUPLICATE_SETTLEMENT'
  | 'UNEXPECTED_STATE';

export interface Discrepancy {
  id: string;
  runId: string;
  type: DiscrepancyType;
  paymentReference: string;
  operation: string;
  internalAmount?: number;
  internalCurrency?: string;
  reportAmount?: number;
  reportCurrency?: string;
  internalStatus?: string;
  details: Record<string, unknown>;
  status: 'OPEN' | 'ACKNOWLEDGED';
  explanation?: string;
  acknowledgedBy?: string;
  acknowledgedAt?: string;
  createdAt: string;
}

export interface Incident {
  id: string;
  title: string;
  status: 'OPEN' | 'RESOLVED';
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  source: string;
  components: string[];
  description?: string;
  startedAt: string;
  resolvedAt?: string;
  aiReport?: IncidentReport;
  aiReportAt?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  counts: Record<string, number>;
}

export interface TimelineEntry {
  at: string;
  kind: string;
  refId?: string;
  title: string;
  detail?: string;
  paymentId?: string;
}

export interface IncidentDetail {
  incident: Incident;
  payments: {
    id: string;
    status: string;
    amount: number;
    currency: string;
    processor: string;
    failureCode?: string;
    createdAt: string;
  }[];
  anomalies: {
    id: string;
    metric: string;
    dimension: string;
    severity: string;
    observed: number;
    baseline: number;
    windowStart: string;
    windowEnd: string;
    detectedAt: string;
  }[];
  discrepancies: { id: string; type: string; paymentReference: string; status: string; createdAt: string }[];
  deadLetterIds: string[];
  timeline: TimelineEntry[];
}

// ---- AI layer responses -----------------------------------------------------------------------------------------

export interface Fact {
  id: string;
  kind: string;
  text: string;
  observedAt?: string;
  link?: string;
  untrustedText?: string;
  withheld: boolean;
}

export interface RunbookRef {
  source: string;
  title: string;
  docType: string;
  snippet: string;
  withheld: boolean;
}

export interface Hypothesis {
  statement: string;
  evidence_ids: string[];
  likelihood?: string;
}

export interface ValidationReport {
  rejectedCitations: string[];
  injectionFlags: string[];
  prohibitedActionAttempt: boolean;
  errors: string[];
}

export interface InvestigationResult {
  status: 'COMPLETED' | 'DEGRADED';
  subject: { type: string; id: string };
  question: string;
  facts: Fact[];
  findings: { text: string; evidenceIds: string[] }[];
  analysis?: {
    summary: string;
    most_likely_explanation: Hypothesis;
    supporting_evidence: { statement: string; evidence_ids: string[] }[];
    alternative_explanations: Hypothesis[];
    confidence: 'low' | 'medium' | 'high';
    confidence_explanation: string;
    recommended_diagnostic_steps: string[];
    missing_information: string[];
    insufficient_evidence: boolean;
  };
  confidenceMeaning: Record<string, string>;
  runbookGuidance: RunbookRef[];
  gaps: string[];
  validation: ValidationReport;
  provider?: string;
  model?: string;
  errorCategory?: string;
  notice?: string;
  generatedAt: string;
}

export interface Investigation {
  id: string;
  requestedBy: string;
  subjectType: 'PAYMENT' | 'INCIDENT' | 'ANOMALY';
  subjectId: string;
  question: string;
  status: 'RUNNING' | 'COMPLETED' | 'DEGRADED' | 'UNAVAILABLE' | 'FAILED';
  result?: InvestigationResult;
  provider?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs?: number;
  errorCategory?: string;
  createdAt: string;
  completedAt?: string;
}

export interface AnalyticsAnswer {
  status: 'COMPLETED' | 'DEGRADED' | 'UNSUPPORTED' | 'UNAVAILABLE';
  question?: string;
  explanation?: string;
  explanationSource?: 'llm' | 'template' | 'none';
  operations?: {
    id: string;
    name: string;
    args: Record<string, unknown>;
    endpoint: string;
    timeRange: { from: string; to: string };
  }[];
  metricsUsed?: string[];
  timeRange?: { from: string; to: string };
  results?: Record<string, { name: string; data: unknown }>;
  dashboardLink?: string;
  supportedOperations?: string[];
  gaps?: string[];
  plannerSource?: string;
  notice?: string;
  errorCategory?: string;
  message?: string;
  provider?: string;
  model?: string;
}

export interface IncidentReport {
  status: 'COMPLETED' | 'DEGRADED';
  incidentId: string;
  title: string;
  timeWindow: { start?: string; end?: string };
  affectedComponents: string[];
  failureCounts: Record<string, number>;
  impact: {
    paymentsAffected: number;
    amountAtRiskByCurrency: Record<string, string>;
    failureCodes: Record<string, number>;
    basis: string;
  };
  facts: Fact[];
  narrative?: {
    title: string;
    likely_causes: { statement: string; evidence_ids: string[]; confidence: string }[];
    key_events: { text: string; evidence_ids: string[] }[];
    investigation_steps: string[];
    mitigation_steps: { text: string; runbook_source?: string }[];
    uncertainties: string[];
    missing_evidence: string[];
  };
  runbookGuidance: RunbookRef[];
  gaps: string[];
  remediationClaims: string;
  provider?: string;
  model?: string;
  errorCategory?: string;
  notice?: string;
  generatedAt: string;
}

export interface ProviderStatus {
  status: string;
  provider?: string;
  model?: string;
  configured?: boolean;
  requests?: number;
  successes?: number;
  errorCounts?: Record<string, number>;
  recentErrorCategories?: Record<string, number>;
  promptTokens?: number;
  completionTokens?: number;
  errorCategory?: string;
}

export interface SystemStatus {
  generatedAt: string;
  backend: { status: string; environment: string; startedAt: string; version: string };
  database: { status: string; detail?: string };
  redis: { status: string; detail?: string };
  ai: { status: string; detail?: string };
  events: {
    transport: string;
    outbox: { pending: number; failed: number; published: number; oldestPendingAgeSeconds?: number } | { error: string };
    deadLetters: { dead: number; replayed: number } | { error: string };
    consumerLag?: number;
    consumerLagAvailable: boolean;
  };
  processors: { name: string; circuit: 'CLOSED' | 'OPEN' | 'HALF_OPEN' }[];
  simulation: { enabled: boolean; realDelay: boolean };
}

export interface DeadLetter {
  id: string;
  consumer: string;
  eventId?: string;
  eventType?: string;
  errorClass: string;
  errorMessage?: string;
  attempts: number;
  status: 'DEAD' | 'REPLAYED';
  replayCount: number;
  replayedBy?: string;
  failedAt: string;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  status: number;
  correlationId?: string;
  details?: { field: string; message: string }[];
}
