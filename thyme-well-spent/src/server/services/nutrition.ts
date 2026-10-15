import { prisma } from "@/lib/db";
import { AppError, notFound } from "@/lib/errors";
import { addDays, dateOnly, iso, sortMeals, startOfWeek, today, MEAL_ORDER } from "@/lib/dates";
import { remaining, scaleMacros, sumMacros, type Macros, type Targets } from "@/lib/nutrition";
import { assertOwnsItem, itemInclude, toItemView } from "./meal-plan";
import { getRecipe } from "./recipes";
import { getUserContext } from "./context";

const macrosOf = (x: { calories: number; protein: number; carbs: number; fat: number; fiber: number }): Macros => ({ calories: x.calories, protein: x.protein, carbs: x.carbs, fat: x.fat, fiber: x.fiber });

// ───────────── Logging ─────────────

export type LogMealInput = {
  mealPlanItemId?: string; recipeId?: string; mealType?: string; date?: string;
  status?: "eaten" | "skipped"; consumedQuantity?: number; notes?: string | null; cooked?: boolean;
};

/** Logs a planned meal (or an ad-hoc recipe). One log per plan item — logging again updates it. */
export async function logMeal(userId: string, input: LogMealInput) {
  const status = input.status ?? "eaten";
  const qty = input.consumedQuantity ?? 1;
  if (!(qty > 0 && qty <= 10)) throw new AppError("Enter a portion between 0.1 and 10.");

  let recipeId = input.recipeId;
  let mealType = input.mealType;
  let logDate = input.date ? dateOnly(input.date) : today();
  let itemId: string | undefined;
  if (input.mealPlanItemId) {
    const item = await assertOwnsItem(userId, input.mealPlanItemId);
    itemId = item.id; recipeId = item.recipeId; mealType = item.mealType; logDate = item.day.date;
  }
  if (!recipeId || !mealType) throw new AppError("Pick a meal to log.");
  if (!MEAL_ORDER.includes(mealType as never)) throw new AppError("Pick a meal type.");
  const recipe = await getRecipe(userId, recipeId);
  const m = status === "skipped" ? { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 } : scaleMacros(macrosOf(recipe), qty);
  const data = {
    userId, mealPlanItemId: itemId ?? null, recipeId, mealType, status, consumedQuantity: qty, consumedAt: new Date(), logDate,
    notes: input.notes ?? null, cooked: input.cooked ?? true, ...m,
  };
  if (itemId) {
    const existing = await prisma.mealLog.findFirst({ where: { userId, mealPlanItemId: itemId } });
    if (existing) return prisma.mealLog.update({ where: { id: existing.id }, data });
  }
  return prisma.mealLog.create({ data });
}

export async function deleteMealLog(userId: string, id: string) {
  const l = await prisma.mealLog.findUnique({ where: { id } });
  if (!l || l.userId !== userId) throw notFound("That log");
  await prisma.mealLog.delete({ where: { id } });
}

export type LogFoodInput = { name: string; mealType: string; calories: number; protein?: number; carbs?: number; fat?: number; fiber?: number; quantity?: number; source?: string; date?: string };

export async function logFood(userId: string, i: LogFoodInput) {
  if (!MEAL_ORDER.includes(i.mealType as never)) throw new AppError("Pick a meal type.");
  const q = i.quantity ?? 1;
  if (!(q > 0 && q <= 20)) throw new AppError("Enter a valid quantity.");
  const r1 = (n: number) => Math.round(n * 10) / 10;
  return prisma.foodLog.create({
    data: {
      userId, name: i.name.trim().slice(0, 120), mealType: i.mealType, source: i.source ?? "manual", quantity: q,
      logDate: i.date ? dateOnly(i.date) : today(), calories: Math.round(i.calories * q), protein: r1((i.protein ?? 0) * q),
      carbs: r1((i.carbs ?? 0) * q), fat: r1((i.fat ?? 0) * q), fiber: r1((i.fiber ?? 0) * q),
    },
  });
}

export async function deleteFoodLog(userId: string, id: string) {
  const l = await prisma.foodLog.findUnique({ where: { id } });
  if (!l || l.userId !== userId) throw notFound("That entry");
  await prisma.foodLog.delete({ where: { id } });
}

export async function searchFoods(q: string, limit = 12) {
  const term = q.trim();
  if (!term) return prisma.foodItem.findMany({ orderBy: { name: "asc" }, take: limit });
  return prisma.foodItem.findMany({ where: { name: { contains: term, mode: "insensitive" } }, orderBy: { name: "asc" }, take: limit });
}

// ───────────── Daily summary ─────────────

