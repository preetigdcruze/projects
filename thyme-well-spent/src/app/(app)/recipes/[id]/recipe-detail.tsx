"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, CalendarPlus, ChefHat, ChevronLeft, ChevronRight, Clock, ExternalLink, ShoppingBasket, Star, Trash2, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip, Tag } from "@/components/ui/chip";
import { FoodImage } from "@/components/ui/food-image";
import { HeartButton } from "@/components/ui/heart-button";
import { Select } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { Stepper } from "@/components/ui/stepper";
import { LogMealSheet } from "@/components/app/log-meal-sheet";
import { api, fail } from "@/lib/client";
import { scaleIngredients } from "@/lib/scale";
import { DIET_LABEL } from "@/lib/diet";
import { addDays, iso, MEAL_LABEL, MEAL_ORDER, today as todayFn } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type Recipe = { id: string; title: string; description: string; image: string | null; cuisine: string; dietType: string; mealTypes: string[]; prepTime: number; cookTime: number; totalTime: number; servings: number; difficulty: string; rating: number; ratingCount: number; tags: string[]; calories: number; protein: number; carbs: number; fat: number; fiber: number; sourceUrl: string | null };
type Ing = { id: string; name: string; quantity: number; unit: string; optional: boolean; note: string | null };

export function RecipeDetail({ recipe: r, ingredients, steps, isFavorite, isMine, householdSize }: { recipe: Recipe; ingredients: Ing[]; steps: string[]; isFavorite: boolean; isMine: boolean; householdSize: number }) {
  const router = useRouter();
  const [servings, setServings] = useState(r.servings);
  const [planOpen, setPlanOpen] = useState(false);
  const [cook, setCook] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const scaled = scaleIngredients(ingredients, r.servings, servings);
  const f = servings / r.servings;
  const total = (n: number) => Math.round(n * servings);

  async function addToGrocery() {
    setBusy(true);
    try {
      const res = await api<{ added: number; skippedInPantry: number }>("/api/grocery/add-recipe", { body: { recipeId: r.id, servings } });
      toast.success(`Added ${res.added} ingredient${res.added === 1 ? "" : "s"} to your grocery list${res.skippedInPantry ? ` · ${res.skippedInPantry} already in your pantry` : ""}`, { action: { label: "View list", onClick: () => router.push("/grocery") } });
    } catch (e) { fail(e); } finally { setBusy(false); }
  }
  async function remove() {
    if (!confirm("Delete this recipe? This can't be undone.")) return;
    try { await api(`/api/recipes/${r.id}`, { method: "DELETE" }); toast("Recipe deleted"); router.replace("/recipes?collection=mine"); router.refresh(); } catch (e) { fail(e); }
  }

  return (
    <article className="-mx-4 -mt-5 md:mx-0 md:mt-0">
      <div className="relative">
        <FoodImage title={r.title} cuisine={r.cuisine} image={r.image} className="aspect-[4/3] w-full md:aspect-[21/9] md:rounded-3xl" emojiClass="text-[110px] md:text-[130px]" sizes="(max-width: 1024px) 100vw, 960px" priority />
        <Link href="/recipes" aria-label="Back to recipes" className="absolute left-4 top-4 flex h-11 w-11 items-center justify-center rounded-full bg-card/90 shadow-soft backdrop-blur"><ArrowLeft className="h-5 w-5" /></Link>
        <HeartButton recipeId={r.id} initial={isFavorite} className="absolute right-4 top-4 h-11 w-11" />
      </div>

      <div className="relative -mt-6 space-y-7 rounded-t-3xl bg-background px-4 pt-6 md:mt-6 md:rounded-none md:px-0 md:pt-0">
        <header className="space-y-3">
          <div className="flex flex-wrap gap-1.5"><Tag>{r.cuisine}</Tag><Tag>{DIET_LABEL[r.dietType] ?? r.dietType}</Tag>{r.mealTypes.map((m) => <Tag key={m}>{MEAL_LABEL[m] ?? m}</Tag>)}{r.tags.filter((t) => !["vegan", "vegetarian"].includes(t)).slice(0, 3).map((t) => <Tag key={t}>{t.replace(/-/g, " ")}</Tag>)}</div>
          <h1 className="text-3xl font-semibold leading-tight md:text-4xl">{r.title}</h1>
          {r.description && <p className="text-[17px] text-muted-foreground">{r.description}</p>}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            {r.ratingCount > 0 && <span className="inline-flex items-center gap-1 font-semibold"><Star className="h-4 w-4 fill-carbs stroke-carbs" aria-hidden />{r.rating.toFixed(1)} <span className="font-normal text-muted-foreground">({r.ratingCount})</span></span>}
            <span className="inline-flex items-center gap-1.5"><Clock className="h-4 w-4 text-muted-foreground" aria-hidden />Prep {r.prepTime}m · Cook {r.cookTime}m · <strong>{r.totalTime} min total</strong></span>
            <span className="capitalize text-muted-foreground">{r.difficulty}</span>
          </div>
        </header>

        <div className="flex flex-wrap gap-2.5">
          <Button size="lg" onClick={() => setPlanOpen(true)}><CalendarPlus className="h-5 w-5" />Add to plan</Button>
          <Button size="lg" variant="accent" onClick={() => setCook(true)}><ChefHat className="h-5 w-5" />Cook now</Button>
          <Button size="lg" variant="outline" onClick={addToGrocery} loading={busy}><ShoppingBasket className="h-5 w-5" />Add ingredients to grocery list</Button>
        </div>

        <section aria-labelledby="nutrition" className="rounded-3xl bg-card p-5 shadow-soft">
          <h2 id="nutrition" className="text-lg font-semibold">Nutrition <span className="text-sm font-normal text-muted-foreground">per serving</span></h2>
          <dl className="mt-3 grid grid-cols-4 gap-2 text-center">
            {[["Calories", r.calories, "kcal"], ["Protein", Math.round(r.protein), "g"], ["Carbs", Math.round(r.carbs), "g"], ["Fat", Math.round(r.fat), "g"]].map(([l, v, u]) => <div key={l as string} className="rounded-2xl bg-muted p-3"><dd className="text-xl font-semibold tabular-nums">{v}<span className="text-xs font-normal text-muted-foreground"> {u}</span></dd><dt className="text-xs text-muted-foreground">{l}</dt></div>)}
          </dl>
          <p className="mt-3 text-sm text-muted-foreground" aria-live="polite">All {servings} servings: {total(r.calories).toLocaleString()} kcal · {total(r.protein)}g protein · {total(r.carbs)}g carbs · {total(r.fat)}g fat. Estimates only.</p>
        </section>

        <div className="grid gap-7 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:gap-10">
          <section aria-labelledby="ingredients">
            <div className="flex items-center justify-between gap-3">
              <h2 id="ingredients" className="text-xl font-semibold">Ingredients</h2>
              <div className="flex items-center gap-2"><Users className="h-4 w-4 text-muted-foreground" aria-hidden /><Stepper value={servings} onChange={setServings} min={1} max={50} label="servings" /></div>
            </div>
            {servings !== r.servings && <p className="mt-2 text-xs text-muted-foreground">Scaled from {r.servings} servings{householdSize !== servings ? ` · you cook for ${householdSize}` : ""}. <button className="font-semibold text-primary underline" onClick={() => setServings(r.servings)}>Reset</button></p>}
            <ul className="mt-3 divide-y divide-border rounded-3xl bg-card px-4 shadow-soft">
              {scaled.map((i) => (
                <li key={i.id} className="flex items-baseline justify-between gap-4 py-3 text-[15px]">
                  <span className="capitalize">{i.name}{i.optional && <span className="text-muted-foreground"> (optional)</span>}{i.note && <span className="text-muted-foreground">, {i.note}</span>}</span>
                  <motion.span key={`${servings}-${i.id}`} initial={{ opacity: 0.3 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }} className="shrink-0 font-semibold tabular-nums">{i.display}</motion.span>
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="instructions">
            <h2 id="instructions" className="text-xl font-semibold">Instructions</h2>
            <ol className="mt-3 space-y-4">
              {steps.map((s, i) => <li key={i} className="flex gap-4"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">{i + 1}</span><p className="pt-1 text-[16px] leading-relaxed">{s}</p></li>)}
            </ol>
            {r.sourceUrl && <a href={r.sourceUrl} target="_blank" rel="noopener noreferrer nofollow" className="mt-5 inline-flex items-center gap-1.5 text-sm text-muted-foreground underline"><ExternalLink className="h-3.5 w-3.5" />Original source</a>}
          </section>
        </div>

        {isMine && <Button variant="ghost" className="text-danger" onClick={remove}><Trash2 className="h-4 w-4" />Delete this recipe</Button>}
      </div>

      {planOpen && <PlanSheet recipeId={r.id} title={r.title} defaultMeal={r.mealTypes.find((m) => MEAL_ORDER.includes(m as never)) ?? "dinner"} servings={servings} onClose={() => setPlanOpen(false)} />}
      {cook && <CookMode title={r.title} steps={steps} onClose={() => setCook(false)} onFinish={() => { setCook(false); setLogOpen(true); }} />}
      {logOpen && <LogMealSheet open onOpenChange={setLogOpen} target={{ recipeId: r.id, title: r.title, mealType: r.mealTypes.find((m) => MEAL_ORDER.includes(m as never)) ?? "dinner", calories: r.calories, protein: r.protein, carbs: r.carbs, fat: r.fat, defaultQty: 1, canLeftover: r.servings > 1 }} />}
      <span className="hidden">{f}</span>
    </article>
  );
}

function PlanSheet({ recipeId, title, defaultMeal, servings, onClose }: { recipeId: string; title: string; defaultMeal: string; servings: number; onClose: () => void }) {
  const router = useRouter();
  const base = todayFn();
  const days = Array.from({ length: 14 }, (_, i) => addDays(base, i));
  const [date, setDate] = useState(iso(base));
  const [meal, setMeal] = useState(defaultMeal);
  const [busy, setBusy] = useState(false);
  async function add() {
    setBusy(true);
    try { await api("/api/meal-plan/add", { body: { date, mealType: meal, recipeId, servings } }); toast.success(`Added to your plan`, { action: { label: "View plan", onClick: () => router.push(`/plan?week=${date}`) } }); router.refresh(); onClose(); } catch (e) { fail(e); } finally { setBusy(false); }
  }
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title="Add to plan" description={title}>
      <div className="space-y-4 pb-4">
        <Select value={date} onChange={(e) => setDate(e.target.value)} aria-label="Day">{days.map((d, i) => <option key={iso(d)} value={iso(d)}>{i === 0 ? "Today" : i === 1 ? "Tomorrow" : ""}{i < 2 ? " · " : ""}{d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" })}</option>)}</Select>
        <div className="flex flex-wrap gap-2">{MEAL_ORDER.map((m) => <Chip key={m} active={meal === m} onClick={() => setMeal(m)}>{MEAL_LABEL[m]}</Chip>)}</div>
        <Button size="lg" className="w-full" onClick={add} loading={busy}>Add to plan</Button>
      </div>
    </Sheet>
  );
}

function CookMode({ title, steps, onClose, onFinish }: { title: string; steps: string[]; onClose: () => void; onFinish: () => void }) {
  const [i, setI] = useState(0);
  const last = i === steps.length - 1;
  return (
    <div role="dialog" aria-modal="true" aria-label={`Cooking ${title}`} className="fixed inset-0 z-[60] flex flex-col bg-background">
      <div className="flex items-center justify-between px-5 pt-5"><div><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Cooking</p><p className="font-display text-lg font-semibold">{title}</p></div><button onClick={onClose} aria-label="Exit cook mode" className="tap flex items-center justify-center rounded-full bg-muted"><X className="h-5 w-5" /></button></div>
      <div className="mx-5 mt-4 flex gap-1.5" aria-hidden>{steps.map((_, k) => <span key={k} className={cn("h-1.5 flex-1 rounded-full", k <= i ? "bg-primary" : "bg-muted")} />)}</div>
      <div className="flex flex-1 items-center px-6">
        <AnimatePresence mode="wait"><motion.div key={i} initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }} transition={{ duration: 0.2 }} className="mx-auto max-w-2xl">
          <p className="mb-3 text-sm font-semibold text-primary">Step {i + 1} of {steps.length}</p>
          <p className="font-display text-3xl font-medium leading-snug md:text-4xl" aria-live="polite">{steps[i]}</p>
        </motion.div></AnimatePresence>
      </div>
      <div className="flex gap-3 px-5 pb-safe pt-3">
        <Button variant="outline" size="lg" onClick={() => setI(Math.max(0, i - 1))} disabled={i === 0} aria-label="Previous step"><ChevronLeft className="h-5 w-5" /></Button>
        {last ? <Button size="lg" className="flex-1" onClick={onFinish}>Finished — log this meal</Button> : <Button size="lg" className="flex-1" onClick={() => setI(i + 1)}>Next step<ChevronRight className="h-5 w-5" /></Button>}
      </div>
    </div>
  );
}
