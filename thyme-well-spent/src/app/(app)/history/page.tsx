import Link from "next/link";
import { requireUserId } from "@/lib/session";
import { history, type HistoryRange } from "@/server/services/nutrition";
import { EmptyState } from "@/components/ui/states";
import { Button } from "@/components/ui/button";
import { MEAL_LABEL } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { HistoryDelete } from "./history-delete";

export const metadata = { title: "Meal history" };
export const dynamic = "force-dynamic";

const RANGES: [HistoryRange, string][] = [["today", "Today"], ["yesterday", "Yesterday"], ["this_week", "This week"], ["last_week", "Last week"], ["this_month", "This month"]];

export default async function HistoryPage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const userId = await requireUserId();
  const sp = await searchParams;
  const range = (RANGES.find(([v]) => v === sp.range)?.[0] ?? "this_week") as HistoryRange;
  const h = await history(userId, range);
  return (
    <div className="space-y-6">
      <header><h1 className="text-3xl font-semibold">Meal history</h1><p className="text-muted-foreground">Everything you've logged, day by day.</p></header>
      <nav aria-label="Date range" className="-mx-4 flex gap-2 overflow-x-auto px-4 no-scrollbar md:mx-0 md:px-0">
        {RANGES.map(([v, l]) => <Link key={v} href={`/history?range=${v}`} aria-current={range === v ? "page" : undefined} className={cn("tap inline-flex shrink-0 items-center rounded-full border px-4 text-sm font-medium", range === v ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card")}>{l}</Link>)}
      </nav>
      {h.days.length === 0 ? <EmptyState emoji="📖" title="Nothing logged in this period." body="Log a meal from Today and it will show up here." action={<Button asChild><Link href="/">Go to Today</Link></Button>} /> : (
        <div className="space-y-5">
          {h.days.map((d) => (
            <section key={d.date} aria-label={d.date} className="rounded-3xl bg-card p-5 shadow-soft">
              <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-lg font-semibold">{new Date(`${d.date}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" })}</h2>
                <p className="text-sm text-muted-foreground"><span className="font-semibold text-foreground tabular-nums">{d.totals.calories}</span> / {h.targets.calories} kcal · {Math.round(d.totals.protein)}g protein · {Math.round(d.totals.carbs)}g carbs · {Math.round(d.totals.fat)}g fat</p></div>
              {d.meals.length + d.foods.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">No meals logged.</p> : (
                <ul className="mt-3 divide-y divide-border">
                  {d.meals.map((m) => (
                    <li key={m.id} className="flex items-center justify-between gap-3 py-3"><div className="min-w-0"><p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{MEAL_LABEL[m.mealType]}{m.status === "skipped" ? " · skipped" : ""}</p><Link href={`/recipes/${m.recipe.id}`} className={cn("block truncate font-medium hover:underline", m.status === "skipped" && "text-muted-foreground line-through")}>{m.recipe.title}</Link>{m.notes && <p className="truncate text-xs text-muted-foreground">“{m.notes}”</p>}</div>
                      <div className="flex shrink-0 items-center gap-2 text-sm"><span className="tabular-nums text-muted-foreground">{m.consumedQuantity !== 1 && m.status === "eaten" ? `${m.consumedQuantity}× · ` : ""}{m.calories} kcal</span><HistoryDelete kind="meal" id={m.id} /></div></li>
                  ))}
                  {d.foods.map((f) => (
                    <li key={f.id} className="flex items-center justify-between gap-3 py-3"><div className="min-w-0"><p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{MEAL_LABEL[f.mealType]} · {f.source === "scan" ? "scanned" : "food"}</p><p className="truncate font-medium">{f.name}</p></div><div className="flex shrink-0 items-center gap-2 text-sm"><span className="tabular-nums text-muted-foreground">{f.calories} kcal</span><HistoryDelete kind="food" id={f.id} /></div></li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
