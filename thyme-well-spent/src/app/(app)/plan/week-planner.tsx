"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, ChevronLeft, ChevronRight, Copy, MoveRight, Pencil, Plus, ShoppingBasket, Trash2, MoreHorizontal, Bookmark, CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Chip } from "@/components/ui/chip";
import { Input, Select } from "@/components/ui/input";
import { Stepper } from "@/components/ui/stepper";
import { FoodImage } from "@/components/ui/food-image";
import { EmptyState } from "@/components/ui/states";
import { GenerateButton } from "@/components/app/generate-sheet";
import { MealCard } from "@/components/app/meal-card";
import { AddMealSheet } from "@/components/app/add-meal-sheet";
import { SwapSheet } from "@/components/app/swap-sheet";
import { api, fail } from "@/lib/client";
import { addDays, MEAL_LABEL, MEAL_ORDER } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { PlanItemView } from "@/server/services/meal-plan";

type Day = { date: string; items: PlanItemView[] };
type Props = { weekStart: string; prevWeek: string; nextWeek: string; today: string; days: Day[]; review: boolean; templates: { id: string; name: string; mealCount: number }[] };

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const dow = (s: string) => d(s).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
const dom = (s: string) => d(s).getUTCDate();
const range = (a: string, b: string) => `${d(a).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} – ${d(b).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`;

