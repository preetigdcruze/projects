"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Search } from "lucide-react";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Input } from "@/components/ui/input";
import { FoodImage } from "@/components/ui/food-image";
import { Skeleton } from "@/components/ui/skeleton";
import { api, fail } from "@/lib/client";
import { MEAL_LABEL, MEAL_ORDER } from "@/lib/dates";
import { toast } from "sonner";
import type { RecipeCard } from "@/server/services/recipes";

/** Pick a recipe and put it on a day/meal. `date` + `mealType` pre-fill when opened from an empty slot. */
export function AddMealSheet({ open, onOpenChange, date, mealType: initialMeal }: { open: boolean; onOpenChange: (o: boolean) => void; date: string; mealType?: string }) {
  const router = useRouter();
  const [meal, setMeal] = useState(initialMeal ?? "dinner");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<RecipeCard[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { if (open && initialMeal) setMeal(initialMeal); }, [open, initialMeal]);
  useEffect(() => {
    if (!open) return;
    setItems(null);
    const t = setTimeout(async () => {
      try { setItems((await api<{ items: RecipeCard[] }>(`/api/recipes?${new URLSearchParams({ q, mealType: meal, pageSize: "20" })}`)).items); } catch (e) { fail(e); setItems([]); }
    }, q ? 250 : 0); // debounce typing
    return () => clearTimeout(t);
  }, [open, q, meal]);

  async function add(r: RecipeCard) {
    setBusy(r.id);
    try { await api("/api/meal-plan/add", { body: { date, mealType: meal, recipeId: r.id } }); toast.success(`Added ${r.title}`); router.refresh(); onOpenChange(false); } catch (e) { fail(e); } finally { setBusy(null); }
  }
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Add a meal" description={new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" })}>
      <div className="space-y-3 pb-4">
        <div className="-mx-5 flex gap-2 overflow-x-auto px-5 no-scrollbar">{MEAL_ORDER.map((m) => <Chip key={m} active={meal === m} onClick={() => setMeal(m)}>{MEAL_LABEL[m]}</Chip>)}</div>
        <div className="relative"><Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search recipes or ingredients" className="pl-10" aria-label="Search recipes" /></div>
        {items === null && [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
        {items?.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No recipes found. Try a different search.</p>}
        {items?.map((r) => (
          <div key={r.id} className="flex items-center gap-3 rounded-2xl border border-border p-2.5">
            <FoodImage title={r.title} cuisine={r.cuisine} image={r.image} className="h-14 w-14 shrink-0 rounded-xl" emojiClass="text-2xl" sizes="56px" />
            <div className="min-w-0 flex-1"><h4 className="truncate text-[15px] font-semibold">{r.title}</h4><p className="text-xs text-muted-foreground">{r.calories} kcal · {r.protein}g protein · {r.totalTime} min</p></div>
            <Button size="sm" variant="secondary" loading={busy === r.id} onClick={() => add(r)} aria-label={`Add ${r.title}`}><Plus className="h-4 w-4" />Add</Button>
          </div>
        ))}
      </div>
    </Sheet>
  );
}
