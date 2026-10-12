import { describe, expect, it } from 'vitest';
import { formatDateTime, formatMoney, formatPercent, shortId } from './format';

describe('format', () => {
  it('formats money with the currency and never as raw floats', () => {
    expect(formatMoney(49.9, 'EUR')).toContain('49.90');
    expect(formatMoney(1500, 'JPY')).toContain('1,500');
    expect(formatMoney(1, 'NOT_A_CURRENCY')).toBe('1.00 NOT_A_CURRENCY');
  });
  it('shows n/a instead of inventing a rate when the denominator was zero', () => {
    expect(formatPercent(undefined)).toBe('n/a');
    expect(formatPercent(0.0673)).toBe('6.7%');
    expect(formatPercent(0)).toBe('0.0%');
  });
  it('formats timestamps in UTC and tolerates garbage', () => {
    expect(formatDateTime('2026-10-15T09:11:51Z')).toBe('2026-10-15 09:11:51 UTC');
    expect(formatDateTime('garbage')).toBe('—');
    expect(formatDateTime(undefined)).toBe('—');
  });
  it('shortens ids', () => {
    expect(shortId('5e4d2f31-0abb-43c7-9577-118f445ec396')).toBe('5e4d2f31…');
  });
});
