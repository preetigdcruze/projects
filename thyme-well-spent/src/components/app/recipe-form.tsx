"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Controller, useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { TagInput } from "@/components/ui/tag-input";
import { api, ApiError } from "@/lib/client";
import { MEAL_LABEL } from "@/lib/dates";
import { toast } from "sonner";
import Link from "next/link";

const num = z.number({ message: "Enter a number" });
const schema = z.object({
  title: z.string().trim().min(1, "Give your recipe a name"), description: z.string().max(500).optional(), image: z.string().url("Enter a full image link, or leave blank").or(z.literal("")).optional(),
  cuisine: z.string(), mealTypes: z.array(z.string()).min(1, "Pick at least one meal type"), servings: num.int().min(1).max(50), prepTime: num.int().min(0), cookTime: num.int().min(0),
  difficulty: z.enum(["easy", "medium", "hard"]), tags: z.array(z.string()),
  ingredients: z.array(z.object({ name: z.string().trim().min(1, "Name?"), quantity: num.positive("Amount?"), unit: z.enum(["g", "kg", "ml", "l", "tsp", "tbsp", "cup", "pc", "pinch"]) })).min(1, "Add at least one ingredient"),
  instructions: z.array(z.object({ text: z.string().trim().min(1, "Write the step") })).min(1, "Add at least one step"),
  knowNutrition: z.boolean(), calories: num.min(0).optional().or(z.nan()), protein: num.min(0).optional().or(z.nan()), carbs: num.min(0).optional().or(z.nan()), fat: num.min(0).optional().or(z.nan()),
});
export type RecipeFormValues = z.infer<typeof schema>;

const UNITS = ["g", "kg", "ml", "l", "tsp", "tbsp", "cup", "pc", "pinch"] as const;
const CUISINES = ["Indian", "Italian", "Mexican", "Thai", "Mediterranean", "Japanese", "American", "Middle Eastern", "Other"];

export type Draft = {
  title: string; description?: string; image?: string | null; cuisine?: string; mealTypes?: string[]; servings: number; prepTime: number; cookTime: number; sourceUrl?: string | null; tags?: string[];
  ingredients: { name: string; quantity: number; unit: string }[]; instructions: string[]; nutrition?: { calories?: number; protein?: number; carbs?: number; fat?: number } | null;
};

