import Link from "next/link";
import { ChefHat, Flame, Lock, Target, TrendingUp, Utensils } from "lucide-react";
import { requireUserId } from "@/lib/session";
import { today } from "@/lib/dates";
import { daySummary, weeklyProgress } from "@/server/services/nutrition";
import { getPlan } from "@/server/services/subscription";
import { DayProgress } from "@/components/app/day-progress";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Progress" };
export const dynamic = "force-dynamic";

function Stat({ icon: Icon, label, value, sub }: { icon: typeof Flame; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-3xl bg-card p-4 shadow-soft">
      <div className="flex items-center gap-2 text-sm text-muted-foreground"><Icon className="h-4 w-4" aria-hidden />{label}</div>
      <p className="mt-2 font-display text-3xl font-semibold tabular-nums">{value}</p>{sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

export default async function ProgressPage() {
  const userId = await requireUserId();
  const [w, t, plan] = await Promise.all([weeklyProgress(userId), daySummary(userId, today()), getPlan(userId)]);
  const max = Math.max(w.targets.calories * 1.25, ...w.days.map((d) => d.totals.calories));
  const H = 160, bar = 34, gap = 14, W = 7 * (bar + gap);
  const y = (v: number) => H - (v / max) * H;
  const macroCal = w.averages.protein * 4 + w.averages.carbs * 4 + w.averages.fat * 9 || 1;

  return (
    <div className="space-y-7">
      <header className="flex items-end justify-between gap-3"><div><h1 className="text-3xl font-semibold">Progress</h1><p className="text-muted-foreground">Your last 7 days at a glance</p></div><Button asChild variant="outline" size="sm"><Link href="/history">Meal history</Link></Button></header>

      <section aria-label="Today"><h2 className="mb-3 text-xl font-semibold">Today</h2><DayProgress consumed={t.consumed} targets={t.targets} /></section>

      <section aria-labelledby="week-h" className="space-y-3">
        <h2 id="week-h" className="text-xl font-semibold">This week</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <Stat icon={Flame} label="Avg calories" value={w.daysLogged ? w.averages.calories.toLocaleString() : "—"} sub={`target ${w.targets.calories.toLocaleString()} · ${w.daysLogged} day${w.daysLogged === 1 ? "" : "s"} logged`} />
          <Stat icon={Target} label="Avg protein" value={w.daysLogged ? `${w.averages.protein}g` : "—"} sub={`target ${w.targets.proteinG}g`} />
          <Stat icon={Utensils} label="Meal consistency" value={w.consistency === null ? "—" : `${w.consistency}%`} sub={w.consistency === null ? "No planned meals yet" : `${w.eatenMeals} of ${w.plannedMeals} planned meals logged`} />
          <Stat icon={TrendingUp} label="Goal adherence" value={w.adherence === null ? "—" : `${w.adherence}%`} sub="days within ±15% of calorie target" />
          <Stat icon={ChefHat} label="Cooking frequency" value={`${w.cookedMeals}`} sub="home-cooked meals logged" />
          <Stat icon={Flame} label="Logging streak" value={`${w.streak} day${w.streak === 1 ? "" : "s"}`} sub="in a row" />
        </div>
      </section>

      <section aria-labelledby="chart-h" className="rounded-3xl bg-card p-5 shadow-soft">
        <h2 id="chart-h" className="text-lg font-semibold">Calories by day</h2>
        <div className="mt-4 overflow-x-auto">
          <svg viewBox={`0 0 ${W} ${H + 28}`} className="mx-auto h-52 w-full max-w-xl" role="img" aria-label="Bar chart of daily calories compared to your target">
            <line x1="0" x2={W} y1={y(w.targets.calories)} y2={y(w.targets.calories)} className="stroke-muted-foreground" strokeDasharray="4 4" strokeWidth="1" />
            <text x={W} y={y(w.targets.calories) - 4} textAnchor="end" className="fill-muted-foreground" fontSize="9">target</text>
            {w.days.map((d, i) => {
              const x = i * (bar + gap) + gap / 2, h = (d.totals.calories / max) * H;
              return (
                <g key={d.date}>
                  <rect x={x} y={H - h} width={bar} height={Math.max(h, d.logged ? 2 : 0)} rx="8" className={d.totals.calories > w.targets.calories * 1.15 ? "fill-accent" : "fill-primary"} opacity={d.logged ? 1 : 0.15} />
                  {d.logged && <text x={x + bar / 2} y={H - h - 5} textAnchor="middle" fontSize="9" className="fill-foreground">{d.totals.calories}</text>}
                  <text x={x + bar / 2} y={H + 16} textAnchor="middle" fontSize="10" className="fill-muted-foreground">{new Date(`${d.date}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })}</text>
                </g>
              );
            })}
          </svg>
        </div>
        <table className="sr-only"><caption>Calories by day</caption><tbody>{w.days.map((d) => <tr key={d.date}><th>{d.date}</th><td>{d.totals.calories} kcal</td></tr>)}</tbody></table>
      </section>

      <section aria-labelledby="adv-h" className="rounded-3xl bg-card p-5 shadow-soft">
        <h2 id="adv-h" className="flex items-center gap-2 text-lg font-semibold">Advanced insights {plan !== "pro" && <Lock className="h-4 w-4 text-muted-foreground" aria-label="Pro feature" />}</h2>
        {plan === "pro" ? (
          <div className="mt-4 space-y-4">
            <p className="text-sm text-muted-foreground">Where your calories come from, on days you logged.</p>
            {[["Protein", (w.averages.protein * 4) / macroCal, "bg-protein"], ["Carbs", (w.averages.carbs * 4) / macroCal, "bg-carbs"], ["Fat", (w.averages.fat * 9) / macroCal, "bg-fat"]].map(([l, v, c]) => (
              <div key={l as string}><div className="mb-1 flex justify-between text-sm"><span>{l as string}</span><span className="font-semibold">{Math.round((v as number) * 100)}%</span></div><div className="h-2.5 overflow-hidden rounded-full bg-muted"><div className={`h-full rounded-full ${c}`} style={{ width: `${(v as number) * 100}%` }} /></div></div>
            ))}
            <p className="text-sm text-muted-foreground">Protein target hit on {w.days.filter((d) => d.logged && d.totals.protein >= w.targets.proteinG * 0.9).length} of {w.daysLogged} logged days.</p>
          </div>
        ) : (
          <div className="mt-3 text-sm text-muted-foreground"><p>See your macro split and how often you hit your protein target.</p><Button asChild size="sm" className="mt-3"><Link href="/subscription">Explore Thyme Pro</Link></Button></div>
        )}
      </section>
      <p className="text-xs text-muted-foreground">Nutrition figures are estimates to help you plan. They're not medical advice — talk to a professional about your health needs.</p>
    </div>
  );
}
