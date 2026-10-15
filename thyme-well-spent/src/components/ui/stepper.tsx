"use client";
import { Minus, Plus } from "lucide-react";

export function Stepper({ value, onChange, min = 1, max = 20, step = 1, label }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; label: string }) {
  const dec = () => onChange(Math.max(min, Math.round((value - step) * 100) / 100));
  const inc = () => onChange(Math.min(max, Math.round((value + step) * 100) / 100));
  return (
    <div className="inline-flex items-center gap-1 rounded-full bg-muted p-1" role="group" aria-label={label}>
      <button type="button" onClick={dec} disabled={value <= min} aria-label={`Decrease ${label}`} className="tap flex items-center justify-center rounded-full bg-card shadow-soft disabled:opacity-40"><Minus className="h-4 w-4" /></button>
      <span className="min-w-10 text-center text-base font-semibold tabular-nums" aria-live="polite">{value}</span>
      <button type="button" onClick={inc} disabled={value >= max} aria-label={`Increase ${label}`} className="tap flex items-center justify-center rounded-full bg-card shadow-soft disabled:opacity-40"><Plus className="h-4 w-4" /></button>
    </div>
  );
}
