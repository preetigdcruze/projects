import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { iso, today, addDays } from "@/lib/dates";
import { AppError } from "@/lib/errors";
import { addItem, alternativesFor, duplicateItem, editItem, generatePlan, getDayItems, moveItem, removeItem, replaceItem, getWeek, applyTemplate, saveTemplate } from "@/server/services/meal-plan";
import { daySummary, deleteMealLog, logFood, logMeal } from "@/server/services/nutrition";
import { addRecipeToList, generateList, getListWithItems, updateItem, addManualItem, clearCompleted } from "@/server/services/grocery";
import { addPantryItem, deletePantryItem, listPantry, updatePantryItem } from "@/server/services/pantry";
import { createRecipe, getRecipe, recipeDetail, searchRecipes, toggleFavorite } from "@/server/services/recipes";
import { chat, getConversation } from "@/server/services/ai-chat";
import { startOfWeek } from "@/lib/dates";

const stamp = Date.now();
let A: string, B: string, C: string;
const curry = async () => (await prisma.recipe.findUniqueOrThrow({ where: { slug: "chicken-curry" } }));

async function mkUser(tag: string, prefs: Record<string, unknown> = {}, plan = "pro") {
  const u = await prisma.user.create({
    data: {
      email: `test-${tag}-${stamp}@example.com`, name: tag, onboarded: true,
      profile: { create: {} },
      preference: { create: { goals: ["eat_healthier"], dietType: "everything", cuisines: ["Indian"], maxCookMinutes: 45, householdSize: 2, mealTypes: ["breakfast", "lunch", "dinner"], ...prefs } },
      goal: { create: { calories: 2000, proteinG: 120, carbsG: 220, fatG: 65 } },
      subscription: { create: { plan } },
    },
  });
  return u.id;
}
const expectAppError = async (p: Promise<unknown>, status?: number) => {
  const err = await p.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(AppError);
  if (status) expect((err as AppError).status).toBe(status);
};

beforeAll(async () => {
  expect(await prisma.recipe.count({ where: { userId: null } })).toBeGreaterThanOrEqual(100); // seed must have run
  [A, B, C] = await Promise.all([mkUser("a"), mkUser("b"), mkUser("c", { dietType: "vegetarian" })]);
});
afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { contains: `-${stamp}@example.com` } } });
  await prisma.$disconnect();
});

describe("meal plan generation", () => {
  it("generates a plan that respects diet and exclusions", async () => {
    await prisma.dietaryRestriction.create({ data: { userId: C, kind: "dislike", value: "mushroom" } });
    await prisma.allergy.create({ data: { userId: C, name: "peanuts" } });
    const res = await generatePlan(C, { days: 7, mealsPerDay: 4, seed: 7, startDate: iso(today()) });
    expect(res.itemCount).toBeGreaterThanOrEqual(24);
    const items = await prisma.mealPlanItem.findMany({ where: { day: { mealPlan: { userId: C } } }, include: { recipe: { include: { ingredients: { include: { ingredient: true } } } } } });
    for (const it of items) {
      expect(["vegan", "vegetarian"]).toContain(it.recipe.dietType);
      const names = it.recipe.ingredients.map((i) => i.ingredient.normalizedName);
      expect(names.some((n) => n.includes("mushroom") || n.includes("peanut"))).toBe(false);
    }
    const perDay = new Set(items.map((i) => i.dayId)).size;
    expect(perDay).toBe(7);
  });
  it("is deterministic for a given seed and varied across days", async () => {
    await generatePlan(A, { days: 5, mealsPerDay: 3, seed: 11, startDate: iso(today()) });
    const first = (await getWeek(A, today())).flatMap((d) => d.items.map((i) => i.title));
    await generatePlan(A, { days: 5, mealsPerDay: 3, seed: 11, startDate: iso(today()) });
    const second = (await getWeek(A, today())).flatMap((d) => d.items.map((i) => i.title));
    expect(second).toEqual(first);
    const dinners = (await getWeek(A, today())).flatMap((d) => d.items.filter((i) => i.mealType === "dinner" && !i.isLeftover).map((i) => i.title));
    expect(new Set(dinners).size).toBe(dinners.length);
  });
  it("enforces the free-plan limit", async () => {
    const F = await mkUser("free", {}, "free");
    for (let i = 0; i < 3; i++) await generatePlan(F, { days: 3, mealsPerDay: 2, seed: i });
    await expectAppError(generatePlan(F, { days: 3, mealsPerDay: 2 }), 402);
  });
});

