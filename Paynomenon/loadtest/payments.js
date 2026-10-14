// PaySense load tests (k6). One file, several scenarios selected with SCENARIO=<name>:
//   throughput   open-model load of create -> authorize -> (capture) flows; reports latency percentiles and error rate
//   duplicates   concurrent duplicate create requests with the same Idempotency-Key; verifies exactly-one-payment semantics
//   outage       steady load while a controller turns processor failures on and off; shows breaker behaviour and recovery
//   list         read-heavy: payment list filtered by status
//   search       read-heavy: free-text payment search (used for the trigram-index before/after experiment)
// Every run also measures how long the outbox needs to drain after the load (event processing throughput).
//
//   k6 run -e SCENARIO=throughput -e RATE=30 -e DURATION=60s loadtest/payments.js
//
// Environment: BASE_URL (http://localhost:8080), ADMIN_PASSWORD (admin-demo-pass), RATE, DURATION, VUS.
import http from 'k6/http';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';
const SCENARIO = __ENV.SCENARIO || 'throughput';
const RATE = Number(__ENV.RATE || 30);
const DURATION = __ENV.DURATION || '60s';
const OUTAGE_START = Number(__ENV.OUTAGE_START || 20); // seconds after test start
const OUTAGE_END = Number(__ENV.OUTAGE_END || 40);

const flowSuccess = new Rate('flow_success');
const duplicateConsistent = new Rate('duplicate_requests_consistent');
const duplicateCreated = new Counter('payments_created_by_duplicate_test');
const recovery = new Trend('recovery_seconds_after_outage');
const drain = new Trend('outbox_drain_seconds');
const eventsPublished = new Counter('outbox_events_published');
const circuitRejected = new Counter('circuit_open_rejections');
const unavailable503 = new Counter('responses_503_processor_unavailable');

const scenarios = {
  throughput: {
    executor: 'constant-arrival-rate', rate: RATE, timeUnit: '1s', duration: DURATION, preAllocatedVUs: 40, maxVUs: 300, exec: 'flow',
  },
  duplicates: {
    executor: 'constant-vus', vus: Number(__ENV.VUS || 20), duration: DURATION, exec: 'duplicates',
  },
  outage: {
    load: { executor: 'constant-arrival-rate', rate: RATE, timeUnit: '1s', duration: DURATION, preAllocatedVUs: 40, maxVUs: 300, exec: 'outageFlow' },
    outage_on: { executor: 'per-vu-iterations', vus: 1, iterations: 1, startTime: `${OUTAGE_START}s`, exec: 'outageOn' },
    outage_off: { executor: 'per-vu-iterations', vus: 1, iterations: 1, startTime: `${OUTAGE_END}s`, exec: 'outageOff' },
    recovery_probe: { executor: 'constant-vus', vus: 1, duration: DURATION, startTime: `${OUTAGE_END}s`, exec: 'recoveryProbe' },
  },
  list: {
    executor: 'constant-arrival-rate', rate: RATE, timeUnit: '1s', duration: DURATION, preAllocatedVUs: 20, maxVUs: 200, exec: 'list',
  },
  search: {
    executor: 'constant-arrival-rate', rate: RATE, timeUnit: '1s', duration: DURATION, preAllocatedVUs: 20, maxVUs: 200, exec: 'search',
  },
};

export const options = {
  scenarios: SCENARIO === 'outage' ? scenarios.outage : { [SCENARIO]: scenarios[SCENARIO] },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  thresholds: thresholds(),
};

// Targets for a single developer machine: they flag regressions, they are not performance claims.
function thresholds() {
  if (SCENARIO === 'throughput') {
    return { http_req_failed: ['rate<0.01'], 'http_req_duration{name:create}': ['p(95)<400'], 'http_req_duration{name:authorize}': ['p(95)<1500'], 'http_req_duration{name:capture}': ['p(95)<2000'], flow_success: ['rate>0.99'] };
  }
  if (SCENARIO === 'duplicates') return { duplicate_requests_consistent: ['rate==1'], http_req_failed: ['rate<0.01'] };
  if (SCENARIO === 'list') return { http_req_failed: ['rate<0.01'], 'http_req_duration{name:list}': ['p(95)<2000'] };
  if (SCENARIO === 'search') return { http_req_failed: ['rate<0.01'], 'http_req_duration{name:search}': ['p(95)<2000'] };
  return {}; // outage: errors are expected and are the point of the experiment
}

const json = { 'Content-Type': 'application/json' };
const headers = (token, extra = {}) => ({ ...json, Authorization: `Bearer ${token}`, ...extra });
const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16); });
const body = (amount) => JSON.stringify({ amount, currency: 'EUR', merchantId: 'merchant-load', processor: Math.random() < 0.5 ? 'MOCK_PROCESSOR' : 'MOCK_PROCESSOR_EU', description: 'k6 load test' });
const amount = () => (5 + Math.floor(Math.random() * 20000) / 100).toFixed(2);

