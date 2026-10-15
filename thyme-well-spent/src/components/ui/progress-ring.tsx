"use client";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

export function ProgressRing({ value, max, size = 132, stroke = 12, children, className }: { value: number; max: number; size?: number; stroke?: number; children?: React.ReactNode; className?: string }) {
  const pct = max > 0 ? Math.min(value / max, 1) : 0;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const over = max > 0 && value > max * 1.1;
  return (
    <div className={cn("relative inline-flex items-center justify-center", className)} style={{ width: size, height: size }} role="img" aria-label={`${Math.round(value)} of ${Math.round(max)}`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-muted" />
        <motion.circle
          cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} strokeLinecap="round" className={over ? "stroke-danger" : "stroke-primary"}
          strokeDasharray={c} initial={{ strokeDashoffset: c }} animate={{ strokeDashoffset: c * (1 - pct) }} transition={{ duration: 0.7, ease: "easeOut" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">{children}</div>
    </div>
  );
}

export function MacroBar({ label, value, target, unit = "g", color }: { label: string; value: number; target: number; unit?: string; color: "protein" | "carbs" | "fat" }) {
  const pct = target > 0 ? Math.min((value / target) * 100, 100) : 0;
  const bg = { protein: "bg-protein", carbs: "bg-carbs", fat: "bg-fat" }[color];
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1.5 flex items-baseline justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground"><span className="font-semibold text-foreground">{Math.round(value)}</span>/{Math.round(target)}{unit}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={label} aria-valuenow={Math.round(value)} aria-valuemax={Math.round(target)}>
        <motion.div className={cn("h-full rounded-full", bg)} initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.6, ease: "easeOut" }} />
      </div>
    </div>
  );
}