describe("logging & nutrition totals", () => {
  it("changes daily totals when a planned meal is logged and updates on portion change", async () => {
    const before = await daySummary(A, today());
    const items = await getDayItems(A, today());
    const bf = items.find((i) => i.mealType === "breakfast")!;
    expect(bf.status).toBe("planned");
    const recipe = await prisma.recipe.findUniqueOrThrow({ where: { id: bf.recipeId } });
    await logMeal(A, { mealPlanItemId: bf.id, consumedQuantity: 1 });
    const after = await daySummary(A, today());
    expect(after.consumed.calories - before.consumed.calories).toBe(recipe.calories);
    expect(after.remaining.calories).toBe(Math.max(0, 2000 - after.consumed.calories));
    await logMeal(A, { mealPlanItemId: bf.id, consumedQuantity: 0.5 });
    const half = await daySummary(A, today());
    expect(half.consumed.calories).toBe(Math.round(recipe.calories * 0.5));
    expect(half.meals).toHaveLength(1); // re-logging updates, not duplicates
    expect((await getDayItems(A, today())).find((i) => i.id === bf.id)!.status).toBe("eaten");
    await logMeal(A, { mealPlanItemId: bf.id, status: "skipped" });
    expect((await daySummary(A, today())).consumed.calories).toBe(0);
  });
  it("includes manually logged foods and validates quantities", async () => {
    await logFood(A, { name: "Banana", mealType: "snack", calories: 105, protein: 1.3, carbs: 27, fat: 0.4 });
    const s = await daySummary(A, today());
    expect(s.foods).toHaveLength(1);
    expect(s.consumed.calories).toBeGreaterThanOrEqual(105);
    await expectAppError(logMeal(A, { recipeId: (await curry()).id, mealType: "dinner", consumedQuantity: 0 }));
    await expectAppError(logMeal(A, { recipeId: (await curry()).id, mealType: "dinner", consumedQuantity: 50 }));
  });
  it("cannot swap or move a meal that is already logged", async () => {
    const d = await addItem(A, { date: iso(addDays(today(), 3)), mealType: "dinner", recipeId: (await curry()).id });
    await logMeal(A, { mealPlanItemId: d.id });
    await expectAppError(replaceItem(A, d.id, (await prisma.recipe.findFirstOrThrow({ where: { slug: "egg-curry" } })).id), 409);
    await expectAppError(moveItem(A, d.id, { mealType: "lunch" }), 409);
  });
});

describe("swapping, moving, duplicating", () => {
  it("lists alternatives with reasons and replaces the meal in the database", async () => {
    const it = await addItem(A, { date: iso(addDays(today(), 5)), mealType: "dinner", recipeId: (await curry()).id });
    const alts = await alternativesFor(A, it.id);
    expect(alts.length).toBeGreaterThan(0);
    expect(alts[0].reasons.length).toBeGreaterThan(0);
    expect(alts.every((a) => a.recipeId !== it.recipeId)).toBe(true);
    await replaceItem(A, it.id, alts[0].recipeId);
    expect((await prisma.mealPlanItem.findUniqueOrThrow({ where: { id: it.id } })).recipeId).toBe(alts[0].recipeId);
  });
  it("respects vegetarian constraint for substitutions", async () => {
    const it = await addItem(A, { date: iso(addDays(today(), 6)), mealType: "dinner", recipeId: (await curry()).id });
    const alts = await alternativesFor(A, it.id, { vegetarian: true });
    expect(alts.length).toBeGreaterThan(0);
    expect(alts.every((a) => ["vegan", "vegetarian"].includes(a.dietType))).toBe(true);
  });
  it("moves, duplicates, edits and removes items", async () => {
    const it = await addItem(A, { date: iso(addDays(today(), 7)), mealType: "lunch", recipeId: (await curry()).id });
    const moved = await moveItem(A, it.id, { date: iso(addDays(today(), 8)), mealType: "dinner" });
    expect(moved.mealType).toBe("dinner");
    const dup = await duplicateItem(A, it.id, { date: iso(addDays(today(), 9)) });
    expect(dup.recipeId).toBe(it.recipeId);
    const edited = await editItem(A, it.id, { servings: 6, portion: 1.5 });
    expect(edited.servings).toBe(6);
    await removeItem(A, dup.id);
    expect(await prisma.mealPlanItem.findUnique({ where: { id: dup.id } })).toBeNull();
  });
  it("saves a week as a template and applies it", async () => {
    const ws = startOfWeek(today());
    const t = await saveTemplate(A, "My Week", ws);
    const next = addDays(ws, 14);
    const n = await applyTemplate(A, t.id, next);
    expect(n).toBeGreaterThan(0);
    expect((await getWeek(A, next)).flatMap((d) => d.items).length).toBe(n);
  });
});

