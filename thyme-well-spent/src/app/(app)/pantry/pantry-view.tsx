"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Leaf, Lock, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { EmptyState } from "@/components/ui/states";
import { ShopTabs } from "@/components/app/shop-tabs";
import { RecipeCard } from "@/components/app/recipe-card";
import { api, fail } from "@/lib/client";
import { formatQty } from "@/lib/units";
import { splitQty, unitsFor } from "@/lib/qty";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { RecipeCard as Card } from "@/server/services/recipes";

type Item = { id: string; name: string; quantity: number; unit: string; category: string; expiresAt: string | null; daysLeft: number | null; status: "ok" | "use_soon" | "expired" };
type Soon = { item: { id: string; name: string; daysLeft: number }; meals: Card[] };

const badge = (i: Item) => i.status === "expired" ? { t: "Expired", c: "bg-danger/15 text-danger" } : i.status === "use_soon" ? { t: i.daysLeft === 0 ? "Use today" : `Use soon · ${i.daysLeft}d`, c: "bg-accent/15 text-accent" } : i.daysLeft !== null ? { t: `${i.daysLeft} days left`, c: "bg-muted text-muted-foreground" } : null;

export function PantryView({ items, soon, pro }: { items: Item[]; soon: Soon[]; pro: boolean }) {
  const [edit, setEdit] = useState<Item | "new" | null>(null);
  const hasSoon = items.some((i) => i.status === "use_soon");
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-3xl font-semibold">Pantry</h1><ShopTabs active="pantry" /></header>
      <p className="text-muted-foreground">What you already have. We'll leave it off your grocery list and suggest meals that use it up.</p>

      {pro ? soon.map((g) => (
        <section key={g.item.id} aria-label={`Use soon: ${g.item.name}`} className="space-y-3 rounded-3xl bg-accent/10 p-5">
          <h2 className="flex items-center gap-2 text-lg font-semibold"><Leaf className="h-5 w-5 text-accent" aria-hidden />Use soon</h2>
          <p className="text-[15px]">You have <strong>{g.item.name.toLowerCase()}</strong> {g.item.daysLeft < 0 ? "that's past its date" : g.item.daysLeft === 0 ? "expiring today" : `expiring in ${g.item.daysLeft} day${g.item.daysLeft === 1 ? "" : "s"}`}. Here {g.meals.length === 1 ? "is 1 meal" : `are ${g.meals.length} meals`} that use it.</p>
          <ul className="-mx-5 flex gap-4 overflow-x-auto px-5 pb-1 no-scrollbar">{g.meals.map((m) => <li key={m.id} className="w-[200px] shrink-0"><RecipeCard r={m} compact /></li>)}</ul>
        </section>
      )) : hasSoon && (
        <section className="flex items-center gap-3 rounded-3xl bg-muted p-4 text-sm"><Lock className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden /><p>Some items need using soon. <Link href="/subscription" className="font-semibold text-primary underline">Thyme Pro</Link> suggests meals to use them up.</p></section>
      )}

      <div className="flex justify-end"><Button onClick={() => setEdit("new")}><Plus className="h-4 w-4" />Add to pantry</Button></div>

      {items.length === 0 ? <EmptyState emoji="🥫" title="Your pantry is empty." body="Add what's in your kitchen so grocery lists skip it and meal ideas use it." action={<Button onClick={() => setEdit("new")}>Add an ingredient</Button>} /> : (
        <ul className="divide-y divide-border overflow-hidden rounded-3xl bg-card shadow-soft">
          {items.map((i) => { const b = badge(i); return (
            <li key={i.id}><button onClick={() => setEdit(i)} className="flex min-h-16 w-full items-center justify-between gap-3 px-5 py-3 text-left hover:bg-muted/50" aria-label={`Edit ${i.name}`}>
              <div className="min-w-0"><p className="truncate text-[16px] font-medium capitalize">{i.name}</p><p className="text-xs text-muted-foreground">{i.category}</p></div>
              <div className="flex shrink-0 items-center gap-3">{b && <span className={cn("rounded-full px-2.5 py-1 text-xs font-semibold", b.c)}>{b.t}</span>}<span className="font-semibold tabular-nums">{formatQty(i.quantity, i.unit)}{i.unit === "pc" ? "" : ""}</span></div>
            </button></li>
          ); })}
        </ul>
      )}
      {edit && <PantrySheet item={edit === "new" ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function PantrySheet({ item, onClose }: { item: Item | null; onClose: () => void }) {
  const router = useRouter();
  const init = item ? splitQty(item.quantity, item.unit) : { value: 1, unit: "kg" as const };
  const [name, setName] = useState(item?.name ?? "");
  const [value, setValue] = useState(init.value);
  const [unit, setUnit] = useState<string>(init.unit);
  const [expires, setExpires] = useState(item?.expiresAt ?? "");
  const [busy, setBusy] = useState(false);
  const units = item ? unitsFor(item.unit) : (["g", "kg", "ml", "l", "pc"] as const);
  async function save() {
    setBusy(true);
    try {
      if (item) await api("/api/pantry", { method: "PATCH", body: { id: item.id, quantity: value, unit, expiresAt: expires || null } });
      else await api("/api/pantry", { body: { name, quantity: value, unit, expiresAt: expires || null } });
      toast.success(item ? "Updated" : `Added ${name} to your pantry`); router.refresh(); onClose();
    } catch (e) { fail(e); } finally { setBusy(false); }
  }
  async function del() { try { await api(`/api/pantry?id=${item!.id}`, { method: "DELETE" }); toast("Removed"); router.refresh(); onClose(); } catch (e) { fail(e); } }
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={item ? item.name : "Add to pantry"} description={item ? "Update how much you have." : "Rice, olive oil, spinach…"}>
      <div className="space-y-4 pb-4">
        {!item && <div><label className="mb-1.5 block text-sm font-medium" htmlFor="pn">Ingredient</label><Input id="pn" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. spinach" autoFocus /></div>}
        <div className="flex gap-3">
          <div className="flex-1"><label className="mb-1.5 block text-sm font-medium" htmlFor="pq">Quantity</label><Input id="pq" type="number" inputMode="decimal" step="any" min={0} value={value} onChange={(e) => setValue(Number(e.target.value))} /></div>
          <div className="w-28"><label className="mb-1.5 block text-sm font-medium" htmlFor="pu">Unit</label><Select id="pu" value={unit} onChange={(e) => setUnit(e.target.value)}>{units.map((u) => <option key={u}>{u}</option>)}</Select></div>
        </div>
        <div><label className="mb-1.5 block text-sm font-medium" htmlFor="pe">Expiration date <span className="font-normal text-muted-foreground">(optional)</span></label><Input id="pe" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></div>
        <div className="flex gap-3">{item && <Button variant="outline" size="lg" onClick={del} className="text-danger" aria-label="Delete item"><Trash2 className="h-5 w-5" /></Button>}<Button size="lg" className="flex-1" onClick={save} loading={busy} disabled={(!item && !name.trim()) || !(value > 0)}>{item ? "Save" : "Add to pantry"}</Button></div>
      </div>
    </Sheet>
  );
}
