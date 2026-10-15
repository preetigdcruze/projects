"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Camera, Check, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, Segmented } from "@/components/ui/chip";
import { Field, Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError, fail } from "@/lib/client";
import { MEAL_LABEL, MEAL_ORDER } from "@/lib/dates";
import { toast } from "sonner";

type Food = { id: string; name: string; serving: string; calories: number; protein: number; carbs: number; fat: number; fiber: number };
type Scan = { match: string; confidence: number; estimated: { calories: number; protein: number; carbs: number; fat: number }; alternatives: string[]; disclaimer: string; provider: string };

const guessMeal = () => { const h = new Date().getHours(); return h < 11 ? "breakfast" : h < 15 ? "lunch" : h < 18 ? "snack" : "dinner"; };

export function LogFood({ initialTab }: { initialTab: "search" | "quick" | "scan" }) {
  const router = useRouter();
  const [tab, setTab] = useState(initialTab);
  const [meal, setMeal] = useState(guessMeal());
  const [added, setAdded] = useState<string[]>([]);

  async function log(body: Record<string, unknown>, label: string) {
    try { await api("/api/foods/log", { body: { mealType: meal, ...body } }); setAdded((a) => [...a, label]); toast.success(`Added ${label} to ${MEAL_LABEL[meal].toLowerCase()}`); router.refresh(); } catch (e) { fail(e); }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <header className="flex items-center gap-3"><Link href="/" aria-label="Back to today" className="tap flex items-center justify-center rounded-full bg-muted"><ArrowLeft className="h-5 w-5" /></Link><div><h1 className="text-3xl font-semibold">Add food</h1><p className="text-sm text-muted-foreground">Log something that isn't in your plan</p></div></header>
      <div><p className="mb-2 text-sm font-semibold">Add to</p><div className="flex flex-wrap gap-2">{MEAL_ORDER.map((m) => <Chip key={m} active={meal === m} onClick={() => setMeal(m)}>{MEAL_LABEL[m]}</Chip>)}</div></div>
      <Segmented label="How to add" value={tab} onChange={setTab} options={[{ value: "search", label: "Search" }, { value: "quick", label: "Quick add" }, { value: "scan", label: "Scan" }]} />
      {tab === "search" && <SearchTab meal={meal} onAdd={log} />}
      {tab === "quick" && <QuickTab onAdd={log} />}
      {tab === "scan" && <ScanTab onAdd={log} />}
      {added.length > 0 && <div className="flex items-center justify-between rounded-3xl bg-secondary p-4"><p className="text-sm font-medium text-secondary-foreground"><Check className="mr-1.5 inline h-4 w-4" />Added {added.length} item{added.length === 1 ? "" : "s"}</p><Button asChild size="sm"><Link href="/">Back to today</Link></Button></div>}
    </div>
  );
}

