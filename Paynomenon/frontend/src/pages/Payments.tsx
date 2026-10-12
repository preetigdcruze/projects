import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { DataState, ErrorBanner, Pagination, StatusBadge } from '../components/ui';
import { formatDateTime, formatMoney, shortId } from '../format';
import { useAsync } from '../hooks';
import type { PaymentStatus } from '../api/types';

const STATUSES: PaymentStatus[] = [
  'CREATED',
  'PROCESSING',
  'AUTHORIZED',
  'CAPTURING',
  'CAPTURED',
  'REFUNDING',
  'REFUNDED',
  'FAILED',
  'CANCELLED',
  'UNCERTAIN',
];
const PROCESSORS = ['MOCK_PROCESSOR', 'MOCK_PROCESSOR_EU'];
const SIMULATIONS = [
  ['', 'None (approve)'],
  ['[sim:insufficient_funds]', 'Insufficient funds'],
  ['[sim:timeout]', 'Processor timeout (executed, ambiguous)'],
  ['[sim:timeout_not_executed]', 'Processor timeout (not executed)'],
  ['[sim:unavailable]', 'Processor unavailable'],
  ['[sim:invalid]', 'Invalid request'],
] as const;

export function Payments() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState('');
  const [processor, setProcessor] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('createdAt,desc');
  const [applied, setApplied] = useState({ status: '', processor: '', q: '' });
  const list = useAsync(
    () => api.payments({ page, size: 15, sort, status: applied.status, processor: applied.processor, q: applied.q }),
    [page, sort, applied],
  );
  const sys = useAsync(() => api.systemStatus(), []);
  const [creating, setCreating] = useState(false);

  function applyFilters(e: FormEvent) {
    e.preventDefault();
    setPage(0);
    setApplied({ status, processor, q });
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Payments</h1>
          <span className="muted small">Every payment is simulated; amounts are exact decimals.</span>
        </div>
        {can('INVESTIGATOR') && (
          <button className="primary" onClick={() => setCreating((c) => !c)}>
            {creating ? 'Close' : 'New payment'}
          </button>
        )}
      </div>

      {creating && <NewPayment simulation={sys.data?.simulation.enabled ?? false} onCreated={(id) => nav(`/payments/${id}`)} />}

      <form className="card form-grid" onSubmit={applyFilters} aria-label="Filter payments">
        <label>
          Search (id, merchant, description)
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. order-42" />
        </label>
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {STATUSES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Processor
          <select value={processor} onChange={(e) => setProcessor(e.target.value)}>
            <option value="">All</option>
            {PROCESSORS.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Sort
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="createdAt,desc">Newest first</option>
            <option value="createdAt,asc">Oldest first</option>
            <option value="amount,desc">Amount, high to low</option>
            <option value="amount,asc">Amount, low to high</option>
          </select>
        </label>
        <button type="submit" className="primary">
          Apply
        </button>
      </form>

      <div className="card">
        <DataState
          data={list.data}
          loading={list.loading}
          error={list.error}
          reload={list.reload}
          isEmpty={(p) => p.items.length === 0}
          empty="No payments match these filters."
        >
          {(p) => (
            <>
              <div className="table-wrap">
                <table aria-label="Payments">
                  <thead>
                    <tr>
                      <th>Payment</th>
                      <th>Status</th>
                      <th className="right">Amount</th>
                      <th>Processor</th>
                      <th>Merchant</th>
                      <th>Created</th>
                      <th>Correlation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.items.map((x) => (
                      <tr key={x.id} className="clickable" onClick={() => nav(`/payments/${x.id}`)} data-testid="payment-row">
                        <td>
                          <a
                            href={`/payments/${x.id}`}
                            onClick={(e) => {
                              e.preventDefault();
                              nav(`/payments/${x.id}`);
                            }}
                            className="mono"
                          >
                            {shortId(x.id)}
                          </a>
                          {x.synthetic && (
                            <span className="badge" style={{ marginLeft: 6 }} title="Generated demo data">
                              synthetic
                            </span>
                          )}
                        </td>
                        <td>
                          <StatusBadge status={x.status} />
                          {x.failureCode ? <div className="muted small">{x.failureCode}</div> : null}
                        </td>
                        <td className="num">{formatMoney(x.amount, x.currency)}</td>
                        <td>{x.processor}</td>
                        <td>{x.merchantId}</td>
                        <td>{formatDateTime(x.createdAt)}</td>
                        <td className="mono muted">{shortId(x.correlationId)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="row between small muted" style={{ marginTop: 8 }}>
                <span>{p.totalItems} payments</span>
              </div>
              <Pagination page={p.page} totalPages={p.totalPages} onPage={setPage} />
            </>
          )}
        </DataState>
      </div>
    </div>
  );
}

function NewPayment({ simulation, onCreated }: { simulation: boolean; onCreated: (id: string) => void }) {
  const [amount, setAmount] = useState('49.99');
  const [currency, setCurrency] = useState('EUR');
  const [processor, setProcessor] = useState(PROCESSORS[0]!);
  const [description, setDescription] = useState('Demo purchase');
  const [sim, setSim] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      // the amount is sent as a JSON number but never converted with floating point arithmetic in the UI
      const p = await api.createPayment({
        amount: Number(amount),
        currency,
        merchantId: 'merchant-demo',
        processor,
        description: `${description} ${sim}`.trim(),
      });
      onCreated(p.id);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card form-grid" onSubmit={submit} aria-label="New payment">
      <label>
        Amount
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          pattern="[0-9]+(\.[0-9]+)?"
          required
        />
      </label>
      <label>
        Currency
        <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
          {['EUR', 'USD', 'GBP', 'JPY', 'CHF', 'SEK'].map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
      <label>
        Processor
        <select value={processor} onChange={(e) => setProcessor(e.target.value)}>
          {PROCESSORS.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </label>
      <label>
        Description
        <input value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />
      </label>
      {simulation && (
        <label>
          Simulate outcome (development only)
          <select value={sim} onChange={(e) => setSim(e.target.value)}>
            {SIMULATIONS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
      )}
      <button className="primary" disabled={busy}>
        {busy ? 'Creating…' : 'Create payment'}
      </button>
      {error ? (
        <div style={{ gridColumn: '1 / -1' }}>
          <ErrorBanner error={error} />
        </div>
      ) : null}
    </form>
  );
}
