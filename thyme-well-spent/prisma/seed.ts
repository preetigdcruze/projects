import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { INGREDIENTS, FOODS, FISH, MEAT, DAIRY } from "./data/ingredients";
import { INDIAN } from "./data/indian";
import { ITALIAN, MEXICAN, MEDITERRANEAN, MIDDLE_EASTERN, JAPANESE, THAI, AMERICAN, SNACKS_DESSERTS } from "./data/world";
import type { RecipeSeed } from "./data/dsl";
import { perServing, recipeTotals, estimateTargets, isHighProtein } from "../src/lib/nutrition";
import { addDays, dateOnly, startOfWeek, today, iso } from "../src/lib/dates";

const prisma = new PrismaClient();
export const DEMO_EMAIL = "demo@thyme.app";
export const DEMO_PASSWORD = "demo1234";

const ALL: RecipeSeed[] = [...INDIAN, ...ITALIAN, ...MEXICAN, ...MEDITERRANEAN, ...MIDDLE_EASTERN, ...JAPANESE, ...THAI, ...AMERICAN, ...SNACKS_DESSERTS];

function hash(s: string) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return Math.abs(h); }
const slugify = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

function dietOf(names: string[]) {
  if (names.some((n) => MEAT.has(n))) return "nonveg";
  if (names.some((n) => FISH.has(n))) return "pescatarian";
  if (names.includes("egg")) return "eggetarian";
  if (names.some((n) => DAIRY.has(n))) return "vegetarian";
  return "vegan";
}

async function seedCatalogue() {
  for (const i of INGREDIENTS) {
    await prisma.ingredient.upsert({ where: { normalizedName: i.normalizedName }, create: i, update: i });
  }
  const ings = await prisma.ingredient.findMany();
  const byName = new Map(ings.map((i) => [i.normalizedName, i]));

  await prisma.foodItem.deleteMany();
  await prisma.foodItem.createMany({ data: FOODS });

  let n = 0;
  for (const r of ALL) {
    const slug = slugify(r.title);
    const rows = r.ingredients.map((x) => {
      const ing = byName.get(x.name);
      if (!ing) throw new Error(`Recipe "${r.title}" uses unknown ingredient "${x.name}"`);
      return { ...x, ing };
    });
    const totals = recipeTotals(rows.map((x) => ({ quantity: x.quantity, unit: x.unit, optional: x.optional, ingredient: x.ing })));
    const ps = perServing(totals, r.servings);
    const diet = dietOf(rows.map((x) => x.name));
    const total = r.prep + r.cook;
    const tags = new Set(r.tags);
    if (isHighProtein(ps.protein, ps.calories)) tags.add("high-protein");
    if (total <= 20) tags.add("quick");
    if (ps.calories <= 350) tags.add("low-calorie");
    if (diet === "vegan") { tags.add("vegan"); tags.add("vegetarian"); } else if (diet === "vegetarian") tags.add("vegetarian");
    if ((ps.carbs * 4) / Math.max(ps.calories, 1) < 0.2) tags.add("low-carb");
    const h = hash(r.title);
    const data = {
      slug, title: r.title, description: r.description, cuisine: r.cuisine, mealTypes: r.meals, dietType: diet,
      prepTime: r.prep, cookTime: r.cook, totalTime: total, servings: r.servings, calories: ps.calories, protein: ps.protein, carbs: ps.carbs, fat: ps.fat, fiber: ps.fiber,
      difficulty: r.difficulty, tags: [...tags], rating: 4.2 + (h % 8) / 10, ratingCount: 20 + (h % 380), popularity: 10 + (h % 90),
    };
    const rec = await prisma.recipe.upsert({ where: { slug }, create: data, update: data });
    await prisma.recipeIngredient.deleteMany({ where: { recipeId: rec.id } });
    await prisma.recipeInstruction.deleteMany({ where: { recipeId: rec.id } });
    await prisma.recipeIngredient.createMany({ data: rows.map((x, i) => ({ recipeId: rec.id, ingredientId: x.ing.id, quantity: x.quantity, unit: x.unit, optional: x.optional, preparationNote: x.note ?? null, position: i })) });
    await prisma.recipeInstruction.createMany({ data: r.steps.map((text, i) => ({ recipeId: rec.id, step: i + 1, text })) });
    n++;
  }
  return n;
}

