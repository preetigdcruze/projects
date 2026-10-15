"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Undo2, X } from "lucide-react";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Input, Textarea } from "@/components/ui/input";
import { Stepper } from "@/components/ui/stepper";
import { api, fail } from "@/lib/client";
import { MEAL_LABEL } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export type LogTarget = {
  mealPlanItemId?: string; recipeId: string; title: string; mealType: string; date?: string;
  calories: number; protein: number; carbs: number; fat: number; // per ONE serving
  defaultQty: number; logId?: string; status?: "planned" | "eaten" | "skipped"; consumedQuantity?: number; canLeftover?: boolean;
};

const PRESETS = [0.5, 0.75, 1, 1.5, 2];

export function LogMealSheet({ open, onOpenChange, target }: { open: boolean; onOpenChange: (o: boolean) => void; target: LogTarget }) {
  const router = useRouter();
  const startQty = target.consumedQuantity ?? target.defaultQty;
  const [ate, setAte] = useState<boolean>(target.status !== "skipped");
  const [qty, setQty] = useState(startQty);
  const [custom, setCustom] = useState(!PRESETS.includes(startQty));
  const [notes, setNotes] = useState("");
  const [saveLeft, setSaveLeft] = useState(false);
  const [leftServings, setLeftServings] = useState(1);
  const [busy, setBusy] = useState(false);
  const [slots, setSlots] = useState<{ date: string; mealType: string; label: string }[] | null>(null);

  useEffect(() => { if (open) { setAte(target.status !== "skipped"); setQty(startQty); setCustom(!PRESETS.includes(startQty)); setSlots(null); setSaveLeft(false); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const m = (v: number) => Math.round(v * qty);
  async function save() {
    setBusy(true);
    try {
      await api("/api/meals/log", { body: { mealPlanItemId: target.mealPlanItemId, recipeId: target.recipeId, mealType: target.mealType, date: target.date, status: ate ? "eaten" : "skipped", consumedQuantity: ate ? qty : 1, notes: notes || null } });
      router.refresh();
      if (ate && saveLeft) {
        const r = await api<{ slots: { date: string; mealType: string; label: string }[] }>(`/api/leftovers?recipeId=${target.recipeId}`);
        await api("/api/leftovers", { body: { recipeId: target.recipeId, servings: leftServings } });
        setSlots(r.slots);
        toast.success("Logged · leftovers saved");
        return;
      }
      toast.success(ate ? `Logged ${target.title}` : "Marked as skipped");
      onOpenChange(false);
    } catch (e) { fail(e); } finally { setBusy(false); }
  }
  async function undo() {
    if (!target.logId) return;
    setBusy(true);
    try { await api(`/api/meals/log?id=${target.logId}`, { method: "DELETE" }); router.refresh(); toast("Log removed"); onOpenChange(false); } catch (e) { fail(e); } finally { setBusy(false); }
  }
  async function planLeftover(s: { date: string; mealType: string }) {
    try { await api("/api/leftovers", { body: { recipeId: target.recipeId, servings: leftServings, planDate: s.date, mealType: s.mealType } }); router.refresh(); toast.success("Added to your plan"); onOpenChange(false); } catch (e) { fail(e); }
  }

  if (slots) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange} title="Leftovers saved" description="Reduce waste by planning them for later.">
        <div className="space-y-3 pb-4">
          <p className="text-[15px]">Suggested: <strong>{slots[0]?.label}</strong> — Leftover {target.title}</p>
          {slots.map((s) => <Button key={s.date + s.mealType} variant="outline" className="w-full justify-start" onClick={() => planLeftover(s)}>Add to {s.label}</Button>)}
          <Button variant="ghost" className="w-full" onClick={() => onOpenChange(false)}>No thanks</Button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Did you eat this?" description={`${MEAL_LABEL[target.mealType] ?? target.mealType} · ${target.title}`}>
      <div className="space-y-5 pb-4">
        <div className="grid grid-cols-2 gap-3">
          <button onClick={() => setAte(true)} aria-pressed={ate} className={cn("tap flex h-14 items-center justify-center gap-2 rounded-2xl border-2 text-base font-semibold transition-all", ate ? "border-primary bg-primary/10 text-primary" : "border-border")}><Check className="h-5 w-5" />Yes</button>
          <button onClick={() => setAte(false)} aria-pressed={!ate} className={cn("tap flex h-14 items-center justify-center gap-2 rounded-2xl border-2 text-base font-semibold transition-all", !ate ? "border-foreground/60 bg-muted" : "border-border")}><X className="h-5 w-5" />No, skipped</button>
        </div>
        {ate && (
          <>
            <div>
              <p className="mb-2 text-sm font-medium">Modify portion</p>
              <div className="flex flex-wrap gap-2">
                {PRESETS.map((p) => <Chip key={p} active={!custom && qty === p} onClick={() => { setQty(p); setCustom(false); }}>{p}×</Chip>)}
                <Chip active={custom} onClick={() => setCustom(true)}>Custom</Chip>
              </div>
              {custom && (
                <div className="mt-3 flex items-center gap-3">
                  <Input type="number" inputMode="decimal" min={0.1} max={10} step={0.05} value={qty} onChange={(e) => setQty(Math.min(10, Math.max(0.1, Number(e.target.value) || 0.1)))} className="w-28" aria-label="Custom portion multiplier" />
                  <span className="text-sm text-muted-foreground">× one serving</span>
                </div>
              )}
            </div>
            <div className="grid grid-cols-4 gap-2 rounded-2xl bg-muted p-3 text-center" aria-live="polite">
              {[["kcal", m(target.calories)], ["protein", `${m(target.protein)}g`], ["carbs", `${m(target.carbs)}g`], ["fat", `${m(target.fat)}g`]].map(([l, v]) => <div key={l}><div className="text-lg font-semibold tabular-nums">{v}</div><div className="text-xs text-muted-foreground">{l}</div></div>)}
            </div>
            <Textarea placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} className="min-h-16" aria-label="Notes" />
            {target.canLeftover && (
              <div className="rounded-2xl border border-border p-3">
                <label className="flex cursor-pointer items-center justify-between gap-3 text-[15px] font-medium">
                  Save leftovers
                  <input type="checkbox" checked={saveLeft} onChange={(e) => setSaveLeft(e.target.checked)} className="h-5 w-5 accent-[hsl(var(--primary))]" />
                </label>
                {saveLeft && <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">Servings left over<Stepper value={leftServings} onChange={setLeftServings} min={1} max={12} label="leftover servings" /></div>}
              </div>
            )}
          </>
        )}
        <div className="flex gap-3">
          {target.logId && <Button variant="outline" size="lg" onClick={undo} disabled={busy} aria-label="Undo log"><Undo2 className="h-5 w-5" /></Button>}
          <Button size="lg" className="flex-1" onClick={save} loading={busy}>{target.logId ? "Update log" : ate ? "Log meal" : "Mark skipped"}</Button>
        </div>
      </div>
    </Sheet>
  );
}
