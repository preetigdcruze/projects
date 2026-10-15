import { toBase, type IngredientUnitInfo } from "./units";

export type Macros = { calories: number; protein: number; carbs: number; fat: number; fiber: number };
export const ZERO: Macros = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };

export type NutritionIngredient = IngredientUnitInfo & {
  kcal100: number; protein100: number; carbs100: number; fat100: number; fiber100: number;
};

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Total nutrition of a recipe (all servings) derived from relational ingredient rows. */
export function recipeTotals(rows: { quantity: number; unit: string; optional?: boolean; ingredient: NutritionIngredient }[]): Macros {
  const t = { ...ZERO };
  for (const r of rows) {
    if (r.optional) continue;
    const base = toBase(r.quantity, r.unit, r.ingredient);
    // nutrition is stored per 100 g/ml; counted items convert through gramsPerPiece
    const grams = r.ingredient.defaultUnit === "pc" ? base * (r.ingredient.gramsPerPiece ?? 100) : base;
    const k = grams / 100;
    t.calories += r.ingredient.kcal100 * k;
    t.protein += r.ingredient.protein100 * k;
    t.carbs += r.ingredient.carbs100 * k;
    t.fat += r.ingredient.fat100 * k;
    t.fiber += r.ingredient.fiber100 * k;
  }
  return { calories: Math.round(t.calories), protein: round1(t.protein), carbs: round1(t.carbs), fat: round1(t.fat), fiber: round1(t.fiber) };
}

export function perServing(totals: Macros, servings: number): Macros {
  const s = Math.max(servings, 1);
  return { calories: Math.round(totals.calories / s), protein: round1(totals.protein / s), carbs: round1(totals.carbs / s), fat: round1(totals.fat / s), fiber: round1(totals.fiber / s) };
}

export function scaleMacros(m: Macros, factor: number): Macros {
  return { calories: Math.round(m.calories * factor), protein: round1(m.protein * factor), carbs: round1(m.carbs * factor), fat: round1(m.fat * factor), fiber: round1(m.fiber * factor) };
}

export function sumMacros(list: Partial<Macros>[]): Macros {
  const t = { ...ZERO };
  for (const m of list) {
    t.calories += m.calories ?? 0; t.protein += m.protein ?? 0; t.carbs += m.carbs ?? 0; t.fat += m.fat ?? 0; t.fiber += m.fiber ?? 0;
  }
  return { calories: Math.round(t.calories), protein: round1(t.protein), carbs: round1(t.carbs), fat: round1(t.fat), fiber: round1(t.fiber) };
}

export type Targets = { calories: number; proteinG: number; carbsG: number; fatG: number };

export function remaining(target: Targets, eaten: Macros) {
  return {
    calories: Math.max(0, Math.round(target.calories - eaten.calories)),
    protein: Math.max(0, Math.round(target.proteinG - eaten.protein)),
    carbs: Math.max(0, Math.round(target.carbsG - eaten.carbs)),
    fat: Math.max(0, Math.round(target.fatG - eaten.fat)),
  };
}

const ACTIVITY: Record<string, number> = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, very_active: 1.9 };

export type TargetInput = {
  sex?: string | null; age?: number | null; heightCm?: number | null; weightKg?: number | null;
  activityLevel?: string | null; goals?: string[]; dietType?: string | null;
};

/** Mifflin-St Jeor estimate. An estimate only — not medical advice. */
export function estimateTargets(i: TargetInput): Targets {
  const weight = i.weightKg ?? 70, height = i.heightCm ?? 170, age = i.age ?? 30;
  const sexConst = i.sex === "male" ? 5 : i.sex === "female" ? -161 : -78;
  const bmr = 10 * weight + 6.25 * height - 5 * age + sexConst;
  const tdee = bmr * (ACTIVITY[i.activityLevel ?? "moderate"] ?? 1.55);
  const goals = i.goals ?? [];
  let calories = tdee;
  if (goals.includes("lose_weight")) calories = tdee * 0.85;
  else if (goals.includes("gain_muscle")) calories = tdee * 1.1;
  calories = Math.max(1200, Math.round(calories / 10) * 10);

  let p = 0.25, c = 0.45, f = 0.3;
  if (goals.includes("gain_muscle") || i.dietType === "high_protein") { p = 0.3; c = 0.4; f = 0.3; }
  else if (goals.includes("lose_weight")) { p = 0.3; c = 0.4; f = 0.3; }
  if (i.dietType === "keto") { p = 0.25; c = 0.05; f = 0.7; }
  else if (i.dietType === "low_carb") { p = 0.3; c = 0.25; f = 0.45; }
  return { calories, proteinG: Math.round((calories * p) / 4), carbsG: Math.round((calories * c) / 4), fatG: Math.round((calories * f) / 9) };
}

export const pct = (v: number, target: number) => (target > 0 ? Math.min(100, Math.round((v / target) * 100)) : 0);

/** One definition of "high protein" used by search, tags, swaps and the assistant. */
export const isHighProtein = (protein: number, calories: number) => protein >= 25 || (protein >= 18 && (protein * 4) / Math.max(calories, 1) >= 0.25);