describe("grocery generation, consolidation and pantry subtraction", () => {
  it("consolidates duplicate ingredients and subtracts the pantry", async () => {
    const U = await mkUser("grocery");
    const r = await curry(); // 600 g chicken thigh for 4 servings
    const d = iso(addDays(today(), 1));
    await addItem(U, { date: d, mealType: "dinner", recipeId: r.id, servings: 4 });
    await addItem(U, { date: iso(addDays(today(), 2)), mealType: "dinner", recipeId: r.id, servings: 4 });
    const gen = await generateList(U, { from: iso(today()), days: 7 });
    expect(gen.items).toBeGreaterThan(5);
    let { items } = await getListWithItems(U);
    const chicken = items.filter((i) => i.name === "Chicken thigh");
    expect(chicken).toHaveLength(1); // not two separate entries
    expect(chicken[0].quantity).toBe(1200);
    expect(chicken[0].fromMealPlan).toBe(true);
    expect(chicken[0].recipeTitles).toEqual(["Chicken Curry"]);

    await addPantryItem(U, { name: "chicken thigh", quantity: 500, unit: "g" });
    await generateList(U, { from: iso(today()), days: 7 });
    ({ items } = await getListWithItems(U));
    expect(items.find((i) => i.name === "Chicken thigh")!.quantity).toBe(700);

    await addPantryItem(U, { name: "Chicken thighs", quantity: 1, unit: "kg" }); // merges into same pantry row, fully covers need
    expect(await prisma.pantryItem.count({ where: { userId: U, name: "Chicken thigh" } })).toBe(1);
    await generateList(U, { from: iso(today()), days: 7 });
    ({ items } = await getListWithItems(U));
    expect(items.find((i) => i.name === "Chicken thigh")).toBeUndefined();
  });
  it("keeps manual items and checked state across regeneration, and can clear completed into pantry", async () => {
    const U = await mkUser("grocery2");
    await addItem(U, { date: iso(addDays(today(), 1)), mealType: "dinner", recipeId: (await curry()).id, servings: 4 });
    await generateList(U);
    await addManualItem(U, { name: "bananas", quantity: 6 });
    let { items } = await getListWithItems(U);
    const onion = items.find((i) => i.name === "Onion")!;
    await updateItem(U, onion.id, { checked: true });
    await generateList(U);
    ({ items } = await getListWithItems(U));
    expect(items.find((i) => i.name === "Bananas" || i.name === "Banana")).toBeTruthy();
    expect(items.find((i) => i.name === "Onion")!.checked).toBe(true);
    const cleared = await clearCompleted(U, { toPantry: true });
    expect(cleared).toBe(1);
    expect((await listPantry(U)).find((p) => p.name === "Onion")).toBeTruthy();
  });
  it("adds a single recipe's scaled ingredients to the list and merges with existing items", async () => {
    const U = await mkUser("grocery3");
    const r = await curry();
    await addRecipeToList(U, r.id, 8); // double the recipe
    let { items } = await getListWithItems(U);
    expect(items.find((i) => i.name === "Chicken thigh")!.quantity).toBe(1200);
    expect(items.find((i) => i.name === "Chicken thigh")!.fromMealPlan).toBe(false);
    await addRecipeToList(U, r.id, 4);
    ({ items } = await getListWithItems(U));
    expect(items.filter((i) => i.name === "Chicken thigh")).toHaveLength(1);
    expect(items.find((i) => i.name === "Chicken thigh")!.quantity).toBe(1800);
  });
  it("refuses to generate with no plan", async () => {
    await expectAppError(generateList(await mkUser("empty")), 422);
  });
});

describe("recipes: scaling, search, custom, favorites", () => {
  it("scales the detail view with servings", async () => {
    const r = await prisma.recipe.findUniqueOrThrow({ where: { slug: "paneer-tikka" } }); // 2 servings, 300 g paneer
    const d4 = await recipeDetail(A, r.id, 4);
    expect(d4.ingredients.find((i) => i.name === "Paneer")!.quantity).toBe(600);
    expect(d4.total.calories).toBe(r.calories * 4);
    expect(d4.perServing.calories).toBe(r.calories);
  });
  it("searches by ingredient and combines natural-language filters", async () => {
    const chicken = await searchRecipes(A, { q: "chicken", pageSize: 60 });
    expect(chicken.total).toBeGreaterThan(5);
    const combo = await searchRecipes(A, { q: "high protein vegetarian under 30 minutes", pageSize: 60 });
    expect(combo.items.length).toBeGreaterThan(0);
    expect(combo.items.every((r) => r.totalTime <= 30 && ["vegan", "vegetarian"].includes(r.dietType) && r.protein >= 18)).toBe(true);
    const thai = await searchRecipes(A, { cuisine: "Thai", mealType: "dinner" });
    expect(thai.items.every((r) => r.cuisine === "Thai")).toBe(true);
  });
  it("creates a custom recipe with computed nutrition, relational ingredients and favorites", async () => {
    const rec = await createRecipe(A, { title: "My Test Bowl", servings: 2, prepTime: 5, cookTime: 10, instructions: ["Mix.", "Eat."], ingredients: [{ name: "chicken breast", quantity: 300, unit: "g" }, { name: "Mystery Spice", quantity: 1, unit: "tsp" }] });
    const full = await getRecipe(A, rec.id);
    expect(full.dietType).toBe("nonveg");
    expect(full.calories).toBe(Math.round((300 * 1.65) / 2));
    expect(full.ingredients).toHaveLength(2);
    expect((await searchRecipes(A, { collection: "mine" })).items.map((r) => r.title)).toContain("My Test Bowl");
    expect(await toggleFavorite(A, rec.id)).toBe(true);
    expect((await searchRecipes(A, { collection: "favorites" })).items.map((r) => r.id)).toContain(rec.id);
    expect(await toggleFavorite(A, rec.id)).toBe(false);
  });
});

