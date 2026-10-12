import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Banner, DataState, ErrorBanner, KeyValues, StatusBadge } from '../components/ui';
import { formatDateTime, formatMoney, ms } from '../format';
import { useAsync } from '../hooks';
import type { Payment, PaymentEvent } from '../api/types';

function eventTone(e: PaymentEvent): string {
  if (['OPERATION_DECLINED', 'OUTCOME_UNCERTAIN'].includes(e.eventType))
    return e.eventType === 'OUTCOME_UNCERTAIN' ? 'warn' : 'bad';
  if (['OPERATION_SUCCEEDED', 'OUTCOME_RESOLVED'].includes(e.eventType)) return 'ok';
  return '';
}

export function PaymentDetail() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const payment = useAsync(() => api.payment(id), [id]);
  const events = useAsync(() => api.paymentEvents(id), [id]);
  const [action, setAction] = useState<{ busy?: string; error?: unknown; message?: string }>({});

  async function run(op: 'authorize' | 'capture' | 'refund' | 'cancel') {
    setAction({ busy: op });
    try {
      const p = await api.operate(id, op);
      setAction({
        message: `${op} finished: payment is now ${p.status}${p.status === 'UNCERTAIN' ? ' (the processor outcome is unknown and will be reconciled)' : ''}.`,
      });
    } catch (e) {
      setAction({ error: e });
    } finally {
      payment.reload();
      events.reload();
    }
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <p className="small">
            <Link to="/payments">← Payments</Link>
          </p>
          <h1>
            Payment <span className="mono">{id.slice(0, 8)}</span>
          </h1>
        </div>
        <Link
          className="btn"
          to={`/investigations?subjectType=PAYMENT&subjectId=${id}`}
          style={{ padding: '7px 12px', border: '1px solid var(--border)', borderRadius: 8 }}
        >
          Investigate with AI
        </Link>
      </div>

      <DataState data={payment.data} loading={payment.loading} error={payment.error} reload={payment.reload}>
        {(p) => (
          <>
            {p.synthetic && <Banner kind="info">Synthetic demo payment.</Banner>}
            {p.status === 'UNCERTAIN' && (
              <Banner kind="warn">
                The processor did not answer in time, so the outcome of <strong>{p.pendingOperation}</strong> is unknown. PaySense
                will look it up at the processor; it will not retry the charge.
              </Banner>
            )}
            <div className="card">
              <div className="row between">
                <h2 style={{ margin: 0 }}>
                  {formatMoney(p.amount, p.currency)} <StatusBadge status={p.status} />
                </h2>
                <Actions payment={p} busy={action.busy} onRun={run} canOperate={can('INVESTIGATOR')} canRefund={can('ADMIN')} />
              </div>
              {action.message && (
                <div style={{ marginTop: 10 }}>
                  <Banner kind="ok">{action.message}</Banner>
                </div>
              )}
              {action.error ? (
                <div style={{ marginTop: 10 }}>
                  <ErrorBanner error={action.error} />
                </div>
              ) : null}
              <div style={{ marginTop: 14 }}>
                <KeyValues
                  items={[
                    [
                      'Payment ID',
                      <span className="mono" key="i">
                        {p.id}
                      </span>,
                    ],
                    [
                      'Correlation ID',
                      <span className="mono" key="c">
                        {p.correlationId}
                      </span>,
                    ],
                    ['Merchant', p.merchantId],
                    ['Processor', p.processor],
                    ['Description', p.description ?? '—'],
                    ['Failure', p.failureCode ? `${p.failureCode} (${p.failureCategory ?? 'n/a'})` : '—'],
                    ['Created', formatDateTime(p.createdAt)],
                    ['Authorized', formatDateTime(p.authorizedAt)],
                    ['Captured', formatDateTime(p.capturedAt)],
                    ['Refunded', formatDateTime(p.refundedAt)],
                  ]}
                />
              </div>
            </div>

            <div className="grid cols-2">
              <div className="card">
                <h2>State timeline (audit trail)</h2>
                <DataState
                  data={events.data}
                  loading={events.loading}
                  error={events.error}
                  reload={events.reload}
                  isEmpty={(e) => e.items.length === 0}
                >
                  {(e) => (
                    <ol className="timeline" aria-label="Audit events">
                      {e.items.map((ev) => (
                        <li key={ev.id} className={eventTone(ev)}>
                          <strong>{ev.eventType}</strong>{' '}
                          {ev.fromStatus || ev.toStatus ? (
                            <span className="muted">
                              {ev.fromStatus ?? '—'} → {ev.toStatus ?? '—'}
                            </span>
                          ) : null}
                          <div className="muted small">
                            {formatDateTime(ev.occurredAt)} · {ev.source} · {ev.actor} ·{' '}
                            <span className="mono">{ev.correlationId.slice(0, 13)}</span>
                          </div>
                          {Object.keys(ev.metadata).length > 0 && (
                            <div className="small mono muted">
                              {Object.entries(ev.metadata)
                                .map(([k, v]) => `${k}=${String(v)}`)
                                .join('  ')}
                            </div>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}
                </DataState>
              </div>
              <div className="card">
                <h2>Processor attempts</h2>
                {(p.attempts ?? []).length === 0 ? (
                  <div className="empty">No processor calls yet.</div>
                ) : (
                  <div className="table-wrap">
                    <table aria-label="Processor attempts">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Operation</th>
                          <th>Result</th>
                          <th>Code</th>
                          <th className="right">Time</th>
                        </tr>
                      </thead>
                      <tbody>
                        {p.attempts!.map((a) => (
                          <tr key={a.id}>
                            <td>{a.attemptNumber}</td>
                            <td>{a.operation}</td>
                            <td>
                              <StatusBadge
                                status={
                                  a.status === 'APPROVED'
                                    ? 'COMPLETED'
                                    : a.status === 'TIMEOUT'
                                      ? 'UNCERTAIN'
                                      : a.status === 'UNAVAILABLE'
                                        ? 'DEGRADED'
                                        : 'FAILED'
                                }
                              />{' '}
                              <span className="small">{a.status}</span>
                            </td>
                            <td>{a.responseCode ?? '—'}</td>
                            <td className="num">{ms(a.responseTimeMs)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="small muted">
                      Request ids: {p.attempts!.map((a) => a.processorRequestId.slice(-14)).join(', ')} (stable across retries:
                      processor-level idempotency)
                    </p>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </DataState>
    </div>
  );
}

function Actions({
  payment,
  busy,
  onRun,
  canOperate,
  canRefund,
}: {
  payment: Payment;
  busy?: string;
  onRun: (op: 'authorize' | 'capture' | 'refund' | 'cancel') => void;
  canOperate: boolean;
  canRefund: boolean;
}) {
  if (!canOperate) return <span className="muted small">Read-only (viewer role)</span>;
  const s = payment.status;
  return (
    <div className="row">
      {s === 'CREATED' && (
        <button className="primary" disabled={!!busy} onClick={() => onRun('authorize')}>
          {busy === 'authorize' ? 'Authorizing…' : 'Authorize'}
        </button>
      )}
      {s === 'AUTHORIZED' && (
        <button className="primary" disabled={!!busy} onClick={() => onRun('capture')}>
          {busy === 'capture' ? 'Capturing…' : 'Capture'}
        </button>
      )}
      {s === 'CAPTURED' && (
        <button
          disabled={!!busy || !canRefund}
          title={canRefund ? 'Full refund' : 'Refunds require the ADMIN role'}
          onClick={() => onRun('refund')}
        >
          {busy === 'refund' ? 'Refunding…' : 'Refund (full)'}
        </button>
      )}
      {(s === 'CREATED' || s === 'AUTHORIZED') && (
        <button className="danger" disabled={!!busy} onClick={() => onRun('cancel')}>
          Cancel
        </button>
      )}
    </div>
  );
}
