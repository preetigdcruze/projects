"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { Check, MoreHorizontal, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Input, Select } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { EmptyState } from "@/components/ui/states";
import { ShopTabs } from "@/components/app/shop-tabs";
import { api, fail } from "@/lib/client";
import { GROCERY_CATEGORIES } from "@/lib/grocery";
import { formatQty } from "@/lib/units";
import { formatMoney } from "@/lib/currency";
import { splitQty, unitsFor } from "@/lib/qty";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type Item = { id: string; name: string; quantity: number; unit: string; category: string; checked: boolean; fromMealPlan: boolean; recipeTitles: string[]; estimatedPrice: number | null };

export function GroceryView({ items: initial, currency, estimatedTotal }: { items: Item[]; currency: string; estimatedTotal: number }) {
  const router = useRouter();
  const [items, setItems] = useState(initial);
  const [prev, setPrev] = useState(initial);
  if (prev !== initial) { setPrev(initial); setItems(initial); } // re-sync after router.refresh()
  const [genOpen, setGenOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [edit, setEdit] = useState<Item | null>(null);
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);

  const groups = useMemo(() => GROCERY_CATEGORIES.map((c) => ({ c, list: items.filter((i) => i.category === c) })).filter((g) => g.list.length), [items]);
  const done = items.filter((i) => i.checked).length;
  const remainingCost = items.filter((i) => !i.checked).reduce((a, i) => a + (i.estimatedPrice ?? 0), 0);

  async function toggle(i: Item) {
    const next = !i.checked;
    setItems((l) => l.map((x) => (x.id === i.id ? { ...x, checked: next } : x))); // optimistic
    try { await api("/api/grocery/item", { method: "PATCH", body: { id: i.id, checked: next } }); }
    catch (e) { setItems((l) => l.map((x) => (x.id === i.id ? { ...x, checked: !next } : x))); fail(e); }
  }
  async function addItem(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setAdding(true);
    try { await api("/api/grocery/item", { body: { name: name.trim() } }); setName(""); router.refresh(); } catch (err) { fail(err); } finally { setAdding(false); }
  }
  async function clear(toPantry: boolean) {
    try { const r = await api<{ cleared: number }>("/api/grocery/clear", { body: { toPantry } }); toast.success(toPantry ? `Moved ${r.cleared} items to your pantry` : `Cleared ${r.cleared} completed items`); setMenu(false); router.refresh(); } catch (e) { fail(e); }
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-semibold">Grocery</h1>
        <ShopTabs active="grocery" />
      </header>

      {items.length > 0 && (
        <section aria-label="Shopping progress" className="rounded-3xl bg-card p-5 shadow-soft">
          <div className="flex items-end justify-between"><div><p className="font-display text-2xl font-semibold">{done} of {items.length} <span className="text-base font-normal text-muted-foreground">in the basket</span></p>{remainingCost > 0 && <p className="text-sm text-muted-foreground">About {formatMoney(Math.round(remainingCost), currency)} still to buy · estimate</p>}</div>
            <div className="flex gap-2"><Button variant="outline" size="icon" onClick={() => setGenOpen(true)} aria-label="Regenerate from plan"><RefreshCw className="h-4 w-4" /></Button><Button variant="outline" size="icon" onClick={() => setMenu(true)} aria-label="More options"><MoreHorizontal className="h-5 w-5" /></Button></div></div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={done} aria-valuemax={items.length} aria-label="Items checked"><motion.div className="h-full rounded-full bg-primary" animate={{ width: `${(done / items.length) * 100}%` }} transition={{ duration: 0.3 }} /></div>
        </section>
      )}

      <form onSubmit={addItem} className="flex gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Add an item, e.g. bananas" aria-label="Add an item" className="rounded-full" maxLength={80} />
        <Button type="submit" className="h-12" loading={adding} disabled={!name.trim()}><Plus className="h-4 w-4" />Add</Button>
      </form>

      {items.length === 0 ? (
        <EmptyState emoji="🛒" title="Your list is empty." body="Build it from your meal plan — we'll combine duplicates and skip what's already in your pantry." action={<Button size="lg" onClick={() => setGenOpen(true)}><RefreshCw className="h-5 w-5" />Generate from my plan</Button>} />
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <section key={g.c} aria-label={g.c}>
              <h2 className="mb-2 flex items-center gap-2 px-1 font-sans text-xs font-bold uppercase tracking-wider text-muted-foreground">{g.c}<span className="rounded-full bg-muted px-2 py-0.5 text-[11px]">{g.list.filter((x) => !x.checked).length}</span></h2>
              <ul className="divide-y divide-border overflow-hidden rounded-3xl bg-card shadow-soft">
                <AnimatePresence initial={false}>
                  {g.list.map((i) => (
                    <motion.li key={i.id} layout exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }} className="flex items-center gap-3 px-4">
                      <button role="checkbox" aria-checked={i.checked} aria-label={`${i.name}, ${formatQty(i.quantity, i.unit)}`} onClick={() => toggle(i)} className="tap -ml-1.5 flex shrink-0 items-center justify-center">
                        <span className={cn("flex h-7 w-7 items-center justify-center rounded-full border-2 transition-all duration-200", i.checked ? "border-primary bg-primary text-primary-foreground" : "border-border")}>{i.checked && <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ duration: 0.15 }}><Check className="h-4 w-4" strokeWidth={3} /></motion.span>}</span>
                      </button>
                      <button onClick={() => setEdit(i)} className="flex min-h-16 min-w-0 flex-1 items-center justify-between gap-3 py-2 text-left" aria-label={`Edit ${i.name}`}>
                        <motion.div animate={{ x: i.checked ? 4 : 0, opacity: i.checked ? 0.5 : 1 }} transition={{ duration: 0.2 }} className="min-w-0">
                          <p className={cn("truncate text-[16px] font-medium capitalize", i.checked && "line-through decoration-2")}>{i.name}</p>
                          <p className="truncate text-xs text-muted-foreground">{i.fromMealPlan ? "Added from meal plan" : i.recipeTitles.length ? `From ${i.recipeTitles.join(", ")}` : "Added by you"}</p>
                        </motion.div>
                        <span className={cn("shrink-0 font-semibold tabular-nums", i.checked && "text-muted-foreground line-through")}>{formatQty(i.quantity, i.unit)}</span>
                      </button>
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            </section>
          ))}
        </div>
      )}

      {genOpen && <GenerateListSheet onClose={() => setGenOpen(false)} />}
      {edit && <EditSheet item={edit} onClose={() => setEdit(null)} />}
      <Sheet open={menu} onOpenChange={setMenu} title="List options">
        <div className="space-y-2 pb-4">
          <Button variant="outline" className="w-full justify-start" disabled={!done} onClick={() => clear(true)}>Move {done} checked item{done === 1 ? "" : "s"} to pantry</Button>
          <Button variant="outline" className="w-full justify-start" disabled={!done} onClick={() => clear(false)}><Trash2 className="h-4 w-4" />Clear {done} completed</Button>
          <Button variant="outline" className="w-full justify-start text-danger" onClick={async () => { if (!confirm("Remove every item from your list?")) return; try { await api("/api/grocery/clear", { body: { all: true } }); setMenu(false); router.refresh(); } catch (e) { fail(e); } }}><Trash2 className="h-4 w-4" />Clear entire list</Button>
        </div>
      </Sheet>
    </div>
  );
}