export async function daySummary(userId: string, date: Date) {
  const [meals, foods, ctx] = await Promise.all([
    prisma.mealLog.findMany({ where: { userId, logDate: date, status: "eaten" }, include: { recipe: { select: { title: true, cuisine: true, image: true } } }, orderBy: { consumedAt: "asc" } }),
    prisma.foodLog.findMany({ where: { userId, logDate: date }, orderBy: { loggedAt: "asc" } }),
    getUserContext(userId),
  ]);
  const consumed = sumMacros([...meals.map(macrosOf), ...foods.map(macrosOf)]);
  return { date: iso(date), meals, foods, consumed, targets: ctx.targets as Targets, remaining: remaining(ctx.targets, consumed) };
}

// ───────────── Progress ─────────────

export async function weeklyProgress(userId: string, end = today()) {
  const start = addDays(end, -6);
  const ctx = await getUserContext(userId);
  const [meals, foods, items] = await Promise.all([
    prisma.mealLog.findMany({ where: { userId, logDate: { gte: start, lte: end } } }),
    prisma.foodLog.findMany({ where: { userId, logDate: { gte: start, lte: end } } }),
    prisma.mealPlanItem.findMany({ where: { day: { date: { gte: start, lte: end }, mealPlan: { userId } } }, include: { logs: true, day: true } }),
  ]);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(start, i);
    const k = iso(d);
    const m = meals.filter((x) => iso(x.logDate) === k && x.status === "eaten");
    const f = foods.filter((x) => iso(x.logDate) === k);
    const totals = sumMacros([...m, ...f]);
    return { date: k, totals, logged: m.length + f.length > 0 };
  });
  const loggedDays = days.filter((d) => d.logged);
  const avg = (sel: (m: Macros) => number) => (loggedDays.length ? Math.round(loggedDays.reduce((a, d) => a + sel(d.totals), 0) / loggedDays.length) : 0);
  const planned = items.length;
  const eaten = items.filter((i) => i.logs.some((l) => l.status === "eaten")).length;
  const within = loggedDays.filter((d) => d.totals.calories >= ctx.targets.calories * 0.85 && d.totals.calories <= ctx.targets.calories * 1.15).length;
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) { if (days[i].logged) streak++; else if (i === days.length - 1) continue; else break; }
  return {
    days, targets: ctx.targets,
    averages: { calories: avg((m) => m.calories), protein: avg((m) => m.protein), carbs: avg((m) => m.carbs), fat: avg((m) => m.fat) },
    consistency: planned ? Math.round((eaten / planned) * 100) : null,
    plannedMeals: planned, eatenMeals: eaten,
    adherence: loggedDays.length ? Math.round((within / loggedDays.length) * 100) : null,
    daysLogged: loggedDays.length,
    cookedMeals: meals.filter((m) => m.status === "eaten" && m.cooked).length,
    streak,
  };
}

// ───────────── History ─────────────

export type HistoryRange = "today" | "yesterday" | "this_week" | "last_week" | "this_month";

export function rangeBounds(range: HistoryRange, now = today()) {
  switch (range) {
    case "today": return { from: now, to: now };
    case "yesterday": return { from: addDays(now, -1), to: addDays(now, -1) };
    case "this_week": return { from: startOfWeek(now), to: now };
    case "last_week": { const s = addDays(startOfWeek(now), -7); return { from: s, to: addDays(s, 6) }; }
    case "this_month": return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), to: now };
  }
}

export async function history(userId: string, range: HistoryRange) {
  const { from, to } = rangeBounds(range);
  const [meals, foods, ctx] = await Promise.all([
    prisma.mealLog.findMany({ where: { userId, logDate: { gte: from, lte: to } }, include: { recipe: { select: { id: true, title: true, cuisine: true, image: true } } }, orderBy: { consumedAt: "asc" } }),
    prisma.foodLog.findMany({ where: { userId, logDate: { gte: from, lte: to } }, orderBy: { loggedAt: "asc" } }),
    getUserContext(userId),
  ]);
  const days: { date: string; meals: typeof meals; foods: typeof foods; totals: Macros }[] = [];
  for (let d = to; d >= from; d = addDays(d, -1)) {
    const k = iso(d);
    const m = meals.filter((x) => iso(x.logDate) === k);
    const f = foods.filter((x) => iso(x.logDate) === k);
    if (m.length || f.length || range === "today" || range === "yesterday") days.push({ date: k, meals: sortMeals(m), foods: f, totals: sumMacros([...m.filter((x) => x.status === "eaten"), ...f]) });
  }
  return { from: iso(from), to: iso(to), days, targets: ctx.targets };
}

export { itemInclude, toItemView };
