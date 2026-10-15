import { prisma } from "@/lib/db";
import { AppError, notFound } from "@/lib/errors";
import { addDays, dateOnly, today } from "@/lib/dates";
import { norm, isSafeForUser } from "@/lib/diet";
import { toBase } from "@/lib/units";
import { getUserContext } from "./context";
import { getRecipePool, favoriteIds, toCard } from "./recipes";

const singular = (s: string) => (s.endsWith("ies") ? `${s.slice(0, -3)}y` : s.endsWith("oes") ? s.slice(0, -2) : s.endsWith("s") && !s.endsWith("ss") ? s.slice(0, -1) : s);

/** Match free text ("tomatoes", "Basmati Rice") to a catalogue ingredient. */
export async function findIngredient(name: string) {
  const n = norm(name);
  if (!n) return null;
  const variants = [...new Set([n, singular(n), `${n}s`])];
  const exact = await prisma.ingredient.findFirst({ where: { normalizedName: { in: variants } } });
  if (exact) return exact;
  const all = await prisma.ingredient.findMany();
  return all.find((i) => n.includes(i.normalizedName) || i.normalizedName.includes(singular(n))) ?? null;
}

export function toBaseQty(qty: number, unit: string, ing?: { defaultUnit: string; gramsPerPiece: number | null } | null) {
  if (ing) return { quantity: toBase(qty, unit, ing), unit: ing.defaultUnit };
  const u = unit.toLowerCase();
  if (u === "kg") return { quantity: qty * 1000, unit: "g" };
  if (u === "l") return { quantity: qty * 1000, unit: "ml" };
  if (u === "ml" || u === "g") return { quantity: qty, unit: u };
  return { quantity: qty, unit: "pc" };
}

export async function listPantry(userId: string) {
  const items = await prisma.pantryItem.findMany({ where: { userId }, orderBy: [{ expiresAt: { sort: "asc", nulls: "last" } }, { name: "asc" }] });
  const t = today().getTime();
  return items.map((i) => {
    const days = i.expiresAt ? Math.round((i.expiresAt.getTime() - t) / 86400000) : null;
    return { ...i, daysLeft: days, status: days === null ? "ok" : days < 0 ? "expired" : days <= 3 ? "use_soon" : "ok" };
  });
}

export type PantryInput = { name: string; quantity: number; unit: string; expiresAt?: string | null };

export async function addPantryItem(userId: string, i: PantryInput) {
  if (!(i.quantity > 0)) throw new AppError("Enter a quantity greater than zero.");
  const ing = await findIngredient(i.name);
  const q = toBaseQty(i.quantity, i.unit, ing);
  const expiresAt = i.expiresAt ? dateOnly(i.expiresAt) : null;
  if (ing) {
    const same = await prisma.pantryItem.findFirst({ where: { userId, ingredientId: ing.id, expiresAt } });
    if (same) return prisma.pantryItem.update({ where: { id: same.id }, data: { quantity: same.quantity + q.quantity } });
  }
  return prisma.pantryItem.create({
    data: { userId, ingredientId: ing?.id ?? null, name: ing?.name ?? i.name.trim().replace(/^./, (c) => c.toUpperCase()), quantity: q.quantity, unit: q.unit, category: ing?.category ?? "Other", expiresAt },
  });
}

export async function updatePantryItem(userId: string, id: string, patch: { quantity?: number; unit?: string; expiresAt?: string | null; name?: string }) {
  const item = await prisma.pantryItem.findUnique({ where: { id }, include: { ingredient: true } });
  if (!item || item.userId !== userId) throw notFound("That pantry item");
  const data: Record<string, unknown> = {};
  if (patch.quantity !== undefined) {
    if (patch.quantity <= 0) { await prisma.pantryItem.delete({ where: { id } }); return null; }
    data.quantity = toBaseQty(patch.quantity, patch.unit ?? item.unit, item.ingredient).quantity;
  }
  if (patch.expiresAt !== undefined) data.expiresAt = patch.expiresAt ? dateOnly(patch.expiresAt) : null;
  if (patch.name) data.name = patch.name;
  return prisma.pantryItem.update({ where: { id }, data });
}

export async function deletePantryItem(userId: string, id: string) {
  const item = await prisma.pantryItem.findUnique({ where: { id } });
  if (!item || item.userId !== userId) throw notFound("That pantry item");
  await prisma.pantryItem.delete({ where: { id } });
}

/** "Use soon" ingredients plus meals that would use them. */
export async function useSoon(userId: string, withinDays = 4, perItem = 5) {
  const soon = await prisma.pantryItem.findMany({ where: { userId, ingredientId: { not: null }, expiresAt: { lte: addDays(today(), withinDays) } }, orderBy: { expiresAt: "asc" } });
  if (!soon.length) return [];
  const [ctx, pool, favs] = await Promise.all([getUserContext(userId), getRecipePool(userId), favoriteIds(userId)]);
  return soon.map((p) => {
    const meals = pool
      .filter((r) => r.facts.ingredientIds.includes(p.ingredientId!) && isSafeForUser(r.facts, { diet: ctx.diet, exclusions: ctx.exclusions }))
      .sort((a, b) => b.recipe.popularity - a.recipe.popularity)
      .slice(0, perItem)
      .map((r) => toCard(r.recipe, favs));
    const days = Math.round((p.expiresAt!.getTime() - today().getTime()) / 86400000);
    return { item: { id: p.id, name: p.name, daysLeft: days }, meals };
  });
}

export async function mealsUsing(userId: string, ingredientName: string, limit = 5) {
  const ing = await findIngredient(ingredientName);
  if (!ing) return [];
  const [ctx, pool, favs] = await Promise.all([getUserContext(userId), getRecipePool(userId), favoriteIds(userId)]);
  return pool
    .filter((r) => r.facts.ingredientIds.includes(ing.id) && isSafeForUser(r.facts, { diet: ctx.diet, exclusions: ctx.exclusions }))
    .sort((a, b) => b.recipe.popularity - a.recipe.popularity)
    .slice(0, limit)
    .map((r) => toCard(r.recipe, favs));
}