function GenerateListSheet({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [days, setDays] = useState(7);
  const [pantry, setPantry] = useState(true);
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try {
      const d = new Date(); const from = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const r = await api<{ items: number; coveredByPantry: number; plannedMeals: number }>("/api/grocery/generate", { body: { from, days, subtractPantry: pantry } });
      toast.success(`${r.items} items from ${r.plannedMeals} meals${pantry && r.coveredByPantry ? ` · ${r.coveredByPantry} covered by your pantry` : ""}`);
      router.refresh(); onClose();
    } catch (e) { fail(e); } finally { setBusy(false); }
  }
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title="Generate from my plan" description="Duplicates are combined into one entry.">
      <div className="space-y-5 pb-4">
        <div><p className="mb-2 text-sm font-semibold">Cover the next…</p><div className="flex gap-2">{[3, 5, 7, 14].map((n) => <Chip key={n} active={days === n} onClick={() => setDays(n)}>{n} days</Chip>)}</div></div>
        <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 text-[15px]">Skip what's already in my pantry<input type="checkbox" checked={pantry} onChange={(e) => setPantry(e.target.checked)} className="h-5 w-5 accent-[hsl(var(--primary))]" /></label>
        <p className="text-xs text-muted-foreground">Items you added by hand stay on the list. Checked items stay checked.</p>
        <Button size="lg" className="w-full" onClick={go} loading={busy}>Build my list</Button>
      </div>
    </Sheet>
  );
}

function EditSheet({ item, onClose }: { item: Item; onClose: () => void }) {
  const router = useRouter();
  const init = splitQty(item.quantity, item.unit);
  const [value, setValue] = useState(init.value);
  const [unit, setUnit] = useState<string>(init.unit);
  const [category, setCategory] = useState(item.category);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { await api("/api/grocery/item", { method: "PATCH", body: { id: item.id, quantity: value, unit, category } }); router.refresh(); onClose(); } catch (e) { fail(e); } finally { setBusy(false); }
  }
  async function del() {
    try { await api(`/api/grocery/item?id=${item.id}`, { method: "DELETE" }); router.refresh(); onClose(); toast("Removed"); } catch (e) { fail(e); }
  }
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={item.name} description={item.fromMealPlan ? "Added from your meal plan" : undefined}>
      <div className="space-y-4 pb-4">
        <div className="flex gap-3">
          <div className="flex-1"><label className="mb-1.5 block text-sm font-medium" htmlFor="gq">Quantity</label><Input id="gq" type="number" inputMode="decimal" step="any" min={0} value={value} onChange={(e) => setValue(Number(e.target.value))} /></div>
          <div className="w-28"><label className="mb-1.5 block text-sm font-medium" htmlFor="gu">Unit</label><Select id="gu" value={unit} onChange={(e) => setUnit(e.target.value)}>{unitsFor(item.unit).map((u) => <option key={u}>{u}</option>)}</Select></div>
        </div>
        <div><label className="mb-1.5 block text-sm font-medium" htmlFor="gc">Category</label><Select id="gc" value={category} onChange={(e) => setCategory(e.target.value)}>{GROCERY_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</Select></div>
        {item.recipeTitles.length > 0 && <p className="text-sm text-muted-foreground">Used in: {item.recipeTitles.join(", ")}</p>}
        <div className="flex gap-3"><Button variant="outline" size="lg" onClick={del} aria-label="Delete item" className="text-danger"><Trash2 className="h-5 w-5" /></Button><Button size="lg" className="flex-1" onClick={save} loading={busy} disabled={!(value > 0)}>Save</Button></div>
      </div>
    </Sheet>
  );
}
