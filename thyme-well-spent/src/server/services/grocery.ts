import { prisma } from "@/lib/db";
import { AppError, notFound } from "@/lib/errors";
import { addDays, today } from "@/lib/dates";
import { consolidate, estimatePrice, shoppingRound, subtractPantry, GROCERY_CATEGORIES, type RawNeed } from "@/lib/grocery";
import { convertFromInr } from "@/lib/currency";
import { getUserContext } from "./context";
import { getRecipe } from "./recipes";
import { findIngredient, toBaseQty } from "./pantry";

export async function getActiveList(userId: string) {
  let list = await prisma.groceryList.findFirst({ where: { userId, isActive: true }, orderBy: { createdAt: "desc" } });
  if (!list) {
    const ctx = await getUserContext(userId);
    list = await prisma.groceryList.create({ data: { userId, currency: ctx.currency } });
  }
  return list;
}

export async function getListWithItems(userId: string) {
  const list = await getActiveList(userId);
  const items = await prisma.groceryListItem.findMany({ where: { listId: list.id }, orderBy: [{ category: "asc" }, { name: "asc" }] });
  const order = GROCERY_CATEGORIES as readonly string[];
  items.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || a.name.localeCompare(b.name));
  const total = items.filter((i) => !i.checked).reduce((a, i) => a + (i.estimatedPrice ?? 0), 0);
  return { list, items, estimatedTotal: Math.round(total * 100) / 100 };
}

async function needsFor(items: { recipeId: string; servings: number }[], userId: string): Promise<RawNeed[]> {
  const ids = [...new Set(items.map((i) => i.recipeId))];
  const recipes = await prisma.recipe.findMany({ where: { id: { in: ids }, OR: [{ userId: null }, { userId }] }, include: { ingredients: { include: { ingredient: true } } } });
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const needs: RawNeed[] = [];
  for (const it of items) {
    const r = byId.get(it.recipeId);
    if (!r) continue;
    const factor = it.servings / r.servings;
    for (const ri of r.ingredients) {
      needs.push({
        ingredientId: ri.ingredientId, name: ri.ingredient.name, category: ri.ingredient.category, defaultUnit: ri.ingredient.defaultUnit,
        gramsPerPiece: ri.ingredient.gramsPerPiece, pricePer100: ri.ingredient.pricePer100, quantity: ri.quantity * factor, unit: ri.unit,
        recipeTitle: r.title, optional: ri.optional,
      });
    }
  }
  return needs;
}

