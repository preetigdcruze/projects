import { useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Banner, DataState, ErrorBanner, StatusBadge } from '../components/ui';
import { formatDateTime } from '../format';
import { useAsync } from '../hooks';

function Component({ name, s }: { name: string; s: { status: string; detail?: string } }) {
  return (
    <div className="card stat">
      <div className="label">{name}</div>
      <div className="value" style={{ fontSize: '1.2rem' }}>
        <StatusBadge status={s.status} />
      </div>
      <div className="sub">{s.detail ?? ' '}</div>
    </div>
  );
}

export function SystemHealth() {
  const { can } = useAuth();
  const status = useAsync(() => api.systemStatus(), [], 10000);
  const ai = useAsync(() => api.providerStatus(), [], 10000);
  const dead = useAsync(() => api.deadLetters('DEAD'), [], 10000);
  const [action, setAction] = useState<{ message?: string; error?: unknown; busy?: boolean }>({});
  const [replayReason, setReplayReason] = useState('Dependency recovered; replaying after investigation');

  async function detect() {
    setAction({ busy: true });
    try {
      const r = await api.detectAnomalies();
      setAction({
        message:
          r.status === 'UNAVAILABLE'
            ? `Detection unavailable (${r.errorCategory ?? 'AI service down'}).`
            : `Detection finished: ${r.anomalies?.length ?? 0} anomalies in ${r.evaluated ?? 0} evaluated buckets.`,
      });
    } catch (e) {
      setAction({ error: e });
    }
  }
  async function replay(id: string) {
    setAction({ busy: true });
    try {
      const r = await api.replayDeadLetter(id, replayReason);
      setAction({ message: `Replay ${r.status}: ${r.outcome}` });
      dead.reload();
      status.reload();
    } catch (e) {
      setAction({ error: e });
    }
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>System Health</h1>
          <span className="muted small">Auto-refreshes every 10 seconds</span>
        </div>
        {can('INVESTIGATOR') && (
          <button onClick={detect} disabled={action.busy}>
            Run anomaly detection
          </button>
        )}
      </div>
      {action.message && <Banner kind="ok">{action.message}</Banner>}
      {action.error ? <ErrorBanner error={action.error} /> : null}

      <DataState data={status.data} loading={status.loading} error={status.error} reload={status.reload}>
        {(s) => {
          const outbox = 'error' in s.events.outbox ? undefined : s.events.outbox;
          return (
            <>
              {s.ai.status !== 'UP' && (
                <Banner kind="warn">
                  <strong>AI service is {s.ai.status.toLowerCase()}.</strong> Payment processing, dashboards and reconciliation
                  are not affected; AI features show an explicit unavailable state.
                </Banner>
              )}
              <div className="grid cols-4">
                <Component
                  name="Backend"
                  s={{ status: s.backend.status, detail: `${s.backend.environment} · v${s.backend.version}` }}
                />
                <Component name="Database" s={s.database} />
                <Component name="Redis (cache, rate limits)" s={s.redis} />
                <Component name="AI service" s={s.ai} />
              </div>
              <div className="grid cols-2">
                <div className="card" aria-label="Event processing">
                  <h2>Event processing ({s.events.transport})</h2>
                  {outbox ? (
                    <div className="grid cols-4">
                      <div className="stat">
                        <div className="label">Outbox pending</div>
                        <div className="value" data-testid="outbox-pending">
                          {outbox.pending}
                        </div>
                        <div className="sub">
                          {outbox.oldestPendingAgeSeconds !== undefined ? `oldest ${outbox.oldestPendingAgeSeconds}s` : 'empty'}
                        </div>
                      </div>
                      <div className="stat">
                        <div className="label">Outbox failed</div>
                        <div className="value">{outbox.failed}</div>
                      </div>
                      <div className="stat">
                        <div className="label">Published</div>
                        <div className="value">{outbox.published}</div>
                      </div>
                      <div className="stat">
                        <div className="label">Consumer lag</div>
                        <div className="value">{s.events.consumerLagAvailable ? s.events.consumerLag : 'n/a'}</div>
                        <div className="sub">{s.events.transport === 'kafka' ? '' : 'in-process transport: no broker'}</div>
                      </div>
                    </div>
                  ) : (
                    <Banner kind="warn">Outbox statistics unavailable.</Banner>
                  )}
                  <p className="small muted">Delivery is at-least-once; consumers deduplicate by event id.</p>
                </div>
                <div className="card">
                  <h2>Processors</h2>
                  <ul className="tight" style={{ listStyle: 'none', padding: 0 }}>
                    {s.processors.map((p) => (
                      <li key={p.name}>
                        {p.name} circuit <StatusBadge status={p.circuit} />
                      </li>
                    ))}
                  </ul>
                  <p className="small">
                    Simulation:{' '}
                    {s.simulation.enabled ? (
                      <span className="badge warn">enabled (development)</span>
                    ) : (
                      <span className="badge">disabled</span>
                    )}
                  </p>
                </div>
              </div>
            </>
          );
        }}
      </DataState>

      <div className="card">
        <h2>Dead-letter queue {dead.data ? `(${dead.data.totalItems} unresolved)` : ''}</h2>
        <DataState
          data={dead.data}
          loading={dead.loading}
          error={dead.error}
          reload={dead.reload}
          isEmpty={(d) => d.items.length === 0}
          empty="No dead-lettered events."
        >
          {(d) => (
            <>
              <div className="table-wrap">
                <table aria-label="Dead letters">
                  <thead>
                    <tr>
                      <th>Consumer</th>
                      <th>Event</th>
                      <th>Error</th>
                      <th className="right">Attempts</th>
                      <th>Failed</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {d.items.map((x) => (
                      <tr key={x.id}>
                        <td>{x.consumer}</td>
                        <td>{x.eventType ?? 'unparseable'}</td>
                        <td className="small">
                          {x.errorClass.split('.').pop()}
                          <div className="muted">{x.errorMessage}</div>
                        </td>
                        <td className="num">{x.attempts}</td>
                        <td>{formatDateTime(x.failedAt)}</td>
                        <td>
                          {can('ADMIN') ? (
                            <button onClick={() => replay(x.id)} disabled={action.busy}>
                              Replay
                            </button>
                          ) : (
                            <span className="muted small">ADMIN only</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {can('ADMIN') && (
                <label style={{ marginTop: 10 }}>
                  Replay reason (required, audited)
                  <input value={replayReason} onChange={(e) => setReplayReason(e.target.value)} minLength={10} />
                </label>
              )}
            </>
          )}
        </DataState>
      </div>

      <div className="card">
        <h2>AI provider</h2>
        <DataState data={ai.data} loading={ai.loading} error={ai.error} reload={ai.reload}>
          {(a) =>
            a.status === 'UNAVAILABLE' ? (
              <Banner kind="bad">AI service unreachable ({a.errorCategory ?? 'unknown'}).</Banner>
            ) : (
              <div className="grid cols-4">
                <div className="stat">
                  <div className="label">Provider</div>
                  <div className="value" style={{ fontSize: '1.1rem' }}>
                    {a.provider}
                  </div>
                  <div className="sub">{a.model}</div>
                </div>
                <div className="stat">
                  <div className="label">Status</div>
                  <div className="value" style={{ fontSize: '1.1rem' }}>
                    <StatusBadge status={a.status === 'OK' ? 'COMPLETED' : 'DEGRADED'} /> {a.status}
                  </div>
                </div>
                <div className="stat">
                  <div className="label">Requests</div>
                  <div className="value">{a.requests ?? 0}</div>
                  <div className="sub">{a.successes ?? 0} succeeded</div>
                </div>
                <div className="stat">
                  <div className="label">Tokens</div>
                  <div className="value" style={{ fontSize: '1.1rem' }}>
                    {(a.promptTokens ?? 0) + (a.completionTokens ?? 0)}
                  </div>
                  <div className="sub">
                    recent errors:{' '}
                    {Object.entries(a.recentErrorCategories ?? {})
                      .map(([k, v]) => `${k}×${v}`)
                      .join(', ') || 'none'}
                  </div>
                </div>
              </div>
            )
          }
        </DataState>
      </div>
    </div>
  );
}
