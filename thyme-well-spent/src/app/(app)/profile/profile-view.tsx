"use client";
import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Camera, ChevronRight, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Field, Input, Select } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { Stepper } from "@/components/ui/stepper";
import { TagInput } from "@/components/ui/tag-input";
import { applyTheme } from "@/components/ui/theme";
import { api, fail } from "@/lib/client";
import { DIET_OPTIONS } from "@/lib/diet";
import { ACTIVITY, COOK_TIMES, CUISINE_OPTIONS, GOALS, MEAL_OPTIONS } from "@/lib/options";
import { toast } from "sonner";

type Data = {
  name: string; email: string; image: string | null; goals: string[]; dietType: string; allergies: string[]; avoid: string[]; dislikes: string[]; cuisines: string[]; maxCookMinutes: number; householdSize: number; mealTypes: string[]; budget: string;
  sex: string | null; age: number | null; heightCm: number | null; weightKg: number | null; activityLevel: string; units: string; currency: string; theme: string; nutritionMode: string; targets: { calories: number; proteinG: number; carbsG: number; fatG: number };
};
type Section = "goals" | "diet" | "food" | "cuisines" | "cooking" | "nutrition" | "basics";

const label = (arr: readonly { value: string | number; label: string }[], v: string | number) => arr.find((x) => x.value === v)?.label ?? String(v);

async function resizeToDataUrl(file: File, size = 256): Promise<string> {
  const bmp = await createImageBitmap(file);
  const c = document.createElement("canvas"); c.width = c.height = size;
  const s = Math.min(bmp.width, bmp.height);
  c.getContext("2d")!.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, size, size);
  return c.toDataURL("image/jpeg", 0.82);
}

export function ProfileView({ data, plan }: { data: Data; plan: string }) {
  const router = useRouter();
  const [open, setOpen] = useState<Section | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const rows: { key: Section; title: string; value: string }[] = [
    { key: "goals", title: "Goals", value: data.goals.length ? data.goals.map((g) => GOALS.find((x) => x.value === g)?.label ?? g).join(", ") : "Not set" },
    { key: "diet", title: "Diet", value: label(DIET_OPTIONS, data.dietType) },
    { key: "food", title: "Allergies & foods to avoid", value: [...data.allergies.map((a) => `${a} (allergy)`), ...data.avoid, ...data.dislikes].join(", ") || "Nothing" },
    { key: "cuisines", title: "Favorite cuisines", value: data.cuisines.join(", ") || "Not set" },
    { key: "cooking", title: "Cooking time & household", value: `${label(COOK_TIMES, data.maxCookMinutes)} · cooking for ${data.householdSize}` },
    { key: "nutrition", title: "Nutrition targets", value: `${data.targets.calories.toLocaleString()} kcal · ${data.targets.proteinG}g protein · ${data.nutritionMode === "auto" ? "estimated" : "custom"}` },
    { key: "basics", title: "Units, currency & theme", value: `${data.units === "metric" ? "Metric" : "Imperial"} · ${data.currency} · ${data.theme}` },
  ];
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="flex items-center gap-4">
        <button onClick={() => file.current?.click()} className="relative h-20 w-20 shrink-0 overflow-hidden rounded-full bg-secondary" aria-label="Change profile photo">
          {data.image ? <img src={data.image} alt="" className="h-full w-full object-cover" /> : <span className="flex h-full w-full items-center justify-center font-display text-3xl font-semibold text-secondary-foreground">{data.name[0]?.toUpperCase()}</span>}
          <span className="absolute inset-x-0 bottom-0 flex justify-center bg-black/40 py-1 text-white"><Camera className="h-3.5 w-3.5" /></span>
        </button>
        <input ref={file} type="file" accept="image/*" className="sr-only" aria-label="Upload profile photo" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; try { await api("/api/profile", { method: "PATCH", body: { image: await resizeToDataUrl(f) } }); toast.success("Photo updated"); router.refresh(); } catch (err) { fail(err); } }} />
        <div className="min-w-0"><h1 className="truncate text-3xl font-semibold">{data.name}</h1><p className="truncate text-muted-foreground">{data.email}</p></div>
      </header>

      <ul className="divide-y divide-border overflow-hidden rounded-3xl bg-card shadow-soft">
        {rows.map((r) => (
          <li key={r.key}><button onClick={() => setOpen(r.key)} className="flex min-h-16 w-full items-center justify-between gap-4 px-5 py-3.5 text-left hover:bg-muted/50"><div className="min-w-0"><p className="font-semibold">{r.title}</p><p className="truncate text-sm capitalize-first text-muted-foreground">{r.value}</p></div><ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden /></button></li>
        ))}
      </ul>
      <ul className="divide-y divide-border overflow-hidden rounded-3xl bg-card shadow-soft">
        <li><Link href="/subscription" className="flex min-h-16 items-center justify-between px-5 py-3.5 hover:bg-muted/50"><div><p className="font-semibold">Subscription</p><p className="text-sm text-muted-foreground capitalize">{plan} plan</p></div><ChevronRight className="h-5 w-5 text-muted-foreground" aria-hidden /></Link></li>
        <li><Link href="/settings" className="flex min-h-16 items-center justify-between px-5 py-3.5 hover:bg-muted/50"><div className="flex items-center gap-3"><Settings className="h-5 w-5 text-muted-foreground" aria-hidden /><div><p className="font-semibold">Settings</p><p className="text-sm text-muted-foreground">Notifications, privacy, account</p></div></div><ChevronRight className="h-5 w-5 text-muted-foreground" aria-hidden /></Link></li>
      </ul>
      {open && <EditSheet section={open} data={data} onClose={() => setOpen(null)} />}
    </div>
  );
}