/** Rebuild the "from meal plan" part of the grocery list; manual items are kept, checked state is preserved. */
export async function generateList(userId: string, opts: { from?: string; days?: number; subtractPantry?: boolean } = {}) {
  const from = opts.from ? new Date(`${opts.from}T00:00:00.000Z`) : today();
  const to = addDays(from, Math.min(Math.max(opts.days ?? 7, 1), 28) - 1);
  const list = await getActiveList(userId);
  const ctx = await getUserContext(userId);
  const planItems = await prisma.mealPlanItem.findMany({
    where: { isLeftover: false, logs: { none: { status: "eaten" } }, day: { date: { gte: from, lte: to }, mealPlan: { userId, isActive: true } } },
    select: { recipeId: true, servings: true },
  });
  if (!planItems.length) throw new AppError("There are no planned meals in that range yet. Generate a plan first.", 422, "no_plan");

  const needs = await needsFor(planItems, userId);
  let items = consolidate(needs);
  const pantry = await prisma.pantryItem.findMany({ where: { userId } });
  const useP = opts.subtractPantry ?? true;
  const afterPantry = useP ? subtractPantry(items, pantry) : items.map((i) => ({ ...i, coveredByPantry: 0 }));
  const coveredCount = items.length - afterPantry.length + afterPantry.filter((i) => i.coveredByPantry > 0).length;

  const previous = await prisma.groceryListItem.findMany({ where: { listId: list.id, fromMealPlan: true } });
  const checkedIngredients = new Set(previous.filter((p) => p.checked && p.ingredientId).map((p) => p.ingredientId as string));
  await prisma.$transaction([
    prisma.groceryListItem.deleteMany({ where: { listId: list.id, fromMealPlan: true } }),
    prisma.groceryListItem.createMany({
      data: afterPantry.map((i) => {
        const qty = shoppingRound(i.quantity, i.unit);
        const inr = estimatePrice(qty, i.unit, i.pricePer100, i.gramsPerPiece);
        return {
          listId: list.id, ingredientId: i.ingredientId, name: i.name, quantity: qty, unit: i.unit, category: i.category, fromMealPlan: true,
          recipeTitles: i.recipeTitles, checked: checkedIngredients.has(i.ingredientId), estimatedPrice: inr === null ? null : Math.round(convertFromInr(inr, list.currency) * 100) / 100, currency: list.currency,
        };
      }),
    }),
  ]);
  void ctx;
  return { items: afterPantry.length, coveredByPantry: coveredCount, plannedMeals: planItems.length, from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

/** Add one recipe's ingredients (scaled) to the list, merging with items already there. */
export async function addRecipeToList(userId: string, recipeId: string, servings?: number, opts: { subtractPantry?: boolean } = {}) {
  const r = await getRecipe(userId, recipeId);
  const target = servings ?? r.servings;
  const list = await getActiveList(userId);
  const needs = await needsFor([{ recipeId, servings: target }], userId);
  const merged = consolidate(needs);
  const pantry = opts.subtractPantry === false ? [] : await prisma.pantryItem.findMany({ where: { userId } });
  const toAdd = subtractPantry(merged, pantry);
  let added = 0;
  for (const i of toAdd) {
    const existing = await prisma.groceryListItem.findFirst({ where: { listId: list.id, ingredientId: i.ingredientId, checked: false } });
    const qty = shoppingRound(i.quantity, i.unit);
    if (existing) {
      const q = existing.quantity + qty;
      const inr = estimatePrice(q, existing.unit, i.pricePer100, i.gramsPerPiece);
      await prisma.groceryListItem.update({ where: { id: existing.id }, data: { quantity: q, recipeTitles: [...new Set([...existing.recipeTitles, r.title])], estimatedPrice: inr === null ? existing.estimatedPrice : Math.round(convertFromInr(inr, list.currency) * 100) / 100 } });
    } else {
      const inr = estimatePrice(qty, i.unit, i.pricePer100, i.gramsPerPiece);
      await prisma.groceryListItem.create({ data: { listId: list.id, ingredientId: i.ingredientId, name: i.name, quantity: qty, unit: i.unit, category: i.category, fromMealPlan: false, recipeTitles: [r.title], estimatedPrice: inr === null ? null : Math.round(convertFromInr(inr, list.currency) * 100) / 100, currency: list.currency } });
    }
    added++;
  }
  return { added, skippedInPantry: merged.length - toAdd.length, recipe: r.title };
}

async function ownItem(userId: string, id: string) {
  const item = await prisma.groceryListItem.findUnique({ where: { id }, include: { list: true } });
  if (!item || item.list.userId !== userId) throw notFound("That item");
  return item;
}

export async function addManualItem(userId: string, i: { name: string; quantity?: number; unit?: string; category?: string }) {
  const list = await getActiveList(userId);
  const ing = await findIngredient(i.name);
  const q = toBaseQty(i.quantity ?? 1, i.unit ?? (ing?.defaultUnit ?? "pc"), ing);
  const category = i.category && (GROCERY_CATEGORIES as readonly string[]).includes(i.category) ? i.category : ing?.category ?? "Other";
  const inr = ing ? estimatePrice(q.quantity, q.unit, ing.pricePer100, ing.gramsPerPiece) : null;
  return prisma.groceryListItem.create({
    data: { listId: list.id, ingredientId: ing?.id ?? null, name: ing?.name ?? i.name.trim().replace(/^./, (c) => c.toUpperCase()), quantity: q.quantity, unit: q.unit, category, fromMealPlan: false, recipeTitles: [], estimatedPrice: inr === null ? null : Math.round(convertFromInr(inr, list.currency) * 100) / 100, currency: list.currency },
  });
}

export async function updateItem(userId: string, id: string, patch: { checked?: boolean; quantity?: number; unit?: string; category?: string; name?: string }) {
  const item = await ownItem(userId, id);
  const data: Record<string, unknown> = {};
  if (patch.checked !== undefined) data.checked = patch.checked;
  if (patch.category) {
    if (!(GROCERY_CATEGORIES as readonly string[]).includes(patch.category)) throw new AppError("Unknown category.");
    data.category = patch.category;
  }
  if (patch.name) data.name = patch.name.trim();
  if (patch.quantity !== undefined) {
    if (!(patch.quantity > 0)) throw new AppError("Enter a quantity greater than zero.");
    const ing = item.ingredientId ? await prisma.ingredient.findUnique({ where: { id: item.ingredientId } }) : null;
    const q = toBaseQty(patch.quantity, patch.unit ?? item.unit, ing ?? { defaultUnit: item.unit, gramsPerPiece: null });
    data.quantity = q.quantity;
    if (ing) {
      const inr = estimatePrice(q.quantity, q.unit, ing.pricePer100, ing.gramsPerPiece);
      if (inr !== null) data.estimatedPrice = Math.round(convertFromInr(inr, item.list.currency) * 100) / 100;
    }
  }
  return prisma.groceryListItem.update({ where: { id }, data });
}

export async function deleteItem(userId: string, id: string) {
  await ownItem(userId, id);
  await prisma.groceryListItem.delete({ where: { id } });
}

/** Remove checked items; optionally move them into the pantry (so the next generate subtracts them). */
export async function clearCompleted(userId: string, opts: { toPantry?: boolean } = {}) {
  const list = await getActiveList(userId);
  const done = await prisma.groceryListItem.findMany({ where: { listId: list.id, checked: true } });
  if (opts.toPantry) {
    const { addPantryItem } = await import("./pantry");
    for (const d of done) await addPantryItem(userId, { name: d.name, quantity: d.quantity, unit: d.unit });
  }
  await prisma.groceryListItem.deleteMany({ where: { listId: list.id, checked: true } });
  return done.length;
}

export async function clearList(userId: string) {
  const list = await getActiveList(userId);
  await prisma.groceryListItem.deleteMany({ where: { listId: list.id } });
}
