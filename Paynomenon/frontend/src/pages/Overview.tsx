import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Banner, DataState, ErrorBanner, StatusBadge } from '../components/ui';
import { formatDateTime, formatMoney, formatPercent, formatTime, ms } from '../format';
import { useAsync } from '../hooks';

export function Overview() {
  const { can } = useAuth();
  const overview = useAsync(() => api.overview(), [], 15000);
  const trends = useAsync(() => api.trends({ bucket: 'HOUR' }), []);
  const procs = useAsync(() => api.processors(), []);
  const anomalies = useAsync(() => api.anomalies({ size: 5 }), []);
  const incidents = useAsync(() => api.incidents({ status: 'OPEN', size: 5 }), []);
  const [seedState, setSeedState] = useState<{ busy: boolean; error?: unknown }>({ busy: false });

  async function loadDemo() {
    setSeedState({ busy: true });
    try {
      await api.seed(false);
      setSeedState({ busy: false });
      overview.reload();
      trends.reload();
      procs.reload();
      anomalies.reload();
      incidents.reload();
    } catch (e) {
      setSeedState({ busy: false, error: e });
    }
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <span className="muted small">Last 24 hours · all processors are simulated</span>
        </div>
        <button
          onClick={() => {
            overview.reload();
            trends.reload();
            procs.reload();
          }}
        >
          Refresh
        </button>
      </div>

      <DataState
        data={overview.data}
        loading={overview.loading}
        error={overview.error}
        reload={overview.reload}
        isEmpty={(o) => o.totals.total === 0}
        empty={
          <div className="stack">
            <strong>No payments in the last 24 hours.</strong>
            <div>Create a payment on the Payments page, or load reproducible synthetic data.</div>
            {can('ADMIN') ? (
              <button className="primary" disabled={seedState.busy} onClick={loadDemo}>
                {seedState.busy ? 'Generating…' : 'Load synthetic demo data'}
              </button>
            ) : (
              <span className="small">
                Ask an admin to run <code>make seed</code>.
              </span>
            )}
            {seedState.error ? <ErrorBanner error={seedState.error} /> : null}
          </div>
        }
      >
        {(o) => (
          <>
            {o.syntheticDataPresent && (
              <Banner kind="info">
                <strong>Synthetic demo data.</strong> These figures come from generated, simulated payments. No real money or
                cards are involved.
              </Banner>
            )}
            <div className="grid cols-4">
              <div className="card stat">
                <div className="label">Captured volume</div>
                {o.volume.length === 0 ? (
                  <div className="value">—</div>
                ) : (
                  o.volume.map((v) => (
                    <div key={v.currency} className="value" style={{ fontSize: '1.15rem' }}>
                      {formatMoney(v.capturedAmount, v.currency)} <span className="sub">({v.capturedCount})</span>
                    </div>
                  ))
                )}
                <div className="sub">per currency, never summed across currencies</div>
              </div>
              <div className="card stat">
                <div className="label">Success rate</div>
                <div className="value">{formatPercent(o.successRate)}</div>
                <div className="sub">successful / (successful + failed)</div>
              </div>
              <div className="card stat">
                <div className="label">Payments</div>
                <div className="value">{o.totals.total}</div>
                <div className="sub">
                  {o.totals.successful} successful · {o.totals.failed} failed · {o.totals.pending} pending · {o.totals.uncertain}{' '}
                  uncertain
                </div>
              </div>
              <div className="card stat">
                <div className="label">Processor latency</div>
                {o.latency.sufficientSample ? (
                  <>
                    <div className="value" style={{ fontSize: '1.15rem' }}>
                      p50 {ms(o.latency.p50)} · p95 {ms(o.latency.p95)}
                    </div>
                    <div className="sub">
                      p99 {ms(o.latency.p99)} · n={o.latency.sampleSize}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="value">—</div>
                    <div className="sub">
                      Not enough samples (n={o.latency.sampleSize}, need {o.latency.minSample})
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="grid cols-2">
              <div className="card">
                <h2>Failure rate over time</h2>
                <DataState
                  data={trends.data}
                  loading={trends.loading}
                  error={trends.error}
                  reload={trends.reload}
                  isEmpty={(t) => t.length === 0}
                  empty="No payments in this window."
                >
                  {(t) => (
                    <div style={{ height: 260 }} role="img" aria-label="Chart of payments per hour and failure rate">
                      <ResponsiveContainer>
                        <ComposedChart
                          data={t.map((p) => ({
                            ...p,
                            hour: formatTime(p.bucketStart),
                            pct: p.failureRate === undefined ? null : +(p.failureRate * 100).toFixed(1),
                          }))}
                        >
                          <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                          <XAxis dataKey="hour" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                          <YAxis
                            yAxisId="l"
                            tick={{ fontSize: 11 }}
                            allowDecimals={false}
                            label={{ value: 'payments', angle: -90, position: 'insideLeft', fontSize: 11 }}
                          />
                          <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 11 }} unit="%" domain={[0, 'auto']} />
                          <Tooltip />
                          <Legend />
                          <Bar yAxisId="l" dataKey="total" name="Payments" fill="var(--chart-1)" opacity={0.35} />
                          <Line
                            yAxisId="r"
                            dataKey="pct"
                            name="Failure rate %"
                            stroke="var(--chart-2)"
                            strokeWidth={2}
                            dot={false}
                            connectNulls={false}
                          />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </DataState>
              </div>
              <div className="card">
                <h2>Processor comparison</h2>
                <DataState
                  data={procs.data}
                  loading={procs.loading}
                  error={procs.error}
                  reload={procs.reload}
                  isEmpty={(p) => p.length === 0}
                  empty="No processor attempts in this window."
                >
                  {(p) => (
                    <>
                      <div style={{ height: 200 }} role="img" aria-label="Failure and timeout rates per processor">
                        <ResponsiveContainer>
                          <BarChart
                            data={p.map((x) => ({
                              name: x.processor,
                              failure: +((x.failureRate ?? 0) * 100).toFixed(1),
                              timeout: +((x.timeoutRate ?? 0) * 100).toFixed(1),
                            }))}
                          >
                            <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
                            <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                            <YAxis unit="%" tick={{ fontSize: 11 }} />
                            <Tooltip />
                            <Legend />
                            <Bar dataKey="failure" name="Failure rate %" fill="var(--chart-2)" />
                            <Bar dataKey="timeout" name="Timeout rate %" fill="var(--chart-3)" />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Processor</th>
                              <th className="right">Attempts</th>
                              <th className="right">p50</th>
                              <th className="right">p95</th>
                              <th className="right">p99</th>
                            </tr>
                          </thead>
                          <tbody>
                            {p.map((x) => (
                              <tr key={x.processor}>
                                <td>{x.processor}</td>
                                <td className="num">{x.attempts}</td>
                                <td className="num">{x.latency.sufficientSample ? ms(x.latency.p50) : '—'}</td>
                                <td className="num">{x.latency.sufficientSample ? ms(x.latency.p95) : '—'}</td>
                                <td className="num">{x.latency.sufficientSample ? ms(x.latency.p99) : '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </DataState>
              </div>
            </div>

            <div className="grid cols-2">
              <div className="card">
                <h2>Recent anomalies</h2>
                <DataState
                  data={anomalies.data}
                  loading={anomalies.loading}
                  error={anomalies.error}
                  reload={anomalies.reload}
                  isEmpty={(a) => a.items.length === 0}
                  empty="No anomalies detected. Run detection from System Health."
                >
                  {(a) => (
                    <ul className="tight" style={{ listStyle: 'none', padding: 0 }}>
                      {a.items.map((x) => (
                        <li key={x.id} style={{ padding: '6px 0' }}>
                          <StatusBadge status={x.severity} /> <strong>{x.metric}</strong> on {x.dimension}
                          <div className="muted small">
                            observed {x.observed} vs baseline {x.baseline} · {formatDateTime(x.windowStart)}
                          </div>
                          <Link to={`/investigations?subjectType=ANOMALY&subjectId=${x.id}`} className="small">
                            Investigate →
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </DataState>
              </div>
              <div className="card">
                <h2>Active incidents ({o.openIncidents})</h2>
                <DataState
                  data={incidents.data}
                  loading={incidents.loading}
                  error={incidents.error}
                  reload={incidents.reload}
                  isEmpty={(i) => i.items.length === 0}
                  empty="No active incidents."
                >
                  {(i) => (
                    <ul className="tight" style={{ listStyle: 'none', padding: 0 }}>
                      {i.items.map((x) => (
                        <li key={x.id} style={{ padding: '6px 0' }}>
                          <StatusBadge status={x.severity} /> <Link to={`/incidents/${x.id}`}>{x.title}</Link>
                          <div className="muted small">
                            {x.components.join(', ') || 'no component'} · since {formatDateTime(x.startedAt)}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </DataState>
                {o.openDiscrepancies > 0 && (
                  <p className="small">
                    <Link to="/reconciliation">{o.openDiscrepancies} open reconciliation discrepancies →</Link>
                  </p>
                )}
              </div>
            </div>
          </>
        )}
      </DataState>
    </div>
  );
}