function SearchTab({ meal, onAdd }: { meal: string; onAdd: (b: Record<string, unknown>, label: string) => Promise<void> }) {
  const [q, setQ] = useState("banana");
  const [foods, setFoods] = useState<Food[] | null>(null);
  const [qty, setQty] = useState<Record<string, number>>({});
  useEffect(() => {
    setFoods(null);
    const t = setTimeout(async () => { try { setFoods((await api<{ foods: Food[] }>(`/api/foods/search?q=${encodeURIComponent(q)}`)).foods); } catch (e) { fail(e); setFoods([]); } }, 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="space-y-3">
      <div className="relative"><Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search foods, e.g. banana" className="h-12 rounded-full pl-12" aria-label="Search foods" type="search" /></div>
      {foods === null && [0, 1, 2].map((i) => <Skeleton key={i} className="h-24 w-full rounded-3xl" />)}
      {foods?.length === 0 && <div className="rounded-3xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">No match for “{q}”. Try “Quick add” to enter it yourself.</div>}
      {foods?.map((f) => {
        const n = qty[f.id] ?? 1;
        return (
          <div key={f.id} className="rounded-3xl bg-card p-4 shadow-soft">
            <div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold">{f.name}</h3><p className="text-xs text-muted-foreground">{f.serving}</p></div><p className="text-right"><span className="text-xl font-semibold tabular-nums">{Math.round(f.calories * n)}</span> <span className="text-sm text-muted-foreground">kcal</span></p></div>
            <p className="mt-1 text-sm text-muted-foreground">{Math.round(f.protein * n * 10) / 10}g protein · {Math.round(f.carbs * n * 10) / 10}g carbs · {Math.round(f.fat * n * 10) / 10}g fat</p>
            <div className="mt-3 flex items-center justify-between gap-3">
              <div className="flex gap-1.5">{[0.5, 1, 2].map((v) => <Chip key={v} active={n === v} onClick={() => setQty((s) => ({ ...s, [f.id]: v }))} className="px-3 py-1">{v}×</Chip>)}</div>
              <Button size="sm" onClick={() => onAdd({ name: f.name, calories: f.calories, protein: f.protein, carbs: f.carbs, fat: f.fat, fiber: f.fiber, quantity: n, source: "search" }, f.name)}>Add to {MEAL_LABEL[meal].toLowerCase()}</Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function QuickTab({ onAdd }: { onAdd: (b: Record<string, unknown>, label: string) => Promise<void> }) {
  const [v, setV] = useState({ name: "", calories: "", protein: "", carbs: "", fat: "" });
  const [busy, setBusy] = useState(false);
  const ok = v.name.trim() && Number(v.calories) >= 0 && v.calories !== "";
  return (
    <form className="space-y-4 rounded-3xl bg-card p-5 shadow-soft" onSubmit={async (e) => { e.preventDefault(); setBusy(true); await onAdd({ name: v.name, calories: Number(v.calories), protein: Number(v.protein) || 0, carbs: Number(v.carbs) || 0, fat: Number(v.fat) || 0, source: "manual" }, v.name); setV({ name: "", calories: "", protein: "", carbs: "", fat: "" }); setBusy(false); }}>
      <Field label="Food name" htmlFor="qn"><Input id="qn" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="e.g. Homemade smoothie" /></Field>
      <Field label="Calories" htmlFor="qc"><Input id="qc" type="number" inputMode="numeric" min={0} value={v.calories} onChange={(e) => setV({ ...v, calories: e.target.value })} /></Field>
      <div className="grid grid-cols-3 gap-3">{(["protein", "carbs", "fat"] as const).map((k) => <Field key={k} label={`${k[0].toUpperCase()}${k.slice(1)} (g)`} htmlFor={`q${k}`}><Input id={`q${k}`} type="number" inputMode="decimal" min={0} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} /></Field>)}</div>
      <Button type="submit" size="lg" className="w-full" loading={busy} disabled={!ok}>Add food</Button>
    </form>
  );
}

function ScanTab({ onAdd }: { onAdd: (b: Record<string, unknown>, label: string) => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<Scan | null>(null);
  const [vals, setVals] = useState({ calories: 0, protein: 0, carbs: 0, fat: 0 });
  const [name, setName] = useState("");

  async function pick(file?: File) {
    if (!file) return;
    setPreview(URL.createObjectURL(file)); setBusy(true); setErr(null); setRes(null);
    try {
      const fd = new FormData(); fd.append("image", file);
      const r = await api<Scan>("/api/scan", { body: fd });
      setRes(r); setName(r.match); setVals(r.estimated);
    } catch (e) { setErr(e instanceof ApiError ? e.message : "We couldn't read that photo."); } finally { setBusy(false); }
  }
  return (
    <div className="space-y-4">
      <div className="rounded-3xl bg-card p-5 text-center shadow-soft">
        <input ref={input} type="file" accept="image/*" capture="environment" className="sr-only" aria-label="Take or choose a photo of your food" onChange={(e) => pick(e.target.files?.[0])} />
        {preview ? <img src={preview} alt="Your food" className="mx-auto h-56 w-full max-w-sm rounded-2xl object-cover" /> : <div className="mx-auto flex h-40 max-w-sm items-center justify-center rounded-2xl bg-muted text-5xl" aria-hidden>📸</div>}
        <h2 className="mt-4 text-xl font-semibold">Scan your food</h2>
        <p className="mt-1 text-sm text-muted-foreground">Snap a photo and we'll suggest what it might be. You'll confirm before anything is logged.</p>
        <Button size="lg" className="mt-4" onClick={() => input.current?.click()} loading={busy}><Camera className="h-5 w-5" />{preview ? "Try another photo" : "Open camera"}</Button>
      </div>
      {busy && <Skeleton className="h-40 w-full rounded-3xl" />}
      {err && <p role="alert" className="rounded-2xl bg-danger/10 px-4 py-3 text-sm text-danger">{err}</p>}
      {res && (
        <div className="space-y-4 rounded-3xl bg-card p-5 shadow-soft">
          <div><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Possible match · {Math.round(res.confidence * 100)}% sure</p><Input aria-label="Food name" className="mt-1 h-12 font-display text-xl font-semibold" value={name} onChange={(e) => setName(e.target.value)} />
            {res.alternatives.length > 0 && <p className="mt-2 text-xs text-muted-foreground">Could also be: {res.alternatives.join(", ")}</p>}</div>
          <div><p className="mb-2 text-sm font-medium">Estimated — adjust if it looks off</p>
            <div className="grid grid-cols-4 gap-2">{([["calories", "kcal"], ["protein", "protein g"], ["carbs", "carbs g"], ["fat", "fat g"]] as const).map(([k, l]) => <div key={k}><Input aria-label={l} type="number" inputMode="numeric" className="h-11 px-2 text-center font-semibold" value={vals[k]} onChange={(e) => setVals({ ...vals, [k]: Number(e.target.value) })} /><p className="mt-1 text-center text-[11px] text-muted-foreground">{l}</p></div>)}</div></div>
          <p className="text-xs text-muted-foreground">{res.disclaimer}{res.provider === "mock" ? " (Demo mode: results come from a sample scanner, not real image recognition.)" : ""}</p>
          <Button size="lg" className="w-full" disabled={!name.trim()} onClick={async () => { await onAdd({ ...vals, name, source: "scan" }, name); setRes(null); setPreview(null); }}>Confirm &amp; log</Button>
        </div>
      )}
    </div>
  );
}