async function seedDemo() {
  const { generatePlan } = await import("../src/server/services/meal-plan");
  const { generateList } = await import("../src/server/services/grocery");
  const existing = await prisma.user.findUnique({ where: { email: DEMO_EMAIL } });
  if (existing) await prisma.user.delete({ where: { id: existing.id } });

  const user = await prisma.user.create({
    data: {
      email: DEMO_EMAIL, name: "Asha", passwordHash: await bcrypt.hash(DEMO_PASSWORD, 10), onboarded: true,
      profile: { create: { sex: "female", age: 29, heightCm: 168, weightKg: 64, activityLevel: "moderate", units: "metric", currency: "INR" } },
      preference: { create: { goals: ["eat_healthier", "build_habits", "save_time"], dietType: "everything", cuisines: ["Indian", "Mediterranean", "Thai"], maxCookMinutes: 30, householdSize: 2, mealTypes: ["breakfast", "lunch", "snack", "dinner"], budget: "medium", weeklyBudget: 4000 } },
      goal: { create: { mode: "custom", calories: 2050, proteinG: 140, carbsG: 210, fatG: 70 } },
      restrictions: { create: [{ kind: "dislike", value: "mushroom" }, { kind: "avoid", value: "coconut" }] },
      notifications: { create: {} },
      subscription: { create: { plan: "pro", status: "active", currentPeriodEnd: addDays(new Date(), 365) } },
    },
  });
  void estimateTargets;

  const recipes = await prisma.recipe.findMany({ where: { userId: null } });
  const pool = recipes.filter((r) => !r.title.toLowerCase().includes("mushroom") && !r.title.toLowerCase().includes("coconut") && !["Thai Red Chicken Curry", "Coconut Vegetable Curry", "Goan Fish Curry", "Mango Sticky Rice", "Tom Yum Prawn Soup", "Creamy Mushroom Pasta"].includes(r.title));
  const sorted = [...pool].sort((a, b) => b.popularity - a.popularity);
  const favs = [...sorted.filter((r) => r.cuisine === "Indian").slice(0, 10), ...sorted.filter((r) => r.cuisine !== "Indian").slice(0, 10)];
  await prisma.favoriteRecipe.createMany({ data: favs.slice(0, 20).map((r) => ({ userId: user.id, recipeId: r.id })) });

  const ing = async (n: string) => (await prisma.ingredient.findUniqueOrThrow({ where: { normalizedName: n } }));
  const pantry: [string, number, number | null][] = [
    ["basmati rice", 2000, null], ["olive oil", 500, null], ["chicken breast", 500, 2], ["spinach", 200, 2], ["onion", 6, 14], ["tomato", 4, 4],
    ["toor dal", 500, null], ["curd", 400, 3], ["cumin seeds", 50, null], ["turmeric", 50, null], ["garam masala", 40, null], ["salt", 500, null], ["cooking oil", 750, null],
  ];
  for (const [name, qty, days] of pantry) {
    const i = await ing(name);
    await prisma.pantryItem.create({ data: { userId: user.id, ingredientId: i.id, name: i.name, quantity: qty, unit: i.defaultUnit, category: i.category, expiresAt: days === null ? null : addDays(today(), days) } });
  }

  // 7-day plan: Monday → Sunday of the current week (generated by the real planner)
  const weekStart = startOfWeek(today());
  await generatePlan(user.id, { days: 7, startDate: iso(weekStart), mealsPerDay: 4, seed: 42 });
  await generateList(user.id, { from: iso(today()), days: 7 });

  // history: 14 days of meals before today (+ earlier this week gets logged too)
  const sortedPool = (type: string) => pool.filter((r) => r.mealTypes.includes(type));
  for (let d = 1; d <= 14; d++) {
    const date = addDays(today(), -d);
    for (const [type, share] of [["breakfast", 0.25], ["lunch", 0.3], ["snack", 0.12], ["dinner", 0.3]] as const) {
      const options = sortedPool(type);
      const r = options[hash(`${iso(date)}${type}`) % options.length];
      if ((hash(`${iso(date)}${type}x`) % 9) === 0) continue; // occasionally skip a log for realism
      const qty = [0.75, 1, 1, 1, 1.25][hash(`${iso(date)}${type}q`) % 5] * Math.max(0.6, Math.min(1.6, (2050 * share) / r.calories));
      const q = Math.round(qty * 4) / 4;
      await prisma.mealLog.create({ data: { userId: user.id, recipeId: r.id, mealType: type, consumedQuantity: q, consumedAt: new Date(date.getTime() + 12 * 3600000), logDate: date, cooked: true, calories: Math.round(r.calories * q), protein: Math.round(r.protein * q * 10) / 10, carbs: Math.round(r.carbs * q * 10) / 10, fat: Math.round(r.fat * q * 10) / 10, fiber: Math.round(r.fiber * q * 10) / 10 } });
    }
    if (d % 3 === 0) await prisma.foodLog.create({ data: { userId: user.id, name: "Banana, medium", mealType: "snack", source: "search", logDate: date, calories: 105, protein: 1.3, carbs: 27, fat: 0.4, fiber: 3.1 } });
  }
  void dateOnly;
  return user.id;
}

async function main() {
  const n = await seedCatalogue();
  console.log(`✓ Seeded ${INGREDIENTS.length} ingredients, ${n} recipes, ${FOODS.length} foods`);
  await seedDemo();
  console.log(`✓ Demo account ready: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
