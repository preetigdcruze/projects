import Link from "next/link";
import { Camera, Plus, Sparkles, TrendingUp, Leaf } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";
import { DayProgress } from "@/components/app/day-progress";
import { Greeting } from "@/components/app/greeting";
import { MealCard } from "@/components/app/meal-card";
import { Rail } from "@/components/app/rail";
import { formatLong, today } from "@/lib/dates";
import { requireUserId } from "@/lib/session";
import { getUserContext } from "@/server/services/context";
import { getDayItems } from "@/server/services/meal-plan";
import { daySummary } from "@/server/services/nutrition";
import { useSoon } from "@/server/services/pantry";
import { homeSections } from "@/server/services/recommendations";
import { getPlan } from "@/server/services/subscription";
import { GenerateButton } from "@/components/app/generate-sheet";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const userId = await requireUserId();
  const d = today();
  const [ctx, items, summary, sections, plan] = await Promise.all([getUserContext(userId), getDayItems(userId, d), daySummary(userId, d), homeSections(userId), getPlan(userId)]);
  const soon = plan === "pro" ? await useSoon(userId, 3, 3) : [];
  const extraFoods = summary.foods;

  return (
    <div className="space-y-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <Greeting name={ctx.name.split(" ")[0]} />
          <p className="mt-1 text-muted-foreground"><span className="font-semibold text-foreground">Today</span> · {formatLong(d)}</p>
        </div>
        <Button asChild variant="secondary" size="sm" className="shrink-0"><Link href="/assistant"><Sparkles className="h-4 w-4" />Ask Thyme</Link></Button>
      </header>

      <DayProgress consumed={summary.consumed} targets={summary.targets} />

      <section aria-labelledby="today-meals" className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 id="today-meals" className="text-xl font-semibold">Today's meals</h2>
          <div className="flex gap-2">
            <Button asChild variant="outline" size="sm"><Link href="/log"><Plus className="h-4 w-4" />Add food</Link></Button>
            <Button asChild variant="outline" size="sm" aria-label="Scan your food"><Link href="/log?tab=scan"><Camera className="h-4 w-4" /><span className="hidden sm:inline">Scan</span></Link></Button>
          </div>
        </div>
        {items.length === 0 ? (
          <EmptyState emoji="🥗" title="No meals planned yet." body="Give yourself a head start — we'll plan meals around your goals, tastes and time." action={<GenerateButton label="Generate my week" />} />
        ) : (
          <div className="space-y-3">{items.map((i) => <MealCard key={i.id} item={i} />)}</div>
        )}
        {extraFoods.length > 0 && (
          <div className="rounded-3xl bg-card p-4 shadow-soft">
            <h3 className="text-sm font-semibold text-muted-foreground">Also logged today</h3>
            <ul className="mt-2 divide-y divide-border">{extraFoods.map((f) => <li key={f.id} className="flex justify-between py-2 text-[15px]"><span>{f.name} <span className="text-muted-foreground">· {f.mealType}</span></span><span className="tabular-nums text-muted-foreground">{f.calories} kcal</span></li>)}</ul>
          </div>
        )}
      </section>

      {soon.length > 0 && (
        <section aria-label="Use soon" className="rounded-3xl bg-accent/10 p-5">
          <h2 className="flex items-center gap-2 text-lg font-semibold"><Leaf className="h-5 w-5 text-accent" aria-hidden />Use soon</h2>
          {soon.map((g) => (
            <p key={g.item.id} className="mt-2 text-[15px]">
              You have <strong>{g.item.name.toLowerCase()}</strong> {g.item.daysLeft <= 0 ? "expiring today" : `expiring in ${g.item.daysLeft} day${g.item.daysLeft === 1 ? "" : "s"}`}.{" "}
              {g.meals[0] && <>Try <Link className="font-semibold text-primary underline-offset-2 hover:underline" href={`/recipes/${g.meals[0].id}`}>{g.meals[0].title}</Link>{g.meals.length > 1 ? ` or ${g.meals.length - 1} more` : ""}.</>}
            </p>
          ))}
          <Button asChild variant="outline" size="sm" className="mt-3"><Link href="/pantry">See pantry</Link></Button>
        </section>
      )}

      <Link href="/progress" className="flex items-center justify-between rounded-3xl bg-card p-5 shadow-soft transition-shadow hover:shadow-lift">
        <div className="flex items-center gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-full bg-secondary text-secondary-foreground"><TrendingUp className="h-5 w-5" /></span><div><p className="font-semibold">How's your week going?</p><p className="text-sm text-muted-foreground">See your averages and consistency</p></div></div>
        <span aria-hidden className="text-muted-foreground">→</span>
      </Link>

      {sections.map((s) => <Rail key={s.id} section={s} />)}
    </div>
  );
}
