import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Banner, DataState, ErrorBanner, KeyValues, StatusBadge } from '../components/ui';
import { formatDateTime, formatMoney } from '../format';
import { useAsync } from '../hooks';
import type { Discrepancy, DiscrepancyType, ReconRun } from '../api/types';

const TYPES: DiscrepancyType[] = [
  'MISSING_FROM_REPORT',
  'MISSING_INTERNALLY',
  'AMOUNT_MISMATCH',
  'CURRENCY_MISMATCH',
  'DUPLICATE_SETTLEMENT',
  'UNEXPECTED_STATE',
];

export function Reconciliation() {
  const { can } = useAuth();
  const sys = useAsync(() => api.systemStatus(), []);
  const runs = useAsync(() => api.reconRuns(), []);
  const [selected, setSelected] = useState<ReconRun>();
  const [processor, setProcessor] = useState('MOCK_PROCESSOR');
  const [scenario, setScenario] = useState('CLEAN');
  const [state, setState] = useState<{ busy?: boolean; error?: unknown }>({});

  async function start(e: FormEvent) {
    e.preventDefault();
    setState({ busy: true });
    try {
      const run = await api.startRecon({ processor, scenario });
      setSelected(run);
      setState({});
      runs.reload();
    } catch (err) {
      setState({ error: err });
    }
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Reconciliation</h1>
          <span className="muted small">
            Compares the processor's (synthetic) settlement report with internal payments and the ledger. Discrepancies are
            reported, never auto-corrected.
          </span>
        </div>
      </div>

      {can('INVESTIGATOR') && (
        <form className="card form-grid" onSubmit={start} aria-label="Start reconciliation">
          <label>
            Processor
            <select value={processor} onChange={(e) => setProcessor(e.target.value)}>
              <option>MOCK_PROCESSOR</option>
              <option>MOCK_PROCESSOR_EU</option>
            </select>
          </label>
          {sys.data?.simulation.enabled && (
            <label>
              Settlement report
              <select value={scenario} onChange={(e) => setScenario(e.target.value)}>
                <option value="CLEAN">Clean (matches processor activity)</option>
                <option value="WITH_DISCREPANCIES">With injected defects (demo)</option>
              </select>
            </label>
          )}
          <button className="primary" disabled={state.busy}>
            {state.busy ? 'Running…' : 'Start reconciliation run (last 24h)'}
          </button>
          {state.error ? (
            <div style={{ gridColumn: '1 / -1' }}>
              <ErrorBanner error={state.error} />
            </div>
          ) : null}
        </form>
      )}

      <div className="card">
        <h2>Runs</h2>
        <DataState
          data={runs.data}
          loading={runs.loading}
          error={runs.error}
          reload={runs.reload}
          isEmpty={(r) => r.items.length === 0}
          empty="No reconciliation runs yet. Start one above."
        >
          {(r) => (
            <div className="table-wrap">
              <table aria-label="Reconciliation runs">
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Processor</th>
                    <th>Report</th>
                    <th className="right">Internal</th>
                    <th className="right">In report</th>
                    <th className="right">Matched</th>
                    <th className="right">Discrepancies</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {r.items.map((x) => (
                    <tr
                      key={x.id}
                      className="clickable"
                      onClick={() => setSelected(x)}
                      aria-selected={selected?.id === x.id}
                      data-testid="recon-run"
                    >
                      <td>{formatDateTime(x.startedAt)}</td>
                      <td>{x.processor}</td>
                      <td>{x.scenario === 'CLEAN' ? 'clean' : <span className="badge warn">injected defects</span>}</td>
                      <td className="num">{x.internalCount}</td>
                      <td className="num">{x.reportCount}</td>
                      <td className="num">{x.matchedCount}</td>
                      <td className="num">
                        <strong>{x.discrepancyCount}</strong>
                      </td>
                      <td>
                        <StatusBadge status={x.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DataState>
      </div>

      {selected && <RunDiscrepancies run={selected} canAck={can('INVESTIGATOR')} />}
    </div>
  );
}

function RunDiscrepancies({ run, canAck }: { run: ReconRun; canAck: boolean }) {
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const list = useAsync(() => api.discrepancies(run.id, { type, status }), [run.id, type, status]);
  const [open, setOpen] = useState<Discrepancy>();

  return (
    <div className="card">
      <div className="row between">
        <h2>
          Run {run.id.slice(0, 8)} · {run.matchedCount} matched, {run.discrepancyCount} discrepancies
        </h2>
        <span className="row">
          <select aria-label="Filter by type" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All types</option>
            {TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any status</option>
            <option>OPEN</option>
            <option>ACKNOWLEDGED</option>
          </select>
        </span>
      </div>
      {run.status === 'FAILED' && <ErrorBanner error={new Error(`Run failed: ${run.error ?? 'unknown error'}`)} />}
      <DataState
        data={list.data}
        loading={list.loading}
        error={list.error}
        reload={list.reload}
        isEmpty={(d) => d.items.length === 0}
        empty={run.discrepancyCount === 0 ? 'Everything matched: no discrepancies.' : 'No discrepancies match the filter.'}
      >
        {(d) => (
          <div className="table-wrap">
            <table aria-label="Discrepancies">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Payment</th>
                  <th>Op</th>
                  <th className="right">Internal</th>
                  <th className="right">Report</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {d.items.map((x) => (
                  <tr key={x.id} className="clickable" onClick={() => setOpen(x)} data-testid="discrepancy-row">
                    <td>
                      <span className="badge warn">{x.type}</span>
                    </td>
                    <td className="mono">{x.paymentReference.slice(0, 8)}</td>
                    <td>{x.operation}</td>
                    <td className="num">
                      {x.internalAmount !== undefined ? formatMoney(x.internalAmount, x.internalCurrency ?? 'EUR') : '—'}
                    </td>
                    <td className="num">
                      {x.reportAmount !== undefined ? formatMoney(x.reportAmount, x.reportCurrency ?? 'EUR') : '—'}
                    </td>
                    <td>
                      <StatusBadge status={x.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DataState>
      {open && (
        <DiscrepancyDetail
          d={open}
          canAck={canAck}
          onClose={() => setOpen(undefined)}
          onAcked={(u) => {
            setOpen(u);
            list.reload();
          }}
        />
      )}
    </div>
  );
}

function DiscrepancyDetail({
  d,
  canAck,
  onClose,
  onAcked,
}: {
  d: Discrepancy;
  canAck: boolean;
  onClose: () => void;
  onAcked: (d: Discrepancy) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function ack(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      onAcked(await api.acknowledge(d.id, text));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" style={{ marginTop: 14, background: 'var(--surface-2)' }} aria-label="Discrepancy evidence">
      <div className="row between">
        <h3 style={{ margin: 0 }}>{d.type} · evidence</h3>
        <button onClick={onClose}>Close</button>
      </div>
      <KeyValues
        items={[
          [
            'Payment',
            <Link key="p" to={`/payments/${d.paymentReference}`} className="mono">
              {d.paymentReference}
            </Link>,
          ],
          ['Operation', d.operation],
          ['Internal (ledger)', d.internalAmount !== undefined ? `${d.internalAmount} ${d.internalCurrency}` : 'no posting'],
          ['Processor report', d.reportAmount !== undefined ? `${d.reportAmount} ${d.reportCurrency}` : 'no line'],
          ['Internal payment status', d.internalStatus ?? '—'],
          [
            'Details',
            <span className="mono" key="d">
              {JSON.stringify(d.details)}
            </span>,
          ],
        ]}
      />
      {d.status === 'ACKNOWLEDGED' ? (
        <Banner kind="ok">
          Acknowledged by <strong>{d.acknowledgedBy}</strong> on {formatDateTime(d.acknowledgedAt)}: “{d.explanation}”
        </Banner>
      ) : canAck ? (
        <form onSubmit={ack} className="stack" style={{ marginTop: 12 }} aria-label="Acknowledge discrepancy">
          <label>
            Explanation (min. 10 characters; stored with your name; financial records are not changed)
            <textarea value={text} onChange={(e) => setText(e.target.value)} minLength={10} required />
          </label>
          {error ? <ErrorBanner error={error} /> : null}
          <button className="primary" disabled={busy || text.trim().length < 10}>
            Acknowledge
          </button>
        </form>
      ) : (
        <p className="muted small">Acknowledging requires the INVESTIGATOR role.</p>
      )}
    </section>
  );
}
