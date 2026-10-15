export const CURRENCIES = ["INR", "USD", "GBP", "EUR"] as const;
export type Currency = (typeof CURRENCIES)[number];

// Rough static rates relative to INR for shopping estimates (architecture hook for live FX).
const FROM_INR: Record<Currency, number> = { INR: 1, USD: 0.012, GBP: 0.0095, EUR: 0.011 };

export const convertFromInr = (amount: number, to: string) => amount * (FROM_INR[to as Currency] ?? 1);

export function formatMoney(amount: number, currency: string, locale?: string) {
  try {
    return new Intl.NumberFormat(locale ?? (currency === "INR" ? "en-IN" : "en"), { style: "currency", currency, maximumFractionDigits: currency === "INR" ? 0 : 2 }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

export function defaultCurrencyForLocale(locale: string | null | undefined): Currency {
  const l = (locale ?? "").toLowerCase();
  if (l.includes("-in")) return "INR";
  if (l.includes("-gb")) return "GBP";
  if (/-(de|fr|es|it|nl|ie|pt|at|be)$/.test(l)) return "EUR";
  if (l.includes("-us")) return "USD";
  return "INR";
}

export const toInr = (amount: number, from: string) => amount / (FROM_INR[from as Currency] ?? 1);
