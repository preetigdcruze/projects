"use client";
import { cn } from "@/lib/utils";

export function Chip({ active, children, className, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button type="button" aria-pressed={active} className={cn("tap inline-flex shrink-0 items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-medium transition-all duration-200 active:scale-95",
      active ? "border-primary bg-primary text-primary-foreground shadow-soft" : "border-border bg-card text-foreground hover:bg-muted", className)} {...p}>
      {children}
    </button>
  );
}

export function Tag({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground", className)}>{children}</span>;
}

export function Segmented<T extends string>({ value, onChange, options, className, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; className?: string; label?: string }) {
  return (
    <div role="tablist" aria-label={label} className={cn("inline-flex rounded-full bg-muted p-1", className)}>
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={value === o.value} onClick={() => onChange(o.value)}
          className={cn("tap rounded-full px-4 py-1.5 text-sm font-medium transition-all", value === o.value ? "bg-card text-foreground shadow-soft" : "text-muted-foreground hover:text-foreground")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
