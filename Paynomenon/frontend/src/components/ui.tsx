import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../api/client';
import type { PaymentStatus } from '../api/types';

const STATUS_CLASS: Record<string, string> = {
  AUTHORIZED: 'ok',
  CAPTURED: 'ok',
  REFUNDED: 'info',
  FAILED: 'bad',
  CANCELLED: '',
  UNCERTAIN: 'unc',
  CREATED: '',
  PROCESSING: 'warn',
  CAPTURING: 'warn',
  REFUNDING: 'warn',
  OPEN: 'warn',
  RESOLVED: 'ok',
  ACKNOWLEDGED: 'ok',
  COMPLETED: 'ok',
  DEGRADED: 'warn',
  UNAVAILABLE: 'bad',
  RUNNING: 'info',
  HIGH: 'bad',
  MEDIUM: 'warn',
  LOW: 'info',
  UP: 'ok',
  DOWN: 'bad',
  DISABLED: '',
  CLOSED: 'ok',
  HALF_OPEN: 'warn',
};

export function StatusBadge({ status }: { status: PaymentStatus | string }) {
  return <span className={`badge ${STATUS_CLASS[status] ?? ''}`}>{status}</span>;
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" /> <span className="muted">{label}…</span>
    </span>
  );
}

export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    const base = e.status === 0 ? e.message : `${e.message}${e.code && e.status ? ` (${e.code})` : ''}`;
    return e.correlationId ? `${base} · reference ${e.correlationId}` : base;
  }
  return e instanceof Error ? e.message : 'Unexpected error';
}

export function ErrorBanner({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="banner bad" role="alert">
      <div className="row between">
        <span>{describeError(error)}</span>
        {onRetry && <button onClick={onRetry}>Retry</button>}
      </div>
    </div>
  );
}

/** Every data region goes through this: explicit loading, error, empty and loaded states. */
export function DataState<T>({
  data,
  loading,
  error,
  reload,
  isEmpty,
  empty,
  children,
}: {
  data: T | undefined;
  loading: boolean;
  error: unknown;
  reload?: () => void;
  isEmpty?: (d: T) => boolean;
  empty?: ReactNode;
  children: (d: T) => ReactNode;
}) {
  if (error && data === undefined) return <ErrorBanner error={error} onRetry={reload} />;
  if (data === undefined) return loading ? <Spinner /> : null;
  return (
    <>
      {error ? <ErrorBanner error={error} onRetry={reload} /> : null}
      {isEmpty?.(data) ? <div className="empty">{empty ?? 'Nothing to show.'}</div> : children(data)}
    </>
  );
}

export function Banner({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'bad' | 'ok'; children: ReactNode }) {
  return (
    <div className={`banner ${kind}`} role={kind === 'bad' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function Pagination({ page, totalPages, onPage }: { page: number; totalPages: number; onPage: (p: number) => void }) {
  if (totalPages <= 1) return null;
  return (
    <nav className="row between" aria-label="Pagination" style={{ marginTop: 12 }}>
      <span className="muted small">
        Page {page + 1} of {totalPages}
      </span>
      <span className="row">
        <button onClick={() => onPage(page - 1)} disabled={page <= 0}>
          Previous
        </button>
        <button onClick={() => onPage(page + 1)} disabled={page + 1 >= totalPages}>
          Next
        </button>
      </span>
    </nav>
  );
}

/** Evidence ids rendered as plain text chips; linked to the underlying record where the API provided a route. */
export function EvidenceChip({ id, link }: { id: string; link?: string }) {
  return link ? (
    <Link className="chip" to={link} title="Open the cited record">
      {id}
    </Link>
  ) : (
    <span className="chip">{id}</span>
  );
}

export function KeyValues({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
