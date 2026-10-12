export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function formatPercent(ratio: number | undefined | null, digits = 1): string {
  return ratio === undefined || ratio === null ? 'n/a' : `${(ratio * 100).toFixed(digits)}%`;
}

export function formatDateTime(iso: string | undefined | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toISOString().slice(11, 16);
}

export function shortId(id: string): string {
  return id.length > 13 ? `${id.slice(0, 8)}…` : id;
}

export function ms(v: number | undefined | null): string {
  return v === undefined || v === null ? '—' : `${v} ms`;
}
