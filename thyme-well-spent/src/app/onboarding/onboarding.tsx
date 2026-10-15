"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, Check } from "lucide-react";
import { create } from "zustand";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Field, Input, Select } from "@/components/ui/input";
import { Stepper } from "@/components/ui/stepper";
import { TagInput } from "@/components/ui/tag-input";
import { Logo } from "@/components/app/logo";
import { api, ApiError } from "@/lib/client";
import { DIET_OPTIONS } from "@/lib/diet";
import { defaultCurrencyForLocale, CURRENCIES } from "@/lib/currency";
import { ACTIVITY, COOK_TIMES, CUISINE_OPTIONS, GOALS, LOVED_INGREDIENTS, MEAL_OPTIONS } from "@/lib/options";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type S = {
  goals: string[]; diet: string; allergies: string[]; intolerances: string[]; avoid: string[]; dislikes: string[]; cuisines: string[]; lovedIngredients: string[];
  maxCookMinutes: number; householdSize: number; mealTypes: string[]; mode: "auto" | "custom"; sex: string; age: string; height: string; weight: string; activity: string; units: "metric" | "imperial";
  calories: string; protein: string; carbs: string; fat: string; currency: string;
  set: (p: Partial<S>) => void;
};
const useOnb = create<S>((set) => ({
  goals: [], diet: "everything", allergies: [], intolerances: [], avoid: [], dislikes: [], cuisines: [], lovedIngredients: [], maxCookMinutes: 30, householdSize: 1, mealTypes: ["breakfast", "lunch", "dinner"],
  mode: "auto", sex: "", age: "", height: "", weight: "", activity: "moderate", units: "metric", calories: "2000", protein: "", carbs: "", fat: "", currency: "INR", set: (p) => set(p),
}));

const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

function Option({ active, onClick, children, sub }: { active: boolean; onClick: () => void; children: React.ReactNode; sub?: string }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} className={cn("tap flex min-h-14 w-full items-center justify-between gap-3 rounded-2xl border-2 px-4 py-3 text-left text-[16px] font-medium transition-all active:scale-[0.99]", active ? "border-primary bg-primary/10" : "border-border bg-card hover:bg-muted")}>
      <span>{children}{sub && <span className="block text-sm font-normal text-muted-foreground">{sub}</span>}</span>
      <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors", active ? "border-primary bg-primary text-primary-foreground" : "border-border")}>{active && <Check className="h-3.5 w-3.5" strokeWidth={3} />}</span>
    </button>
  );
}

const STEPS = ["goals", "diet", "avoid", "love", "time", "people", "meals", "nutrition", "ready"] as const;
type Step = (typeof STEPS)[number];