function login() {
  const res = http.post(`${BASE}/api/v1/auth/login`, JSON.stringify({ username: 'admin', password: __ENV.ADMIN_PASSWORD || 'admin-demo-pass' }), { headers: json });
  if (res.status !== 200) throw new Error(`login failed (${res.status}); is the backend running with demo users?`);
  return res.json('accessToken');
}

function outboxStats(token) {
  const r = http.get(`${BASE}/api/v1/events/outbox/stats`, { headers: headers(token) });
  return r.status === 200 ? r.json() : null;
}

export function setup() {
  const token = login();
  return { token, startedAt: Date.now(), outbox: outboxStats(token) };
}

export function teardown(data) {
  // Event processing throughput: how long until the outbox publisher has drained everything the load created?
  const started = Date.now();
  let stats = outboxStats(data.token);
  while (stats && stats.pending > 0 && Date.now() - started < 120000) {
    sleep(0.5);
    stats = outboxStats(data.token);
  }
  if (stats && data.outbox) {
    drain.add((Date.now() - started) / 1000);
    eventsPublished.add(stats.published - data.outbox.published);
    console.log(`outbox: ${stats.published - data.outbox.published} events published during the run, drained in ${(Date.now() - started) / 1000}s after the load stopped, failed=${stats.failed}`);
  }
}

// ---- scenarios ---------------------------------------------------------------------------------------------------

export function flow(data) {
  const create = http.post(`${BASE}/api/v1/payments`, body(amount()), { headers: headers(data.token, { 'Idempotency-Key': uuid() }), tags: { name: 'create' } });
  let ok = check(create, { 'created (201)': (r) => r.status === 201 });
  if (!ok) { flowSuccess.add(false); return; }
  const id = create.json('id');
  const auth = http.post(`${BASE}/api/v1/payments/${id}/authorize`, '{}', { headers: headers(data.token, { 'Idempotency-Key': uuid() }), tags: { name: 'authorize' } });
  ok = check(auth, { 'authorize answered (200/202)': (r) => r.status === 200 || r.status === 202 });
  if (ok && auth.status === 200 && auth.json('status') === 'AUTHORIZED' && Math.random() < 0.5) {
    const cap = http.post(`${BASE}/api/v1/payments/${id}/capture`, '{}', { headers: headers(data.token, { 'Idempotency-Key': uuid() }), tags: { name: 'capture' } });
    ok = check(cap, { 'capture answered (200/202)': (r) => r.status === 200 || r.status === 202 });
  }
  flowSuccess.add(ok);
}

export function duplicates(data) {
  const key = uuid();
  const payload = body('42.00');
  const reqs = Array.from({ length: 5 }, () => ['POST', `${BASE}/api/v1/payments`, payload, { headers: headers(data.token, { 'Idempotency-Key': key }), tags: { name: 'duplicate_create' } }]);
  const res = http.batch(reqs);
  const ids = new Set(res.filter((r) => r.status === 201).map((r) => r.json('id')));
  const consistent = res.every((r) => r.status === 201) && ids.size === 1;
  duplicateConsistent.add(consistent);
  duplicateCreated.add(ids.size);
  check(res, { 'all five duplicates answered 201': (rs) => rs.every((r) => r.status === 201) });
  if (!consistent) console.error(`inconsistent duplicate handling for key ${key}: statuses=${res.map((r) => r.status)} ids=${[...ids]}`);
}

function phase() {
  const t = (Date.now() - exec.scenario.startTime) / 1000;
  return t < OUTAGE_START ? 'before' : t < OUTAGE_END ? 'during' : 'after';
}

export function outageFlow(data) {
  const p = phase();
  const create = http.post(`${BASE}/api/v1/payments`, body(amount()), { headers: headers(data.token), tags: { name: 'create', phase: p } });
  if (create.status !== 201) { flowSuccess.add(false); return; }
  const auth = http.post(`${BASE}/api/v1/payments/${create.json('id')}/authorize`, '{}', { headers: headers(data.token), tags: { name: 'authorize', phase: p } });
  if (auth.status === 503) {
    unavailable503.add(1, { phase: p });
    if ((auth.json('message') || '').includes('Circuit')) circuitRejected.add(1, { phase: p });
  }
  // a 503 while the processor is down is the *correct* answer: nothing was changed and the client may retry
  flowSuccess.add(auth.status === 200 || auth.status === 202 || (auth.status === 503 && p === 'during'));
}

