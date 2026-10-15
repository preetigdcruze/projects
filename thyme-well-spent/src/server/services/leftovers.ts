import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { addDays, dateOnly, iso, today } from "@/lib/dates";
import { addItem, getActivePlan } from "./meal-plan";
import { getRecipe } from "./recipes";

/** After cooking, suggest where leftovers could fit: upcoming lunch/dinner slots that are empty or have a different dish. */
export async function suggestSlots(userId: string, recipeId: string) {
  await getRecipe(userId, recipeId);
  const plan = await getActivePlan(userId);
  const out: { date: string; mealType: string; label: string }[] = [];
  const base = today();
  for (let i = 1; i <= 4 && out.length < 3; i++) {
    const d = addDays(base, i);
    const day = plan ? await prisma.mealPlanDay.findUnique({ where: { mealPlanId_date: { mealPlanId: plan.id, date: d } }, include: { items: true } }) : null;
    const hasLunch = day?.items.some((x) => x.mealType === "lunch");
    out.push({ date: iso(d), mealType: "lunch", label: `${d.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })} lunch${hasLunch ? " (add alongside)" : ""}` });
  }
  return out;
}

export async function saveLeftovers(userId: string, a: { recipeId: string; servings: number; planDate?: string; mealType?: string }) {
  if (!(a.servings > 0)) throw new AppError("Enter how many servings are left over.");
  await getRecipe(userId, a.recipeId);
  const l = await prisma.leftover.create({ data: { userId, recipeId: a.recipeId, servings: a.servings, cookedOn: today() } });
  let planned = null;
  if (a.planDate) {
    const item = await addItem(userId, { date: a.planDate, mealType: a.mealType ?? "lunch", recipeId: a.recipeId, servings: a.servings, portion: 1 });
    await prisma.mealPlanItem.update({ where: { id: item.id }, data: { isLeftover: true } });
    await prisma.leftover.update({ where: { id: l.id }, data: { usedUp: true } });
    planned = { itemId: item.id, date: iso(dateOnly(a.planDate)) };
  }
  return { leftoverId: l.id, planned };
}

export const openLeftovers = (userId: string) => prisma.leftover.findMany({ where: { userId, usedUp: false }, include: { recipe: { select: { id: true, title: true } } }, orderBy: { cookedOn: "desc" } });