function EditSheet({ section, data, onClose }: { section: Section; data: Data; onClose: () => void }) {
  const router = useRouter();
  const [d, setD] = useState(data);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Data>(k: K, v: Data[K]) => setD((x) => ({ ...x, [k]: v }));
  const toggle = (k: "goals" | "cuisines" | "mealTypes", v: string) => set(k, d[k].includes(v) ? d[k].filter((x) => x !== v) : [...d[k], v]);
  const titles: Record<Section, string> = { goals: "Your goals", diet: "Your diet", food: "Allergies & foods to avoid", cuisines: "Favorite cuisines", cooking: "Cooking time & household", nutrition: "Nutrition targets", basics: "Units, currency & theme" };

  async function save() {
    setBusy(true);
    const body: Record<string, unknown> = {
      goals: section === "goals" ? d.goals : undefined, dietType: section === "diet" ? d.dietType : undefined,
      allergies: section === "food" ? d.allergies : undefined, avoid: section === "food" ? d.avoid : undefined, dislikes: section === "food" ? d.dislikes : undefined,
      cuisines: section === "cuisines" ? d.cuisines : undefined,
      ...(section === "cooking" ? { maxCookMinutes: d.maxCookMinutes, householdSize: d.householdSize, mealTypes: d.mealTypes, budget: d.budget } : {}),
      ...(section === "nutrition" ? { nutritionMode: d.nutritionMode, sex: d.sex ?? undefined, age: d.age ?? undefined, heightCm: d.heightCm ?? undefined, weightKg: d.weightKg ?? undefined, activityLevel: d.activityLevel, calories: d.targets.calories, proteinG: d.targets.proteinG, carbsG: d.targets.carbsG, fatG: d.targets.fatG } : {}),
      ...(section === "basics" ? { units: d.units, currency: d.currency, theme: d.theme } : {}),
      ...(section === "goals" && d.nutritionMode === "auto" ? { nutritionMode: "auto" } : {}),
      ...(section === "diet" && d.nutritionMode === "auto" ? { nutritionMode: "auto" } : {}),
    };
    try {
      await api("/api/profile", { method: "PATCH", body });
      if (section === "basics") applyTheme(d.theme);
      toast.success("Saved"); router.refresh(); onClose();
    } catch (e) { fail(e); } finally { setBusy(false); }
  }
  const num = (v: string) => (v === "" ? null : Number(v));

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={titles[section]}>
      <div className="space-y-5 pb-4">
        {section === "goals" && <div className="flex flex-wrap gap-2">{GOALS.map((g) => <Chip key={g.value} active={d.goals.includes(g.value)} onClick={() => toggle("goals", g.value)}>{g.emoji} {g.label}</Chip>)}</div>}
        {section === "diet" && <div className="flex flex-wrap gap-2">{DIET_OPTIONS.map((o) => <Chip key={o.value} active={d.dietType === o.value} onClick={() => set("dietType", o.value)}>{o.label}</Chip>)}</div>}
        {section === "food" && <>
          <Field label="Allergies"><TagInput label="Allergies" value={d.allergies} onChange={(v) => set("allergies", v)} placeholder="e.g. peanuts, shellfish" /></Field>
          <Field label="Foods to avoid (intolerances, beliefs)"><TagInput label="Foods to avoid" value={d.avoid} onChange={(v) => set("avoid", v)} placeholder="e.g. coconut, gluten" /></Field>
          <Field label="Ingredients you dislike"><TagInput label="Dislikes" value={d.dislikes} onChange={(v) => set("dislikes", v)} placeholder="e.g. mushrooms" /></Field>
        </>}
        {section === "cuisines" && <div className="flex flex-wrap gap-2">{CUISINE_OPTIONS.map((c) => <Chip key={c.value} active={d.cuisines.includes(c.value)} onClick={() => toggle("cuisines", c.value)}>{c.emoji} {c.value}</Chip>)}</div>}
        {section === "cooking" && <>
          <div><p className="mb-2 text-sm font-semibold">Usual time to cook</p><div className="flex flex-wrap gap-2">{COOK_TIMES.map((t) => <Chip key={t.value} active={d.maxCookMinutes === t.value} onClick={() => set("maxCookMinutes", t.value)}>{t.label}</Chip>)}</div></div>
          <div className="flex items-center justify-between"><p className="text-sm font-semibold">People you cook for</p><Stepper value={d.householdSize} onChange={(v) => set("householdSize", v)} min={1} max={12} label="people" /></div>
          <div><p className="mb-2 text-sm font-semibold">Meals you eat</p><div className="flex flex-wrap gap-2">{MEAL_OPTIONS.map((m) => <Chip key={m.value} active={d.mealTypes.includes(m.value)} onClick={() => d.mealTypes.includes(m.value) && d.mealTypes.length === 1 ? undefined : toggle("mealTypes", m.value)}>{m.label}</Chip>)}</div></div>
          <div><p className="mb-2 text-sm font-semibold">Budget</p><div className="flex gap-2">{["low", "medium", "flexible"].map((b) => <Chip key={b} active={d.budget === b} onClick={() => set("budget", b)}>{b[0].toUpperCase() + b.slice(1)}</Chip>)}</div></div>
        </>}
        {section === "nutrition" && <>
          <div className="flex gap-2"><Chip active={d.nutritionMode === "auto"} onClick={() => set("nutritionMode", "auto")}>Calculate for me</Chip><Chip active={d.nutritionMode === "custom"} onClick={() => set("nutritionMode", "custom")}>I'll set my own</Chip></div>
          {d.nutritionMode === "auto" ? <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Sex" htmlFor="sx"><Select id="sx" value={d.sex ?? ""} onChange={(e) => set("sex", e.target.value || null)}><option value="">Prefer not to say</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option></Select></Field>
              <Field label="Age" htmlFor="ag"><Input id="ag" type="number" inputMode="numeric" value={d.age ?? ""} onChange={(e) => set("age", num(e.target.value))} /></Field>
              <Field label="Height (cm)" htmlFor="ht"><Input id="ht" type="number" inputMode="numeric" value={d.heightCm ?? ""} onChange={(e) => set("heightCm", num(e.target.value))} /></Field>
              <Field label="Weight (kg)" htmlFor="wt"><Input id="wt" type="number" inputMode="decimal" value={d.weightKg ?? ""} onChange={(e) => set("weightKg", num(e.target.value))} /></Field>
            </div>
            <Field label="Activity" htmlFor="ac"><Select id="ac" value={d.activityLevel} onChange={(e) => set("activityLevel", e.target.value)}>{ACTIVITY.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}</Select></Field>
            <p className="text-xs text-muted-foreground">Targets are an estimate for planning, not medical advice. We'll recalculate when you save.</p>
          </> : (
            <div className="grid grid-cols-2 gap-3">
              {([["calories", "Calories"], ["proteinG", "Protein (g)"], ["carbsG", "Carbs (g)"], ["fatG", "Fat (g)"]] as const).map(([k, l]) => <Field key={k} label={l} htmlFor={k}><Input id={k} type="number" inputMode="numeric" value={d.targets[k]} onChange={(e) => setD((x) => ({ ...x, targets: { ...x.targets, [k]: Number(e.target.value) } }))} /></Field>)}
            </div>
          )}
        </>}
        {section === "basics" && <>
          <div><p className="mb-2 text-sm font-semibold">Units</p><div className="flex gap-2">{[["metric", "Metric (kg, cm)"], ["imperial", "Imperial (lb, in)"]].map(([v, l]) => <Chip key={v} active={d.units === v} onClick={() => set("units", v)}>{l}</Chip>)}</div></div>
          <div><p className="mb-2 text-sm font-semibold">Currency</p><div className="flex flex-wrap gap-2">{["INR", "USD", "GBP", "EUR"].map((c) => <Chip key={c} active={d.currency === c} onClick={() => set("currency", c)}>{c}</Chip>)}</div></div>
          <div><p className="mb-2 text-sm font-semibold">Theme</p><div className="flex gap-2">{["system", "light", "dark"].map((t) => <Chip key={t} active={d.theme === t} onClick={() => set("theme", t)}>{t[0].toUpperCase() + t.slice(1)}</Chip>)}</div></div>
        </>}
        <Button size="lg" className="w-full" onClick={save} loading={busy}>Save</Button>
      </div>
    </Sheet>
  );
}
