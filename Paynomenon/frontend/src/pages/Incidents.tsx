import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Banner, DataState, ErrorBanner, EvidenceChip, KeyValues, Spinner, StatusBadge } from '../components/ui';
import { formatDateTime, formatMoney } from '../format';
import { useAsync } from '../hooks';
import type { IncidentReport } from '../api/types';

export function Incidents() {
  const nav = useNavigate();
  const [status, setStatus] = useState<'OPEN' | 'RESOLVED'>('OPEN');
  const list = useAsync(() => api.incidents({ status, size: 25 }), [status]);
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Incidents</h1>
          <span className="muted small">Correlated failures, anomalies and reconciliation findings</span>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {(['OPEN', 'RESOLVED'] as const).map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={status === s}
            className={`tab${status === s ? ' active' : ''}`}
            onClick={() => setStatus(s)}
          >
            {s === 'OPEN' ? 'Active' : 'Resolved'}
          </button>
        ))}
      </div>
      <div className="card">
        <DataState
          data={list.data}
          loading={list.loading}
          error={list.error}
          reload={list.reload}
          isEmpty={(l) => l.items.length === 0}
          empty={status === 'OPEN' ? 'No active incidents.' : 'No resolved incidents.'}
        >
          {(l) => (
            <div className="table-wrap">
              <table aria-label="Incidents">
                <thead>
                  <tr>
                    <th>Severity</th>
                    <th>Title</th>
                    <th>Components</th>
                    <th>Started</th>
                    <th>Linked</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {l.items.map((i) => (
                    <tr key={i.id} className="clickable" onClick={() => nav(`/incidents/${i.id}`)} data-testid="incident-row">
                      <td>
                        <StatusBadge status={i.severity} />
                      </td>
                      <td>
                        <Link to={`/incidents/${i.id}`}>{i.title}</Link>
                      </td>
                      <td>{i.components.join(', ') || '—'}</td>
                      <td>{formatDateTime(i.startedAt)}</td>
                      <td className="small muted">
                        {Object.entries(i.counts)
                          .map(([k, v]) => `${v} ${k}`)
                          .join(' · ') || '—'}
                      </td>
                      <td>{i.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DataState>
      </div>
    </div>
  );
}

export function IncidentDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const detail = useAsync(() => api.incident(id), [id]);
  const history = useAsync(() => api.investigations({ subjectType: 'INCIDENT', subjectId: id, size: 10 }), [id]);
  const [sum, setSum] = useState<{ busy: boolean; error?: unknown; report?: IncidentReport }>({ busy: false });
  const [resolveError, setResolveError] = useState<unknown>();

  async function summarize() {
    setSum({ busy: true });
    try {
      setSum({ busy: false, report: await api.summarizeIncident(id) });
      detail.reload();
    } catch (e) {
      setSum({ busy: false, error: e });
    }
  }
  async function resolve() {
    try {
      await api.resolveIncident(id);
      detail.reload();
    } catch (e) {
      setResolveError(e);
    }
  }

  return (
    <div className="stack">
      <p className="small">
        <Link to="/incidents">← Incidents</Link>
      </p>
      <DataState data={detail.data} loading={detail.loading} error={detail.error} reload={detail.reload}>
        {(d) => {
          const inc = d.incident;
          const report = sum.report ?? inc.aiReport;
          return (
            <>
              <div className="page-head">
                <div>
                  <h1>{inc.title}</h1>
                  <StatusBadge status={inc.status} /> <StatusBadge status={inc.severity} />{' '}
                  <span className="muted small">
                    source {inc.source} · {inc.components.join(', ')}
                  </span>
                </div>
                <div className="row">
                  <Link to={`/investigations?subjectType=INCIDENT&subjectId=${inc.id}`}>Investigate with AI</Link>
                  {can('INVESTIGATOR') && (
                    <button className="primary" onClick={summarize} disabled={sum.busy}>
                      {sum.busy ? 'Summarising…' : 'Generate AI summary'}
                    </button>
                  )}
                  {can('INVESTIGATOR') && inc.status === 'OPEN' && <button onClick={resolve}>Mark resolved</button>}
                </div>
              </div>
              {resolveError ? <ErrorBanner error={resolveError} /> : null}
              {sum.busy && <Spinner label="Gathering evidence and writing the report" />}
              {sum.error ? <ErrorBanner error={sum.error} /> : null}

              <div className="grid cols-2">
                <div className="card">
                  <h2>Summary</h2>
                  <KeyValues
                    items={[
                      ['Started', formatDateTime(inc.startedAt)],
                      ['Resolved', formatDateTime(inc.resolvedAt)],
                      ['Description', inc.description ?? '—'],
                      [
                        'Linked records',
                        Object.entries(inc.counts)
                          .map(([k, v]) => `${v} ${k}`)
                          .join(', ') || 'none',
                      ],
                    ]}
                  />
                  <h3>Anomaly evidence</h3>
                  {d.anomalies.length === 0 ? (
                    <div className="muted small">No anomalies linked.</div>
                  ) : (
                    <ul className="tight">
                      {d.anomalies.map((a) => (
                        <li key={a.id}>
                          <StatusBadge status={a.severity} /> {a.metric} on {a.dimension}: observed {a.observed}, baseline{' '}
                          {a.baseline}{' '}
                          <Link className="small" to={`/investigations?subjectType=ANOMALY&subjectId=${a.id}`}>
                            explain
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                  {d.discrepancies.length > 0 && (
                    <>
                      <h3>Reconciliation findings</h3>
                      <ul className="tight">
                        {d.discrepancies.map((x) => (
                          <li key={x.id}>
                            {x.type} · {x.status} ·{' '}
                            <Link to={`/payments/${x.paymentReference}`} className="mono">
                              {x.paymentReference.slice(0, 8)}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                  {d.deadLetterIds.length > 0 && <p className="small">{d.deadLetterIds.length} dead-lettered events linked.</p>}
                </div>
                <div className="card">
                  <h2>Timeline of related events</h2>
                  {d.timeline.length === 0 ? (
                    <div className="empty">No events.</div>
                  ) : (
                    <ol className="timeline" aria-label="Incident timeline" style={{ maxHeight: 360, overflow: 'auto' }}>
                      {d.timeline.slice(-80).map((t, i) => (
                        <li
                          key={`${t.kind}-${t.refId}-${i}`}
                          className={t.kind === 'ANOMALY' ? 'bad' : t.kind === 'LOG' ? 'warn' : ''}
                        >
                          <span className="badge">{t.kind}</span> {t.title}
                          {t.kind === 'LOG' && t.detail && (
                            <div className="small muted">Log text (untrusted, shown as text): {t.detail}</div>
                          )}
                          <div className="muted small">
                            {formatDateTime(t.at)}
                            {t.paymentId && (
                              <>
                                {' '}
                                · <Link to={`/payments/${t.paymentId}`}>payment</Link>
                              </>
                            )}
                          </div>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              </div>

              <div className="card">
                <h2>Linked payments ({d.payments.length})</h2>
                {d.payments.length === 0 ? (
                  <div className="empty">No payments linked.</div>
                ) : (
                  <div className="table-wrap">
                    <table aria-label="Linked payments">
                      <thead>
                        <tr>
                          <th>Payment</th>
                          <th>Status</th>
                          <th className="right">Amount</th>
                          <th>Processor</th>
                          <th>Failure</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.payments.map((p) => (
                          <tr key={p.id}>
                            <td>
                              <Link to={`/payments/${p.id}`} className="mono">
                                {p.id.slice(0, 8)}
                              </Link>
                            </td>
                            <td>
                              <StatusBadge status={p.status} />
                            </td>
                            <td className="num">{formatMoney(p.amount, p.currency)}</td>
                            <td>{p.processor}</td>
                            <td>{p.failureCode ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {report ? (
                <ReportView report={report} generatedAt={sum.report ? undefined : inc.aiReportAt} />
              ) : (
                <Banner kind="info">
                  No AI summary yet. “Generate AI summary” builds a structured report from the linked evidence. If the AI service
                  is unavailable you will still get the computed figures and timeline.
                </Banner>
              )}

              <div className="card">
                <h2>Investigation history</h2>
                <DataState
                  data={history.data}
                  loading={history.loading}
                  error={history.error}
                  reload={history.reload}
                  isEmpty={(h) => h.items.length === 0}
                  empty="No investigations were run for this incident."
                >
                  {(h) => (
                    <ul className="tight">
                      {h.items.map((i) => (
                        <li key={i.id}>
                          <StatusBadge status={i.status} /> {formatDateTime(i.createdAt)} · {i.requestedBy} · “{i.question}”
                        </li>
                      ))}
                    </ul>
                  )}
                </DataState>
              </div>
            </>
          );
        }}
      </DataState>
    </div>
  );
}

function ReportView({ report, generatedAt }: { report: IncidentReport; generatedAt?: string }) {
  const facts = new Map(report.facts.map((f) => [f.id, f.link]));
  const n = report.narrative;
  return (
    <section className="card panel-ai stack" aria-label="AI incident report" data-testid="incident-report">
      <h2>
        Incident report <StatusBadge status={report.status} />{' '}
        {generatedAt && <span className="muted small">generated {formatDateTime(generatedAt)}</span>}
      </h2>
      {report.notice && <Banner kind="warn">{report.notice}</Banner>}
      <div className="grid cols-2">
        <div>
          <h3>
            Computed from linked records <span className="badge ok">not AI</span>
          </h3>
          <KeyValues
            items={[
              [
                'Time window',
                `${formatDateTime(report.timeWindow.start)} → ${report.timeWindow.end ? formatDateTime(report.timeWindow.end) : 'ongoing'}`,
              ],
              ['Affected components', report.affectedComponents.join(', ') || '—'],
              [
                'Failure counts',
                Object.entries(report.failureCounts)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(' · '),
              ],
              ['Payments affected', report.impact.paymentsAffected],
              [
                'Amount at risk',
                Object.entries(report.impact.amountAtRiskByCurrency)
                  .map(([c, v]) => `${v} ${c}`)
                  .join(', ') || '—',
              ],
            ]}
          />
          <p className="small muted">{report.impact.basis}</p>
        </div>
        <div>
          <h3>Remediation</h3>
          <Banner kind="info">
            No remediation has been executed or verified by this report. Suggestions below are for humans to evaluate.
          </Banner>
        </div>
      </div>
      {n ? (
        <div>
          <h3>
            AI-generated interpretation <span className="badge unc">hypotheses, not verified facts</span>
          </h3>
          <p>
            <strong>{n.title}</strong>
          </p>
          {n.likely_causes.length > 0 && (
            <>
              <h3>Likely causes</h3>
              <ul className="tight">
                {n.likely_causes.map((c, i) => (
                  <li key={i}>
                    {c.statement} <span className="badge">{c.confidence}</span>{' '}
                    {c.evidence_ids.map((e) => (
                      <EvidenceChip key={e} id={e} link={facts.get(e)} />
                    ))}
                  </li>
                ))}
              </ul>
            </>
          )}
          {n.key_events.length > 0 && (
            <>
              <h3>Key events</h3>
              <ul className="tight">
                {n.key_events.map((c, i) => (
                  <li key={i}>
                    {c.text}{' '}
                    {c.evidence_ids.map((e) => (
                      <EvidenceChip key={e} id={e} link={facts.get(e)} />
                    ))}
                  </li>
                ))}
              </ul>
            </>
          )}
          {n.investigation_steps.length > 0 && (
            <>
              <h3>Suggested investigation steps</h3>
              <ol className="tight">
                {n.investigation_steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            </>
          )}
          {n.mitigation_steps.length > 0 && (
            <>
              <h3>Suggested mitigation steps</h3>
              <ul className="tight">
                {n.mitigation_steps.map((s) => (
                  <li key={s.text}>
                    {s.text} {s.runbook_source && <span className="chip">{s.runbook_source}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
          {n.uncertainties.length > 0 && (
            <>
              <h3>Uncertainties</h3>
              <ul className="tight">
                {n.uncertainties.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </>
          )}
          {n.missing_evidence.length > 0 && (
            <>
              <h3>Missing evidence</h3>
              <ul className="tight">
                {n.missing_evidence.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : (
        <Banner kind="warn">
          No AI narrative is available{report.errorCategory ? ` (${report.errorCategory})` : ''}; the computed figures and
          evidence are shown.
        </Banner>
      )}
      {report.runbookGuidance.length > 0 && (
        <div className="panel-ref card">
          <h3 style={{ marginTop: 0 }}>
            Runbook guidance <span className="badge warn">reference, not evidence</span>
          </h3>
          <ul className="tight">
            {report.runbookGuidance.map((g) => (
              <li key={g.source}>
                <span className="chip">{g.source}</span> {g.title}
              </li>
            ))}
          </ul>
        </div>
      )}
      <details>
        <summary>Evidence used ({report.facts.length})</summary>
        <ul className="tight">
          {report.facts.map((f) => (
            <li key={f.id}>
              <EvidenceChip id={f.id} link={f.link} /> {f.text}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
