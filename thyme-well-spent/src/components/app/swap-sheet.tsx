"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Clock, Flame } from "lucide-react";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { FoodImage } from "@/components/ui/food-image";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState, EmptyState } from "@/components/ui/states";
import { api, fail } from "@/lib/client";
import { toast } from "sonner";
import type { Alternative } from "@/server/services/meal-plan";

export function SwapSheet({ open, onOpenChange, itemId, currentTitle, onSwapped }: { open: boolean; onOpenChange: (o: boolean) => void; itemId: string; currentTitle: string; onSwapped?: (title: string) => void }) {
  const router = useRouter();
  const [alts, setAlts] = useState<Alternative[] | null>(null);
  const [err, setErr] = useState(false);
  const [filters, setFilters] = useState({ vegetarian: false, highProtein: false, quick: false });
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setAlts(null); setErr(false);
    const q = new URLSearchParams({ itemId });
    if (filters.vegetarian) q.set("vegetarian", "1");
    if (filters.highProtein) q.set("highProtein", "1");
    if (filters.quick) q.set("maxMinutes", "20");
    try { setAlts((await api<{ alternatives: Alternative[] }>(`/api/meal-plan/alternatives?${q}`)).alternatives); } catch { setErr(true); }
  }, [itemId, filters]);
  useEffect(() => { if (open) void load(); }, [open, load]);

  async function pick(a: Alternative) {
    setBusy(a.recipeId);
    try {
      await api("/api/meal-plan/swap", { body: { itemId, recipeId: a.recipeId } });
      toast.success(`Swapped to ${a.title}`);
      onSwapped?.(a.title); router.refresh(); onOpenChange(false);
    } catch (e) { fail(e); } finally { setBusy(null); }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Swap this meal" description={`Instead of ${currentTitle}`}>
      <div className="-mx-5 mb-3 flex gap-2 overflow-x-auto px-5 no-scrollbar">
        <Chip active={filters.vegetarian} onClick={() => setFilters((f) => ({ ...f, vegetarian: !f.vegetarian }))}>Vegetarian</Chip>
        <Chip active={filters.highProtein} onClick={() => setFilters((f) => ({ ...f, highProtein: !f.highProtein }))}>High protein</Chip>
        <Chip active={filters.quick} onClick={() => setFilters((f) => ({ ...f, quick: !f.quick }))}>Under 20 min</Chip>
      </div>
      <div className="space-y-3 pb-4">
        {err && <ErrorState title="Couldn't load alternatives." onRetry={load} />}
        {!err && alts === null && [0, 1, 2].map((i) => <Skeleton key={i} className="h-24 w-full rounded-2xl" />)}
        {alts?.length === 0 && <EmptyState emoji="🔍" title="No matches" body="Try removing a filter to see more ideas." />}
        {alts?.map((a) => (
          <div key={a.recipeId} className="flex gap-3 rounded-2xl border border-border p-3">
            <FoodImage title={a.title} cuisine={a.cuisine} className="h-20 w-20 shrink-0 rounded-xl" emojiClass="text-3xl" image={a.image} sizes="80px" />
            <div className="min-w-0 flex-1">
              <h4 className="truncate text-[15px] font-semibold">{a.title}</h4>
              <p className="mt-0.5 flex gap-3 text-xs text-muted-foreground"><span className="inline-flex items-center gap-1"><Flame className="h-3 w-3" />{a.calories} kcal</span><span>{a.protein}g protein</span><span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{a.totalTime} min</span></p>
              <ul className="mt-1.5 space-y-0.5" aria-label="Why this works">
                {a.reasons.map((r) => <li key={r} className="flex items-center gap-1.5 text-xs text-primary"><Check className="h-3 w-3 shrink-0" />{r}</li>)}
              </ul>
            </div>
            <Button size="sm" variant="secondary" className="self-center" loading={busy === a.recipeId} onClick={() => pick(a)} aria-label={`Use ${a.title}`}>Use</Button>
          </div>
        ))}
      </div>
    </Sheet>
  );
}