const setSim = (token, body) => http.put(`${BASE}/api/v1/dev/simulation/MOCK_PROCESSOR`, JSON.stringify(body), { headers: headers(token) });
const setSimEu = (token, body) => http.put(`${BASE}/api/v1/dev/simulation/MOCK_PROCESSOR_EU`, JSON.stringify(body), { headers: headers(token) });
export function outageOn(data) { setSim(data.token, { unavailableRate: 1.0 }); setSimEu(data.token, { unavailableRate: 1.0 }); console.log(`outage started at t=${OUTAGE_START}s`); }
export function outageOff(data) { setSim(data.token, {}); setSimEu(data.token, {}); console.log(`processors recovered at t=${OUTAGE_END}s`); }

let recovered = false;
export function recoveryProbe(data) {
  if (!recovered) {
    const create = http.post(`${BASE}/api/v1/payments`, body('1.00'), { headers: headers(data.token), tags: { name: 'probe_create' } });
    const auth = http.post(`${BASE}/api/v1/payments/${create.json('id')}/authorize`, '{}', { headers: headers(data.token), tags: { name: 'probe_authorize' } });
    if (auth.status === 200) {
      recovered = true;
      recovery.add(exec.scenario.iterationInTest === 0 ? 0 : (Date.now() - exec.scenario.startTime) / 1000);
      console.log(`first successful authorization ${(Date.now() - exec.scenario.startTime) / 1000}s after the processors recovered`);
    }
  }
  sleep(0.5);
}

export function list(data) {
  const statuses = ['FAILED', 'CAPTURED', 'AUTHORIZED', 'UNCERTAIN'];
  const s = statuses[Math.floor(Math.random() * statuses.length)];
  const r = http.get(`${BASE}/api/v1/payments?status=${s}&size=20&sort=createdAt,desc`, { headers: headers(data.token), tags: { name: 'list' } });
  check(r, { 'list 200': (x) => x.status === 200 });
}

export function search(data) {
  const n = 1 + Math.floor(Math.random() * Number(__ENV.ROWS || 500000));
  const r = http.get(`${BASE}/api/v1/payments?q=order-${n}&size=20`, { headers: headers(data.token), tags: { name: 'search' } });
  check(r, { 'search 200': (x) => x.status === 200 });
}

export function handleSummary(data) {
  const name = __ENV.RESULT_NAME || SCENARIO;
  return { [`loadtest/results/${name}.json`]: JSON.stringify(data, null, 1), stdout: textSummary(data) };
}

function textSummary(data) {
  const m = data.metrics;
  const t = (k) => (m[k] ? m[k].values : null);
  const line = (label, k) => { const v = t(k); return v ? `  ${label.padEnd(26)} avg=${v.avg.toFixed(1)}ms  p50=${v.med.toFixed(1)}ms  p95=${v['p(95)'].toFixed(1)}ms  p99=${v['p(99)'].toFixed(1)}ms  max=${v.max.toFixed(0)}ms\n` : ''; };
  const reqs = m.http_reqs ? m.http_reqs.values : { count: 0, rate: 0 };
  let out = `\n=== PaySense load test: ${SCENARIO} ===\n`;
  out += `  requests: ${reqs.count} (${reqs.rate.toFixed(1)}/s)   http errors: ${((m.http_req_failed?.values.rate ?? 0) * 100).toFixed(2)}%   iterations: ${m.iterations?.values.count ?? 0}\n`;
  out += line('all requests', 'http_req_duration');
  for (const n of ['create', 'authorize', 'capture', 'duplicate_create', 'list', 'search']) out += line(n, `http_req_duration{name:${n}}`);
  if (m.flow_success && m.flow_success.values.passes + m.flow_success.values.fails > 0) out += `  flow success rate: ${(m.flow_success.values.rate * 100).toFixed(2)}%\n`;
  if (m.duplicate_requests_consistent && m.duplicate_requests_consistent.values.passes + m.duplicate_requests_consistent.values.fails > 0) out += `  duplicate batches consistent: ${(m.duplicate_requests_consistent.values.rate * 100).toFixed(2)}% (${m.duplicate_requests_consistent.values.passes}/${m.duplicate_requests_consistent.values.passes + m.duplicate_requests_consistent.values.fails}); payments created by duplicate test: ${m.payments_created_by_duplicate_test?.values.count}\n`;
  if (m.outbox_drain_seconds) out += `  outbox: ${m.outbox_events_published?.values.count} events, drained ${m.outbox_drain_seconds.values.avg.toFixed(1)}s after the load\n`;
  if (m.recovery_seconds_after_outage) out += `  recovery after outage: ${m.recovery_seconds_after_outage.values.avg.toFixed(1)}s until the first successful authorization\n`;
  if (m.responses_503_processor_unavailable) out += `  503 responses while processors were down: ${m.responses_503_processor_unavailable.values.count} (circuit-open rejections: ${m.circuit_open_rejections?.values.count ?? 0})\n`;
  return out;
}