export function WeekPlanner({ weekStart, prevWeek, nextWeek, today, days, review, templates }: Props) {
  const router = useRouter();
  const todayIdx = days.findIndex((x) => x.date === today);
  const [sel, setSel] = useState(Math.max(todayIdx, 0));
  const [add, setAdd] = useState<{ date: string; mealType?: string } | null>(null);
  const [actions, setActions] = useState<PlanItemView | null>(null);
  const [menu, setMenu] = useState(false);
  const [tplOpen, setTplOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const totalMeals = days.reduce((a, x) => a + x.items.length, 0);
  const kcal = (items: PlanItemView[]) => items.reduce((a, i) => a + i.calories, 0);
  const weekEnd = days[6].date;

  async function repeatWeek() {
    setBusy(true);
    try {
      const to = addDays(d(weekStart), 7).toISOString().slice(0, 10);
      const r = await api<{ copied: number }>("/api/meal-plan/copy", { body: { from: weekStart, to, days: 7 } });
      toast.success(`Repeated ${r.copied} meals next week`); setMenu(false); router.push(`/plan?week=${to}`);
    } catch (e) { fail(e); } finally { setBusy(false); }
  }
  async function clearWeek() {
    if (!confirm("Remove all unlogged meals from this week?")) return;
    setBusy(true);
    try { const r = await api<{ removed: number }>("/api/meal-plan/copy", { method: "DELETE", body: { from: weekStart, days: 7 } }); toast(`Removed ${r.removed} meals`); setMenu(false); router.refresh(); } catch (e) { fail(e); } finally { setBusy(false); }
  }
  async function copyDay(from: string) {
    try { const to = addDays(d(from), 1).toISOString().slice(0, 10); const r = await api<{ copied: number }>("/api/meal-plan/copy", { body: { from, to, days: 1 } }); toast.success(`Copied ${r.copied} meals to tomorrow`); router.refresh(); } catch (e) { fail(e); }
  }
  async function confirmPlan() {
    setBusy(true);
    try { const r = await api<{ items: number }>("/api/grocery/generate", { body: {} }); toast.success(`Grocery list ready · ${r.items} items`); router.push("/grocery"); } catch (e) { fail(e); } finally { setBusy(false); }
  }

  const day = days[sel];
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold">Meal plan</h1>
          <div className="mt-1 flex items-center gap-1 text-muted-foreground">
            <Link href={`/plan?week=${prevWeek}`} aria-label="Previous week" className="tap flex items-center justify-center rounded-full hover:bg-muted"><ChevronLeft className="h-5 w-5" /></Link>
            <span className="min-w-36 text-center font-medium text-foreground">{range(weekStart, weekEnd)}</span>
            <Link href={`/plan?week=${nextWeek}`} aria-label="Next week" className="tap flex items-center justify-center rounded-full hover:bg-muted"><ChevronRight className="h-5 w-5" /></Link>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <GenerateButton />
          <Button variant="outline" size="icon" onClick={() => setMenu(true)} aria-label="Plan options"><MoreHorizontal className="h-5 w-5" /></Button>
        </div>
      </header>

      {review && totalMeals > 0 && (
        <div className="flex flex-col gap-3 rounded-3xl bg-primary p-5 text-primary-foreground shadow-lift sm:flex-row sm:items-center sm:justify-between">
          <div><p className="font-display text-lg font-semibold">Your plan is ready 🎉</p><p className="text-sm opacity-90">Swap anything you don't fancy, then confirm to build your grocery list.</p></div>
          <Button variant="secondary" onClick={confirmPlan} loading={busy} className="shrink-0"><ShoppingBasket className="h-4 w-4" />Confirm &amp; build grocery list</Button>
        </div>
      )}

      {totalMeals === 0 ? (
        <EmptyState emoji="🗓️" title="No meals planned yet." body="Give yourself a head start. We'll fill your week around your goals, tastes and time." action={<GenerateButton label="Generate my week" />} />
      ) : (
        <>
          {/* Mobile / tablet: horizontally scrolling day strip + agenda */}
          <div className="lg:hidden">
            <div role="tablist" aria-label="Days of the week" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-2 no-scrollbar">
              {days.map((x, i) => {
                const done = x.items.length > 0 && x.items.every((m) => m.status !== "planned");
                return (
                  <button key={x.date} role="tab" aria-selected={sel === i} onClick={() => setSel(i)} className={cn("relative flex h-[84px] w-[62px] shrink-0 flex-col items-center justify-center rounded-2xl border transition-all", sel === i ? "border-primary bg-primary text-primary-foreground shadow-soft" : "border-border bg-card")}>
                    <span className="text-xs font-medium opacity-80">{dow(x.date)}</span><span className="text-xl font-semibold">{dom(x.date)}</span>
                    <span className={cn("mt-1 text-[10px]", sel === i ? "opacity-80" : "text-muted-foreground")}>{x.items.length ? `${kcal(x.items)}` : "—"}</span>
                    {x.date === today && <span className={cn("absolute right-2 top-2 h-1.5 w-1.5 rounded-full", sel === i ? "bg-primary-foreground" : "bg-accent")} aria-label="Today" />}
                    {done && <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-[10px] text-white">✓</span>}
                  </button>
                );
              })}
            </div>
            <div className="mt-3 space-y-5" role="tabpanel">
              <div className="flex items-center justify-between"><h2 className="text-xl font-semibold">{d(day.date).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" })}</h2><div className="flex items-center gap-2"><span className="text-sm text-muted-foreground">{kcal(day.items)} kcal planned</span><button onClick={() => copyDay(day.date)} className="tap flex items-center justify-center rounded-full text-muted-foreground hover:bg-muted" aria-label="Copy this day to tomorrow"><Copy className="h-4 w-4" /></button></div></div>
              {MEAL_ORDER.map((m) => {
                const items = day.items.filter((i) => i.mealType === m);
                return (
                  <section key={m} aria-label={MEAL_LABEL[m]} className="space-y-2.5">
                    {items.map((i) => <MealCard key={i.id} item={i} onMore={() => setActions(i)} />)}
                    {items.length === 0 && (
                      <button onClick={() => setAdd({ date: day.date, mealType: m })} className="flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-border text-[15px] font-medium text-muted-foreground transition-colors hover:bg-muted"><Plus className="h-4 w-4" />Add {MEAL_LABEL[m].toLowerCase()}</button>
                    )}
                  </section>
                );
              })}
              <Button variant="outline" className="w-full" onClick={() => setAdd({ date: day.date })}><Plus className="h-4 w-4" />Add another meal</Button>
            </div>
          </div>

          {/* Desktop: full week grid */}
          <div className="hidden gap-3 lg:grid lg:grid-cols-7">
            {days.map((x) => (
              <section key={x.date} aria-label={dow(x.date)} className={cn("min-w-0 rounded-3xl p-2.5", x.date === today ? "bg-primary/10 ring-1 ring-primary/30" : "bg-card/70")}>
                <div className="px-1 pb-2 pt-1 text-center"><p className="text-xs font-medium text-muted-foreground">{dow(x.date)}</p><p className="font-display text-xl font-semibold">{dom(x.date)}</p><p className="text-[11px] text-muted-foreground">{kcal(x.items) || "—"} kcal</p></div>
                <div className="space-y-2">
                  {MEAL_ORDER.map((m) => {
                    const items = x.items.filter((i) => i.mealType === m);
                    return (
                      <div key={m}>
                        {items.map((i) => (
                          <button key={i.id} onClick={() => setActions(i)} className={cn("mb-1.5 block w-full overflow-hidden rounded-2xl bg-card text-left shadow-soft transition-shadow hover:shadow-lift", i.status === "eaten" && "opacity-70")} aria-label={`${MEAL_LABEL[m]}: ${i.title}. Options`}>
                            <FoodImage title={i.title} cuisine={i.cuisine} image={i.image} className="h-14 w-full" emojiClass="text-2xl" sizes="140px" />
                            <div className="p-2"><p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{MEAL_LABEL[m]}{i.isLeftover ? " · left." : ""}</p><p className="line-clamp-2 text-[13px] font-semibold leading-tight">{i.title}</p><p className="mt-0.5 text-[11px] text-muted-foreground">{i.calories} kcal · {i.totalTime}m{i.status === "eaten" ? " · ✓" : ""}</p></div>
                          </button>
                        ))}
                        {items.length === 0 && <button onClick={() => setAdd({ date: x.date, mealType: m })} className="mb-1.5 flex h-9 w-full items-center justify-center gap-1 rounded-xl border border-dashed border-border text-xs text-muted-foreground hover:bg-muted" aria-label={`Add ${MEAL_LABEL[m]} on ${dow(x.date)}`}><Plus className="h-3 w-3" />{MEAL_LABEL[m]}</button>}
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </>
      )}

      {add && <AddMealSheet open onOpenChange={(o) => !o && setAdd(null)} date={add.date} mealType={add.mealType} />}
      {actions && <ItemActions item={actions} weekDays={days.map((x) => x.date)} onClose={() => setActions(null)} />}

      <Sheet open={menu} onOpenChange={setMenu} title="Plan options" description={range(weekStart, weekEnd)}>
        <div className="space-y-2 pb-4">
          <Button variant="outline" className="w-full justify-start" onClick={() => { setMenu(false); setTplOpen(true); }}><Bookmark className="h-4 w-4" />Templates &amp; save this week</Button>
          <Button variant="outline" className="w-full justify-start" onClick={repeatWeek} loading={busy}><CalendarClock className="h-4 w-4" />Repeat this week next week</Button>
          <Button variant="outline" className="w-full justify-start" onClick={confirmPlan} loading={busy}><ShoppingBasket className="h-4 w-4" />Build grocery list from plan</Button>
          <Button variant="outline" className="w-full justify-start text-danger" onClick={clearWeek}><Trash2 className="h-4 w-4" />Clear unlogged meals this week</Button>
        </div>
      </Sheet>
      {tplOpen && <TemplatesSheet weekStart={weekStart} templates={templates} onClose={() => setTplOpen(false)} />}
    </div>
  );
}

function ItemActions({ item, weekDays, onClose }: { item: PlanItemView; weekDays: string[]; onClose: () => void }) {
  const router = useRouter();
  const [mode, setMode] = useState<"menu" | "edit" | "move" | "duplicate" | "swap">("menu");
  const [portion, setPortion] = useState(item.portion);
  const [servings, setServings] = useState(Math.round(item.servings));
  const [date, setDate] = useState(item.date);
  const [meal, setMeal] = useState(item.mealType);
  const [busy, setBusy] = useState(false);
  const locked = item.status !== "planned";
  const run = async (fn: () => Promise<unknown>, msg: string) => { setBusy(true); try { await fn(); toast.success(msg); router.refresh(); onClose(); } catch (e) { fail(e); } finally { setBusy(false); } };

  const dayOpts = useMemo(() => weekDays.map((x) => ({ v: x, l: d(x).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" }) })), [weekDays]);
  if (mode === "swap") return <SwapSheet open onOpenChange={(o) => !o && onClose()} itemId={item.id} currentTitle={item.title} />;
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={item.title} description={`${MEAL_LABEL[item.mealType]} · ${item.calories} kcal · ${item.protein}g protein`}>
      {mode === "menu" && (
        <div className="space-y-2 pb-4">
          <Button variant="outline" className="w-full justify-start" asChild><Link href={`/recipes/${item.recipeId}`}>View recipe</Link></Button>
          <Button variant="outline" className="w-full justify-start" onClick={() => setMode("swap")} disabled={locked}><ArrowLeftRight className="h-4 w-4" />Replace</Button>
          <Button variant="outline" className="w-full justify-start" onClick={() => setMode("edit")}><Pencil className="h-4 w-4" />Edit portions</Button>
          <Button variant="outline" className="w-full justify-start" onClick={() => setMode("move")} disabled={locked}><MoveRight className="h-4 w-4" />Move</Button>
          <Button variant="outline" className="w-full justify-start" onClick={() => setMode("duplicate")}><Copy className="h-4 w-4" />Duplicate</Button>
          <Button variant="outline" className="w-full justify-start text-danger" disabled={busy} onClick={() => run(() => api(`/api/meal-plan/item?id=${item.id}`, { method: "DELETE" }), "Removed")}><Trash2 className="h-4 w-4" />Remove</Button>
          {locked && <p className="px-1 pt-1 text-xs text-muted-foreground">Logged meals can't be replaced or moved. Edit the log from the meal card.</p>}
        </div>
      )}
      {mode === "edit" && (
        <div className="space-y-5 pb-4">
          <div className="flex items-center justify-between"><div><p className="font-medium">Your portion</p><p className="text-sm text-muted-foreground">× one serving</p></div><Stepper value={portion} onChange={setPortion} min={0.25} max={4} step={0.25} label="portion" /></div>
          <div className="flex items-center justify-between"><div><p className="font-medium">Servings to cook</p><p className="text-sm text-muted-foreground">Used for your grocery list</p></div><Stepper value={servings} onChange={setServings} min={1} max={20} label="servings" /></div>
          <Button size="lg" className="w-full" loading={busy} onClick={() => run(() => api("/api/meal-plan/item", { method: "PATCH", body: { action: "edit", id: item.id, portion, servings } }), "Updated")}>Save</Button>
        </div>
      )}
      {(mode === "move" || mode === "duplicate") && (
        <div className="space-y-4 pb-4">
          <Select value={date} onChange={(e) => setDate(e.target.value)} aria-label="Day">{dayOpts.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</Select>
          <div className="flex flex-wrap gap-2">{MEAL_ORDER.map((m) => <Chip key={m} active={meal === m} onClick={() => setMeal(m)}>{MEAL_LABEL[m]}</Chip>)}</div>
          <Button size="lg" className="w-full" loading={busy} onClick={() => run(() => api("/api/meal-plan/item", { method: "PATCH", body: { action: mode, id: item.id, date, mealType: meal } }), mode === "move" ? "Moved" : "Duplicated")}>{mode === "move" ? "Move meal" : "Duplicate meal"}</Button>
        </div>
      )}
    </Sheet>
  );
}

function TemplatesSheet({ weekStart, templates, onClose }: { weekStart: string; templates: { id: string; name: string; mealCount: number }[]; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>, msg: string) => { setBusy(key); try { await fn(); toast.success(msg); router.refresh(); } catch (e) { fail(e); } finally { setBusy(null); } };
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title="Templates" description="Save a week you loved and reuse it any time.">
      <div className="space-y-5 pb-4">
        <div className="flex gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. High Protein Week" aria-label="Template name" maxLength={60} />
          <Button disabled={!name.trim()} loading={busy === "save"} onClick={() => run("save", async () => { await api("/api/meal-plan/templates", { body: { name, weekStart } }); setName(""); }, "Template saved")}>Save</Button>
        </div>
        {templates.length === 0 ? <p className="py-4 text-center text-sm text-muted-foreground">No templates yet. Save this week to create your first one.</p> : (
          <ul className="space-y-2">
            {templates.map((t) => (
              <li key={t.id} className="flex items-center gap-3 rounded-2xl border border-border p-3">
                <div className="min-w-0 flex-1"><p className="truncate font-semibold">{t.name}</p><p className="text-xs text-muted-foreground">{t.mealCount} meals</p></div>
                <Button size="sm" variant="secondary" loading={busy === t.id} onClick={() => run(t.id, async () => { await api("/api/meal-plan/templates/apply", { body: { id: t.id, start: weekStart } }); onClose(); }, "Applied to this week")}>Apply</Button>
                <button onClick={() => run(`d${t.id}`, () => api(`/api/meal-plan/templates?id=${t.id}`, { method: "DELETE" }), "Deleted")} className="tap flex items-center justify-center rounded-full text-muted-foreground hover:bg-muted" aria-label={`Delete ${t.name}`}><Trash2 className="h-4 w-4" /></button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Sheet>
  );
}