export function Onboarding({ name }: { name: string }) {
  const router = useRouter();
  const s = useOnb();
  const [i, setI] = useState(0);
  const [dir, setDir] = useState(1);
  const [busy, setBusy] = useState(false);
  const [targets, setTargets] = useState<{ calories: number; proteinG: number; carbsG: number; fatG: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const step: Step = STEPS[i];

  useEffect(() => { s.set({ currency: defaultCurrencyForLocale(navigator.language) }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const metric = () => ({
    heightCm: s.height ? (s.units === "metric" ? Number(s.height) : Math.round(Number(s.height) * 2.54)) : undefined,
    weightKg: s.weight ? (s.units === "metric" ? Number(s.weight) : Math.round(Number(s.weight) * 0.4536 * 10) / 10) : undefined,
    age: s.age ? Number(s.age) : undefined, sex: s.sex || undefined,
  });

  // Fetch the estimate for the final screen
  useEffect(() => {
    if (step !== "ready") return;
    if (s.mode === "custom") { const cal = Number(s.calories) || 2000; setTargets({ calories: cal, proteinG: Number(s.protein) || Math.round((cal * 0.25) / 4), carbsG: Number(s.carbs) || Math.round((cal * 0.45) / 4), fatG: Number(s.fat) || Math.round((cal * 0.3) / 9) }); return; }
    const m = metric();
    const q = new URLSearchParams({ diet: s.diet, activityLevel: s.activity });
    s.goals.forEach((g) => q.append("goal", g));
    if (m.sex) q.set("sex", m.sex); if (m.age) q.set("age", String(m.age)); if (m.heightCm) q.set("heightCm", String(m.heightCm)); if (m.weightKg) q.set("weightKg", String(m.weightKg));
    api<{ calories: number; proteinG: number; carbsG: number; fatG: number }>(`/api/onboarding?${q}`).then(setTargets).catch(() => setError("Couldn't calculate your estimate."));
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (d: number) => { setDir(d); setI((x) => Math.min(Math.max(x + d, 0), STEPS.length - 1)); };
  const canNext = step === "goals" ? s.goals.length > 0 : step === "meals" ? s.mealTypes.length > 0 : step === "nutrition" ? (s.mode === "custom" ? Number(s.calories) >= 1000 : true) : true;

  async function finish() {
    setBusy(true); setError(null);
    const m = metric();
    try {
      await api("/api/onboarding", { body: {
        goals: s.goals, diet: s.diet, allergies: s.allergies, intolerances: s.intolerances, avoid: s.avoid, dislikes: s.dislikes, cuisines: s.cuisines, lovedIngredients: s.lovedIngredients,
        maxCookMinutes: s.maxCookMinutes, householdSize: s.householdSize, mealTypes: s.mealTypes, nutritionMode: s.mode, ...m, activityLevel: s.activity, units: s.units, currency: s.currency,
        ...(s.mode === "custom" && targets ? { calories: targets.calories, proteinG: targets.proteinG, carbsG: targets.carbsG, fatG: targets.fatG } : {}),
      } });
      try {
        await api("/api/meal-plan/generate", { body: { days: 7, mealsPerDay: Math.min(Math.max(s.mealTypes.length, 2), 4) } });
        toast.success("Your meal plan is ready");
        router.replace("/plan?review=1");
      } catch (e) {
        toast.error(e instanceof ApiError ? e.message : "We saved your profile but couldn't build a plan yet.");
        router.replace("/");
      }
      router.refresh();
    } catch (e) { setError(e instanceof ApiError ? e.message : "Couldn't save your answers. Please try again."); setBusy(false); }
  }

  const Q = ({ title, sub }: { title: string; sub?: string }) => (<div className="mb-6"><h1 className="text-[30px] font-semibold leading-tight md:text-4xl">{title}</h1>{sub && <p className="mt-2 text-[16px] text-muted-foreground">{sub}</p>}</div>);

  return (
    <div className="mx-auto flex min-h-dvh max-w-xl flex-col px-5">
      <header className="flex items-center gap-3 pb-2 pt-5">
        <button onClick={() => go(-1)} disabled={i === 0 || busy} aria-label="Back" className="tap flex items-center justify-center rounded-full hover:bg-muted disabled:opacity-0"><ArrowLeft className="h-5 w-5" /></button>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={i + 1} aria-valuemax={STEPS.length} aria-label="Progress"><motion.div className="h-full rounded-full bg-primary" animate={{ width: `${((i + 1) / STEPS.length) * 100}%` }} transition={{ duration: 0.3 }} /></div>
        <Logo className="h-8 w-8" />
      </header>

      <main id="main" className="flex-1 overflow-x-hidden py-6">
        <AnimatePresence mode="wait" custom={dir} initial={false}>
          <motion.div key={step} custom={dir} initial={{ opacity: 0, x: 40 * dir }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -40 * dir }} transition={{ duration: 0.22 }}>
            {step === "goals" && <><Q title={`Hi ${name}! What are your goals?`} sub="Pick everything that fits — we'll shape your plan around it." />
              <div className="grid gap-2.5 sm:grid-cols-2">{GOALS.map((g) => <Option key={g.value} active={s.goals.includes(g.value)} onClick={() => s.set({ goals: toggle(s.goals, g.value) })}><span aria-hidden>{g.emoji}</span> {g.label}</Option>)}</div></>}

            {step === "diet" && <><Q title="What's your diet?" sub="Eggetarian means vegetarian plus eggs." />
              <div className="grid gap-2.5 sm:grid-cols-2">{DIET_OPTIONS.map((d) => <Option key={d.value} active={s.diet === d.value} onClick={() => s.set({ diet: d.value })}>{d.label}</Option>)}</div></>}

            {step === "avoid" && <><Q title="Anything you don't eat?" sub="Type anything — we'll keep it out of every plan and recipe suggestion." />
              <div className="space-y-5">
                <Field label="Allergies"><TagInput label="Allergies" value={s.allergies} onChange={(v) => s.set({ allergies: v })} placeholder="e.g. peanuts, shellfish" suggestions={["peanuts", "shellfish", "dairy", "eggs", "gluten", "soy"]} /></Field>
                <Field label="Intolerances"><TagInput label="Intolerances" value={s.intolerances} onChange={(v) => s.set({ intolerances: v })} placeholder="e.g. lactose" /></Field>
                <Field label="Foods you avoid"><TagInput label="Foods to avoid" value={s.avoid} onChange={(v) => s.set({ avoid: v })} placeholder="e.g. coconut, pork" /></Field>
                <Field label="Ingredients you dislike"><TagInput label="Dislikes" value={s.dislikes} onChange={(v) => s.set({ dislikes: v })} placeholder="e.g. mushrooms" /></Field>
              </div></>}

            {step === "love" && <><Q title="What foods do you love?" sub="We'll lean into these. Skip anything you're unsure about." />
              <p className="mb-2 text-sm font-semibold">Cuisines</p><div className="flex flex-wrap gap-2">{CUISINE_OPTIONS.map((c) => <Chip key={c.value} active={s.cuisines.includes(c.value)} onClick={() => s.set({ cuisines: toggle(s.cuisines, c.value) })} className="px-4 py-2.5 text-[15px]"><span aria-hidden>{c.emoji}</span>{c.value}</Chip>)}</div>
              <p className="mb-2 mt-6 text-sm font-semibold">Ingredients</p><div className="flex flex-wrap gap-2">{LOVED_INGREDIENTS.map((c) => <Chip key={c} active={s.lovedIngredients.includes(c)} onClick={() => s.set({ lovedIngredients: toggle(s.lovedIngredients, c) })}>{c}</Chip>)}</div></>}

            {step === "time" && <><Q title="How much time do you usually have?" sub="We'll keep recipes within your usual cooking time." />
              <div className="space-y-2.5">{COOK_TIMES.map((t) => <Option key={t.value} active={s.maxCookMinutes === t.value} onClick={() => s.set({ maxCookMinutes: t.value })}>{t.label}</Option>)}</div></>}

            {step === "people" && <><Q title="How many people are you cooking for?" sub="Quantities and grocery lists scale to your household." />
              <div className="flex flex-wrap gap-3">{[1, 2, 3, 4].map((n) => <button key={n} onClick={() => s.set({ householdSize: n })} aria-pressed={s.householdSize === n} className={cn("tap flex h-20 w-20 items-center justify-center rounded-3xl border-2 font-display text-3xl font-semibold transition-all", s.householdSize === n ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card")}>{n}</button>)}
                <button onClick={() => s.set({ householdSize: Math.max(5, s.householdSize) })} aria-pressed={s.householdSize >= 5} className={cn("tap flex h-20 w-20 items-center justify-center rounded-3xl border-2 font-display text-3xl font-semibold transition-all", s.householdSize >= 5 ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card")}>5+</button></div>
              {s.householdSize >= 5 && <div className="mt-5 flex items-center gap-4"><p className="text-sm text-muted-foreground">Exactly how many?</p><Stepper value={s.householdSize} onChange={(v) => s.set({ householdSize: v })} min={5} max={12} label="people" /></div>}</>}

            {step === "meals" && <><Q title="How many meals do you usually eat?" sub="Choose the ones you'd like planned. You can change this any time." />
              <div className="space-y-2.5">{MEAL_OPTIONS.map((m) => <Option key={m.value} active={s.mealTypes.includes(m.value)} onClick={() => s.set({ mealTypes: toggle(s.mealTypes, m.value) })}>{m.label}</Option>)}</div></>}

            {step === "nutrition" && <><Q title="Your nutrition goal" sub="We'll estimate daily targets for you, or you can set your own." />
              <div className="mb-5 space-y-2.5"><Option active={s.mode === "auto"} onClick={() => s.set({ mode: "auto" })} sub="Based on a few details below">Calculate automatically</Option><Option active={s.mode === "custom"} onClick={() => s.set({ mode: "custom" })}>I'll set my own calorie target</Option></div>
              {s.mode === "auto" ? (
                <div className="space-y-4">
                  <div className="flex gap-2">{(["metric", "imperial"] as const).map((u) => <Chip key={u} active={s.units === u} onClick={() => s.set({ units: u, height: "", weight: "" })}>{u === "metric" ? "Metric (cm, kg)" : "Imperial (in, lb)"}</Chip>)}</div>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Sex" htmlFor="o-sex"><Select id="o-sex" value={s.sex} onChange={(e) => s.set({ sex: e.target.value })}><option value="">Prefer not to say</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option></Select></Field>
                    <Field label="Age" htmlFor="o-age"><Input id="o-age" type="number" inputMode="numeric" min={14} max={100} value={s.age} onChange={(e) => s.set({ age: e.target.value })} /></Field>
                    <Field label={s.units === "metric" ? "Height (cm)" : "Height (in)"} htmlFor="o-h"><Input id="o-h" type="number" inputMode="decimal" value={s.height} onChange={(e) => s.set({ height: e.target.value })} /></Field>
                    <Field label={s.units === "metric" ? "Weight (kg)" : "Weight (lb)"} htmlFor="o-w"><Input id="o-w" type="number" inputMode="decimal" value={s.weight} onChange={(e) => s.set({ weight: e.target.value })} /></Field>
                  </div>
                  <Field label="How active are you?" htmlFor="o-act"><Select id="o-act" value={s.activity} onChange={(e) => s.set({ activity: e.target.value })}>{ACTIVITY.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}</Select></Field>
                  <p className="text-sm text-muted-foreground">This gives an <strong>estimate</strong> for planning — it isn't medical advice. Skip any field and we'll use typical values.</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Calories per day" htmlFor="o-cal"><Input id="o-cal" type="number" inputMode="numeric" value={s.calories} onChange={(e) => s.set({ calories: e.target.value })} /></Field>
                  <Field label="Protein (g)" htmlFor="o-p"><Input id="o-p" type="number" inputMode="numeric" placeholder="auto" value={s.protein} onChange={(e) => s.set({ protein: e.target.value })} /></Field>
                  <Field label="Carbs (g)" htmlFor="o-c"><Input id="o-c" type="number" inputMode="numeric" placeholder="auto" value={s.carbs} onChange={(e) => s.set({ carbs: e.target.value })} /></Field>
                  <Field label="Fat (g)" htmlFor="o-f"><Input id="o-f" type="number" inputMode="numeric" placeholder="auto" value={s.fat} onChange={(e) => s.set({ fat: e.target.value })} /></Field>
                </div>
              )}
              <div className="mt-5"><Field label="Currency for grocery budgets" htmlFor="o-cur"><Select id="o-cur" value={s.currency} onChange={(e) => s.set({ currency: e.target.value })}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</Select></Field></div></>}

            {step === "ready" && <>
              <div className="mb-6 text-center"><div className="text-5xl" aria-hidden>🌿</div><h1 className="mt-3 text-[32px] font-semibold leading-tight">Your plan is ready.</h1><p className="mt-2 text-muted-foreground">Here's your personalised daily target{s.mode === "auto" ? " (an estimate)" : ""}.</p></div>
              {targets ? (
                <div className="rounded-3xl bg-card p-6 text-center shadow-lift">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Your daily target</p>
                  <p className="mt-1 font-display text-5xl font-semibold tabular-nums">{targets.calories.toLocaleString()} <span className="text-xl font-normal text-muted-foreground">kcal/day</span></p>
                  <div className="mt-5 grid grid-cols-3 gap-3">{[["Protein", targets.proteinG, "text-protein"], ["Carbs", targets.carbsG, "text-carbs"], ["Fat", targets.fatG, "text-fat"]].map(([l, v, c]) => <div key={l as string} className="rounded-2xl bg-muted py-3"><p className={cn("text-2xl font-semibold tabular-nums", c as string)}>{v}g</p><p className="text-xs text-muted-foreground">{l}</p></div>)}</div>
                  <p className="mt-4 text-xs text-muted-foreground">Estimates for planning only, not medical advice. You can fine-tune them in your profile.</p>
                </div>
              ) : error ? null : <div className="h-52 animate-pulse rounded-3xl bg-muted" aria-busy />}
              {error && <p role="alert" className="mt-4 rounded-2xl bg-danger/10 px-4 py-3 text-sm text-danger">{error}</p>}
            </>}
          </motion.div>
        </AnimatePresence>
      </main>

      <footer className="sticky bottom-0 -mx-5 border-t border-border bg-background/90 px-5 pb-safe pt-3 backdrop-blur">
        {step === "ready" ? <Button size="lg" className="w-full" onClick={finish} loading={busy} disabled={!targets}>{busy ? "Building your week…" : error && targets ? "Try again" : "Create My Meal Plan"}</Button>
          : <Button size="lg" className="w-full" onClick={() => go(1)} disabled={!canNext}>Continue</Button>}
        {step === "avoid" || step === "love" ? <button onClick={() => go(1)} className="mt-1 block w-full py-2.5 text-center text-sm text-muted-foreground">Skip for now</button> : <div className="h-2" />}
      </footer>
    </div>
  );
}