describe("assistant", () => {
  it("replaces a planned meal in the database when asked", async () => {
    const U = await mkUser("assist");
    const date = addDays(today(), 1);
    await addItem(U, { date: iso(date), mealType: "dinner", recipeId: (await curry()).id });
    const day = date.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
    const res = await chat(U, { message: `Replace ${day}'s dinner with something vegetarian` });
    expect(res.changed).toBe(true);
    expect(res.reply).toMatch(/^Done\. I replaced/);
    const items = await getDayItems(U, date);
    expect(items).toHaveLength(1);
    expect(["vegan", "vegetarian"]).toContain(items[0].dietType);
    expect(items[0].title).not.toBe("Chicken Curry");
  });
  it("suggests meals from ingredients without touching the plan", async () => {
    const U = await mkUser("assist2");
    const res = await chat(U, { message: "I have chicken, rice and spinach" });
    expect(res.changed).toBe(false);
    expect(res.recipes.length).toBeGreaterThan(0);
    expect(await prisma.mealPlanItem.count({ where: { day: { mealPlan: { userId: U } } } })).toBe(0);
  });
});

describe("authorization & data isolation", () => {
  let itemId: string, logId: string, groceryId: string, pantryId: string, recipeId: string, convId: string;
  beforeAll(async () => {
    const it = await addItem(A, { date: iso(addDays(today(), 10)), mealType: "dinner", recipeId: (await curry()).id });
    itemId = it.id;
    logId = (await logMeal(A, { mealPlanItemId: itemId })).id;
    groceryId = (await addManualItem(A, { name: "secret item", quantity: 1 })).id;
    pantryId = (await addPantryItem(A, { name: "secret rice", quantity: 1, unit: "kg" })).id;
    recipeId = (await createRecipe(A, { title: "Private Recipe", servings: 1, prepTime: 1, cookTime: 1, instructions: ["x"], ingredients: [{ name: "egg", quantity: 1, unit: "pc" }] })).id;
    convId = (await chat(A, { message: "what should I eat tonight?" })).conversationId;
  });
  it("blocks another user from every meal plan operation", async () => {
    await expectAppError(removeItem(B, itemId), 404);
    await expectAppError(replaceItem(B, itemId, (await curry()).id), 404);
    await expectAppError(editItem(B, itemId, { servings: 9 }), 404);
    await expectAppError(moveItem(B, itemId, { mealType: "lunch" }), 404);
    await expectAppError(duplicateItem(B, itemId), 404);
    await expectAppError(alternativesFor(B, itemId), 404);
    await expectAppError(logMeal(B, { mealPlanItemId: itemId }), 404);
    expect(await prisma.mealPlanItem.findUnique({ where: { id: itemId } })).not.toBeNull();
  });
  it("blocks access to others' logs, grocery, pantry, recipes, conversations", async () => {
    await expectAppError(deleteMealLog(B, logId), 404);
    await expectAppError(updateItem(B, groceryId, { checked: true }), 404);
    await expectAppError(updatePantryItem(B, pantryId, { quantity: 5 }), 404);
    await expectAppError(deletePantryItem(B, pantryId), 404);
    await expectAppError(getRecipe(B, recipeId), 404);
    await expectAppError(toggleFavorite(B, recipeId), 404);
    await expectAppError(chat(B, { message: "hi", conversationId: convId }), 404);
    await expectAppError(getConversation(B, convId), 404);
  });
  it("never leaks data into another user's views", async () => {
    expect((await getListWithItems(B)).items).toHaveLength(0);
    expect(await listPantry(B)).toHaveLength(0);
    expect((await getWeek(B, startOfWeek(today()))).flatMap((d) => d.items)).toHaveLength(0);
    expect((await daySummary(B, addDays(today(), 10))).consumed.calories).toBe(0);
    expect((await searchRecipes(B, { collection: "mine" })).items).toHaveLength(0);
    expect((await searchRecipes(B, { q: "Private Recipe" })).items).toHaveLength(0);
  });
});
