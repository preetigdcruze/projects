"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Input, Select } from "@/components/ui/input";
import { TagInput } from "@/components/ui/tag-input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError } from "@/lib/client";
import { DIET_OPTIONS } from "@/lib/diet";
import { addDays, iso } from "@/lib/dates";
import { toast } from "sonner";
import Link from "next/link";
import type { GenerateConfig } from "@/server/services/meal-plan";

export const CUISINES = ["Indian", "Italian", "Mexican", "Thai", "Mediterranean", "Japanese", "American", "Middle Eastern"];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><p className="mb-2 text-sm font-semibold">{label}</p>{children}</div>;
}
function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 text-[15px]">
      {label}
      <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${checked ? "bg-primary" : "bg-border"}`}>
        <span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all ${checked ? "left-6" : "left-1"}`} />
      </button>
    </label>
  );
}

export function GenerateButton({ label = "Generate my plan", variant = "primary", className }: { label?: string; variant?: "primary" | "accent" | "secondary" | "outline"; className?: string }) {
  const [open, setOpen] = useState(false);
  return (<><Button variant={variant} size="lg" className={className} onClick={() => setOpen(true)}><Sparkles className="h-5 w-5" />{label}</Button>{open && <GenerateSheet open={open} onOpenChange={setOpen} />}</>);
}

export function GenerateSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const router = useRouter();
  const [cfg, setCfg] = useState<GenerateConfig | null>(null);
  const [custom, setCustom] = useState(false);
  const [start, setStart] = useState<"today" | "tomorrow" | "monday">("today");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ msg: string; limit: boolean } | null>(null);

  useEffect(() => {
    if (!open) return;
    api<GenerateConfig>("/api/meal-plan/config").then((c) => setCfg({ ...c, days: 7 })).catch(() => setError({ msg: "Couldn't load your preferences.", limit: false }));
  }, [open]);

  const set = <K extends keyof GenerateConfig>(k: K, v: GenerateConfig[K]) => setCfg((c) => (c ? { ...c, [k]: v } : c));
  const toggleCuisine = (c: string) => cfg && set("cuisines", cfg.cuisines.includes(c) ? cfg.cuisines.filter((x) => x !== c) : [...cfg.cuisines, c]);

  async function go() {
    if (!cfg) return;
    setBusy(true); setError(null);
    const base = new Date(); base.setHours(0, 0, 0, 0);
    const d = new Date(Date.UTC(base.getFullYear(), base.getMonth(), base.getDate()));
    const startDate = start === "today" ? d : start === "tomorrow" ? addDays(d, 1) : addDays(d, ((8 - d.getUTCDay()) % 7) || 7);
    try {
      await api("/api/meal-plan/generate", { body: { ...cfg, startDate: iso(startDate), calories: custom ? Number(cfg.calories) || "auto" : "auto" } });
      toast.success("Your plan is ready. Review it and swap anything you like.");
      onOpenChange(false);
      router.push(`/plan?week=${iso(startDate)}&review=1`); router.refresh();
    } catch (e) {
      setError({ msg: e instanceof ApiError ? e.message : "Couldn't generate your meal plan.", limit: e instanceof ApiError && e.code === "limit_reached" });
    } finally { setBusy(false); }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Generate my plan" description="Tell us what you need — we'll handle the rest.">
      {!cfg ? <div className="space-y-4 pb-6">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div> : (
        <div className="space-y-6 pb-4">
          <Row label="Number of days"><div className="flex gap-2">{[3, 5, 7].map((n) => <Chip key={n} active={cfg.days === n} onClick={() => set("days", n)}>{n} days</Chip>)}</div></Row>
          <Row label="Start"><div className="flex gap-2">{([["today", "Today"], ["tomorrow", "Tomorrow"], ["monday", "Next Monday"]] as const).map(([v, l]) => <Chip key={v} active={start === v} onClick={() => setStart(v)}>{l}</Chip>)}</div></Row>
          <Row label="Calories">
            <div className="flex flex-wrap items-center gap-2">
              <Chip active={!custom} onClick={() => setCustom(false)}>Automatic</Chip><Chip active={custom} onClick={() => { setCustom(true); if (typeof cfg.calories !== "number") set("calories", 2000); }}>Custom</Chip>
              {custom && <Input type="number" inputMode="numeric" className="h-10 w-28" min={1000} max={6000} step={50} value={typeof cfg.calories === "number" ? cfg.calories : 2000} onChange={(e) => set("calories", Number(e.target.value))} aria-label="Daily calories" />}
            </div>
          </Row>
          <Row label="Meals per day"><div className="flex gap-2">{[2, 3, 4, 5].map((n) => <Chip key={n} active={cfg.mealsPerDay === n} onClick={() => set("mealsPerDay", n)}>{n}</Chip>)}</div></Row>
          <Row label="Cooking time"><div className="flex flex-wrap gap-2">{[15, 30, 45, 60].map((n) => <Chip key={n} active={cfg.maxMinutes === n} onClick={() => set("maxMinutes", n)}>{n} min</Chip>)}</div></Row>
          <Row label="Budget"><div className="flex gap-2">{(["low", "medium", "flexible"] as const).map((b) => <Chip key={b} active={cfg.budget === b} onClick={() => set("budget", b)}>{b[0].toUpperCase() + b.slice(1)}</Chip>)}</div></Row>
          <Row label="Cuisines you like"><div className="flex flex-wrap gap-2">{CUISINES.map((c) => <Chip key={c} active={cfg.cuisines.includes(c)} onClick={() => toggleCuisine(c)}>{c}</Chip>)}</div></Row>
          <Row label="Diet"><Select value={cfg.diet ?? "everything"} onChange={(e) => set("diet", e.target.value)} aria-label="Diet">{DIET_OPTIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}</Select></Row>
          <Row label="Allergies"><TagInput label="Allergies" value={cfg.allergies} onChange={(v) => set("allergies", v)} placeholder="e.g. peanuts, shellfish" /></Row>
          <Row label="Ingredients to avoid"><TagInput label="Ingredients to avoid" value={cfg.avoid} onChange={(v) => set("avoid", v)} placeholder="e.g. mushrooms, coconut" /></Row>
          <div className="divide-y divide-border rounded-2xl border border-border px-4">
            <Toggle label="Use pantry ingredients" checked={cfg.usePantry} onChange={(v) => set("usePantry", v)} />
            <Toggle label="Maximize variety" checked={cfg.variety} onChange={(v) => set("variety", v)} />
            <Toggle label="Use leftovers" checked={cfg.useLeftovers} onChange={(v) => set("useLeftovers", v)} />
          </div>
          {error && (
            <div role="alert" className="rounded-2xl bg-danger/10 p-4 text-sm">
              <p className="font-semibold text-danger">Couldn't generate your meal plan.</p><p className="mt-1">{error.msg}</p>
              {error.limit && <Button asChild size="sm" className="mt-3"><Link href="/subscription">See Thyme Pro</Link></Button>}
            </div>
          )}
          <Button size="lg" className="w-full" onClick={go} loading={busy}>{busy ? "Planning your meals…" : error && !error.limit ? "Try again" : "Generate my plan"}</Button>
        </div>
      )}
    </Sheet>
  );
}