export function RecipeForm({ draft }: { draft?: Draft }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const nutr = draft?.nutrition;
  const { register, control, handleSubmit, watch, formState: { errors, isSubmitting } } = useForm<RecipeFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      title: draft?.title ?? "", description: draft?.description ?? "", image: draft?.image ?? "", cuisine: draft?.cuisine ?? "Other", mealTypes: draft?.mealTypes ?? ["dinner"], servings: draft?.servings ?? 2,
      prepTime: draft?.prepTime ?? 10, cookTime: draft?.cookTime ?? 20, difficulty: "easy", tags: draft?.tags ?? [],
      ingredients: draft?.ingredients?.length ? (draft.ingredients as RecipeFormValues["ingredients"]) : [{ name: "", quantity: 100, unit: "g" }],
      instructions: draft?.instructions?.length ? draft.instructions.map((text) => ({ text })) : [{ text: "" }],
      knowNutrition: !!nutr?.calories, calories: nutr?.calories, protein: nutr?.protein, carbs: nutr?.carbs, fat: nutr?.fat,
    },
  });
  const ing = useFieldArray({ control, name: "ingredients" });
  const steps = useFieldArray({ control, name: "instructions" });
  const know = watch("knowNutrition");
  const clean = (v: unknown) => (typeof v === "number" && !Number.isNaN(v) ? v : undefined);

  async function submit(v: RecipeFormValues) {
    setError(null);
    try {
      const r = await api<{ id: string }>("/api/recipes", {
        body: {
          title: v.title, description: v.description || undefined, image: v.image || null, cuisine: v.cuisine, mealTypes: v.mealTypes, servings: v.servings, prepTime: v.prepTime, cookTime: v.cookTime, difficulty: v.difficulty, tags: v.tags,
          sourceUrl: draft?.sourceUrl ?? null, ingredients: v.ingredients, instructions: v.instructions.map((s) => s.text),
          nutrition: v.knowNutrition ? { calories: clean(v.calories), protein: clean(v.protein), carbs: clean(v.carbs), fat: clean(v.fat) } : null,
        },
      });
      toast.success("Recipe saved to My Recipes");
      router.push(`/recipes/${r.id}`); router.refresh();
    } catch (e) { setError(e instanceof ApiError ? e.message : "Couldn't save the recipe. Please try again."); }
  }
  const err = (m?: string) => (m ? <p role="alert" className="text-sm text-danger">{m}</p> : null);

  return (
    <form onSubmit={handleSubmit(submit)} className="space-y-7" noValidate>
      <div className="space-y-4">
        <Field label="Recipe name" htmlFor="title"><Input id="title" {...register("title")} aria-invalid={!!errors.title} />{err(errors.title?.message)}</Field>
        <Field label="Description" htmlFor="desc"><Textarea id="desc" {...register("description")} placeholder="A sentence about this dish" /></Field>
        <Field label="Image link (optional)" htmlFor="image" hint="Paste a link to a photo. We'll show a pretty placeholder if blank."><Input id="image" inputMode="url" placeholder="https://" {...register("image")} />{err(errors.image?.message)}</Field>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Servings" htmlFor="servings"><Input id="servings" type="number" inputMode="numeric" {...register("servings", { valueAsNumber: true })} />{err(errors.servings?.message)}</Field>
        <Field label="Prep (min)" htmlFor="prep"><Input id="prep" type="number" inputMode="numeric" {...register("prepTime", { valueAsNumber: true })} />{err(errors.prepTime?.message)}</Field>
        <Field label="Cook (min)" htmlFor="cook"><Input id="cook" type="number" inputMode="numeric" {...register("cookTime", { valueAsNumber: true })} />{err(errors.cookTime?.message)}</Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Cuisine" htmlFor="cuisine"><Select id="cuisine" {...register("cuisine")}>{CUISINES.map((c) => <option key={c}>{c}</option>)}</Select></Field>
        <Field label="Difficulty" htmlFor="diff"><Select id="diff" {...register("difficulty")}><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></Select></Field>
      </div>
      <Controller control={control} name="mealTypes" render={({ field }) => (
        <div><p className="mb-2 text-sm font-medium">Good for</p><div className="flex flex-wrap gap-2">{["breakfast", "lunch", "dinner", "snack", "dessert"].map((m) => <Chip key={m} active={field.value.includes(m)} onClick={() => field.onChange(field.value.includes(m) ? field.value.filter((x) => x !== m) : [...field.value, m])}>{MEAL_LABEL[m] ?? "Dessert"}</Chip>)}</div>{err(errors.mealTypes?.message)}</div>
      )} />

      <section aria-labelledby="ing-h" className="space-y-3">
        <h2 id="ing-h" className="text-lg font-semibold">Ingredients</h2>
        {ing.fields.map((f, i) => (
          <div key={f.id} className="flex items-start gap-2">
            <div className="min-w-0 flex-[2]"><Input placeholder="e.g. chicken breast" aria-label={`Ingredient ${i + 1} name`} {...register(`ingredients.${i}.name`)} />{err(errors.ingredients?.[i]?.name?.message)}</div>
            <div className="w-20"><Input type="number" step="any" inputMode="decimal" aria-label={`Ingredient ${i + 1} amount`} {...register(`ingredients.${i}.quantity`, { valueAsNumber: true })} />{err(errors.ingredients?.[i]?.quantity?.message)}</div>
            <div className="w-24"><Select aria-label={`Ingredient ${i + 1} unit`} {...register(`ingredients.${i}.unit`)}>{UNITS.map((u) => <option key={u}>{u}</option>)}</Select></div>
            <button type="button" onClick={() => ing.remove(i)} disabled={ing.fields.length === 1} aria-label={`Remove ingredient ${i + 1}`} className="tap flex h-12 items-center justify-center rounded-full text-muted-foreground hover:bg-muted disabled:opacity-30"><Trash2 className="h-4 w-4" /></button>
          </div>
        ))}
        {err(errors.ingredients?.message)}
        <Button type="button" variant="outline" size="sm" onClick={() => ing.append({ name: "", quantity: 100, unit: "g" })}><Plus className="h-4 w-4" />Add ingredient</Button>
      </section>

      <section aria-labelledby="steps-h" className="space-y-3">
        <h2 id="steps-h" className="text-lg font-semibold">Instructions</h2>
        {steps.fields.map((f, i) => (
          <div key={f.id} className="flex items-start gap-2">
            <span className="mt-3 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">{i + 1}</span>
            <div className="flex-1"><Textarea className="min-h-16" aria-label={`Step ${i + 1}`} {...register(`instructions.${i}.text`)} />{err(errors.instructions?.[i]?.text?.message)}</div>
            <button type="button" onClick={() => steps.remove(i)} disabled={steps.fields.length === 1} aria-label={`Remove step ${i + 1}`} className="tap flex h-12 items-center justify-center rounded-full text-muted-foreground hover:bg-muted disabled:opacity-30"><Trash2 className="h-4 w-4" /></button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => steps.append({ text: "" })}><Plus className="h-4 w-4" />Add step</Button>
      </section>

      <section aria-labelledby="nut-h" className="space-y-3 rounded-3xl bg-card p-4 shadow-soft">
        <h2 id="nut-h" className="text-lg font-semibold">Nutrition</h2>
        <label className="flex cursor-pointer items-center gap-3 text-[15px]"><input type="checkbox" className="h-5 w-5 accent-[hsl(var(--primary))]" {...register("knowNutrition")} />I know the nutrition per serving</label>
        {know ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(["calories", "protein", "carbs", "fat"] as const).map((k) => <Field key={k} label={k === "calories" ? "Calories" : `${k[0].toUpperCase()}${k.slice(1)} (g)`} htmlFor={k}><Input id={k} type="number" step="any" inputMode="decimal" {...register(k, { valueAsNumber: true })} /></Field>)}
          </div>
        ) : <p className="text-sm text-muted-foreground">We'll estimate it from your ingredients. Unusual ingredients may be missing, so add your own numbers if you have them.</p>}
      </section>

      <Controller control={control} name="tags" render={({ field }) => <Field label="Tags"><TagInput label="Tags" value={field.value} onChange={field.onChange} placeholder="e.g. weeknight, kid-friendly" /></Field>} />

      {error && <p role="alert" className="rounded-2xl bg-danger/10 px-4 py-3 text-sm text-danger">{error}{error.includes("Upgrade") && <> <Link href="/subscription" className="font-semibold underline">See Pro</Link></>}</p>}
      <div className="flex gap-3"><Button type="button" variant="outline" size="lg" onClick={() => router.back()}>Cancel</Button><Button type="submit" size="lg" className="flex-1" loading={isSubmitting}>Save recipe</Button></div>
    </form>
  );
}
