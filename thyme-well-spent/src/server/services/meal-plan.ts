import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { AppError, notFound } from "@/lib/errors";
import { addDays, dateOnly, iso, MEAL_ORDER, sortMeals, startOfWeek, today } from "@/lib/dates";
import { isSafeForUser, matchesDiet, norm, type RecipeFacts } from "@/lib/diet";
import { rankAlternatives, type Scored } from "@/lib/swap";
import { sumMacros, isHighProtein } from "@/lib/nutrition";
import { getUserContext, type UserContext } from "./context";
import { getRecipe, getRecipePool, favoriteIds, toFacts, recipeInclude, type RecipeFull } from "./recipes";
import { assertCanGeneratePlan, recordPlanGenerated } from "./subscription";

export type GenerateConfig = {
  days: number;
  startDate?: string; // yyyy-mm-dd, defaults to today
  calories?: "auto" | number;
  mealsPerDay: number;
  maxMinutes: number;
  budget: "low" | "medium" | "flexible";
  weeklyBudget?: number; // in the user's currency; only used for planner caps
  cuisines: string[];
  diet?: string;
  allergies: string[];
  avoid: string[];
  usePantry: boolean;
  variety: boolean;
  useLeftovers: boolean;
  mealTypes?: string[]; // restrict to these meal types (assistant: "plan dinners…")
  seed?: number;
};

const SLOT_SETS: Record<number, string[]> = {
  1: ["dinner"],
  2: ["lunch", "dinner"],
  3: ["breakfast", "lunch", "dinner"],
  4: ["breakfast", "lunch", "snack", "dinner"],
  5: ["breakfast", "snack", "lunch", "snack", "dinner"],
};
const SHARE: Record<string, number> = { breakfast: 0.25, lunch: 0.3, dinner: 0.32, snack: 0.13 };

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const itemInclude = { recipe: true, logs: true, day: true } satisfies Prisma.MealPlanItemInclude;

// ───────────── Plan access ─────────────

export async function getActivePlan(userId: string, create = false) {
  let plan = await prisma.mealPlan.findFirst({ where: { userId, isActive: true }, orderBy: { createdAt: "desc" } });
  if (!plan && create) plan = await prisma.mealPlan.create({ data: { userId, name: "My plan" } });
  return plan;
}

async function ensureDay(planId: string, date: Date) {
  return prisma.mealPlanDay.upsert({ where: { mealPlanId_date: { mealPlanId: planId, date } }, create: { mealPlanId: planId, date }, update: {} });
}

/** Authorization gate: the item must belong to a plan owned by this user. */
export async function assertOwnsItem(userId: string, itemId: string) {
  const item = await prisma.mealPlanItem.findUnique({ where: { id: itemId }, include: { recipe: true, logs: true, day: { include: { mealPlan: true } } } });
  if (!item || item.day.mealPlan.userId !== userId) throw notFound("That meal");
  return item;
}

export type PlanItemView = {
  id: string; mealType: string; recipeId: string; title: string; cuisine: string; image: string | null; dietType: string;
  calories: number; protein: number; carbs: number; fat: number; prepTime: number; totalTime: number; portion: number; servings: number;
  isLeftover: boolean; status: "planned" | "eaten" | "skipped"; logId?: string; consumedQuantity?: number; note: string | null; date: string;
};

export function toItemView(i: Prisma.MealPlanItemGetPayload<{ include: typeof itemInclude }>): PlanItemView {
  const log = i.logs[0];
  return {
    id: i.id, mealType: i.mealType, recipeId: i.recipeId, title: i.recipe.title, cuisine: i.recipe.cuisine, image: i.recipe.image, dietType: i.recipe.dietType,
    calories: Math.round(i.recipe.calories * i.portion), protein: Math.round(i.recipe.protein * i.portion), carbs: Math.round(i.recipe.carbs * i.portion), fat: Math.round(i.recipe.fat * i.portion),
    prepTime: i.recipe.prepTime, totalTime: i.recipe.totalTime, portion: i.portion, servings: i.servings, isLeftover: i.isLeftover,
    status: log ? (log.status === "skipped" ? "skipped" : "eaten") : "planned", logId: log?.id, consumedQuantity: log?.consumedQuantity, note: i.note, date: iso(i.day.date),
  };
}

export async function getDayItems(userId: string, date: Date): Promise<PlanItemView[]> {
  const plan = await getActivePlan(userId);
  if (!plan) return [];
  const day = await prisma.mealPlanDay.findUnique({
    where: { mealPlanId_date: { mealPlanId: plan.id, date } },
    include: { items: { include: itemInclude, orderBy: { position: "asc" } } },
  });
  return day ? sortMeals(day.items.map(toItemView)) : [];
}

export async function getWeek(userId: string, weekStart: Date) {
  const plan = await getActivePlan(userId);
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const rows = plan
    ? await prisma.mealPlanDay.findMany({ where: { mealPlanId: plan.id, date: { gte: days[0], lte: days[6] } }, include: { items: { include: itemInclude, orderBy: { position: "asc" } } } })
    : [];
  return days.map((d) => {
    const row = rows.find((r) => iso(r.date) === iso(d));
    return { date: iso(d), items: row ? sortMeals(row.items.map(toItemView)) : [] };
  });
}

// ───────────── Generation ─────────────

export async function defaultConfig(userId: string): Promise<GenerateConfig> {
  const ctx = await getUserContext(userId);
  return {
    days: 7, mealsPerDay: Math.min(Math.max(ctx.mealTypes.length, 2), 4), maxMinutes: Math.max(15, ctx.maxMinutes), budget: (ctx.prefs?.budget as GenerateConfig["budget"]) ?? "medium",
    cuisines: ctx.cuisines, diet: ctx.diet, allergies: ctx.allergies, avoid: ctx.restrictions.map((r) => r.value), calories: "auto",
    usePantry: ctx.prefs?.usePantry ?? true, variety: ctx.prefs?.preferVariety ?? true, useLeftovers: ctx.prefs?.useLeftovers ?? true,
  };
}

type Pool = { recipe: RecipeFull; facts: RecipeFacts }[];

function costCap(budget: string) { return budget === "low" ? 90 : budget === "medium" ? 170 : Infinity; }

/** Pure planning algorithm: returns slots chosen per day. No DB access → easy to unit test. */
export function planDays(args: {
  pool: Pool; cfg: GenerateConfig; ctx: Pick<UserContext, "diet" | "exclusions" | "householdSize" | "targets" | "cuisines" | "prefs">;
  pantryIds: Set<string>; expiringIds: Set<string>; favs: Set<string>; occupied?: Set<string>; // "yyyy-mm-dd|mealType#idx" slots to skip
  start: Date; goals?: string[];
}) {
  const { pool, cfg, ctx } = args;
  const rng = mulberry32(cfg.seed ?? Date.now() % 100000);
  const diet = cfg.diet ?? ctx.diet;
  const exclusions = [...new Set([...ctx.exclusions, ...cfg.allergies.map(norm), ...cfg.avoid.map(norm)].filter(Boolean))];
  const dietCtx = { diet, exclusions };
  const dayCal = cfg.calories && cfg.calories !== "auto" ? cfg.calories : ctx.targets.calories;
  const slots = cfg.mealTypes?.length ? cfg.mealTypes : SLOT_SETS[Math.min(Math.max(cfg.mealsPerDay, 1), 5)];
  const rawShares = slots.map((s, i) => (s === "snack" && slots.filter((x) => x === "snack").length > 1 ? 0.1 : SHARE[s] ?? 0.3));
  const totalShare = rawShares.reduce((a, b) => a + b, 0);
  const wantsProtein = (args.goals ?? ctx.prefs?.goals ?? []).includes("gain_muscle") || diet === "high_protein";

  const safe = pool.filter((p) => isSafeForUser(p.facts, dietCtx));
  const used = new Map<string, number>(); // recipeId -> last day index used
  const plan: { dayIndex: number; mealType: string; recipeId: string; portion: number; servings: number; isLeftover: boolean; position: number }[] = [];
  const leftoverQueue = new Map<number, string>(); // dayIndex -> recipeId to serve as lunch leftovers

  for (let d = 0; d < cfg.days; d++) {
    let prevCuisine = "";
    slots.forEach((slot, si) => {
      const key = `${iso(addDays(args.start, d))}|${slot}#${slots.slice(0, si).filter((x) => x === slot).length}`;
      if (args.occupied?.has(key)) return;
      const slotTarget = (dayCal * rawShares[si]) / totalShare;
      const planPortion = (f: RecipeFacts) => Math.min(2, Math.max(0.5, Math.round((slotTarget / Math.max(f.calories, 1)) * 4) / 4));

      // leftovers scheduled from last night take the lunch slot
      if (slot === "lunch" && leftoverQueue.has(d)) {
        const rid = leftoverQueue.get(d)!;
        const f = pool.find((p) => p.recipe.id === rid)!;
        const portion = planPortion(f.facts);
        plan.push({ dayIndex: d, mealType: slot, recipeId: rid, portion, servings: portion * ctx.householdSize, isLeftover: true, position: si });
        prevCuisine = f.recipe.cuisine;
        return;
      }

      const slotType = slot;
      let cands = safe.filter((p) => p.recipe.mealTypes.includes(slotType) && p.recipe.totalTime <= cfg.maxMinutes);
      if (cands.length < 3) cands = safe.filter((p) => p.recipe.mealTypes.includes(slotType)); // relax time
      const styled = cands.filter((p) => matchesDiet(p.facts, diet));
      if (styled.length >= 3) cands = styled;
      if (!cands.length) throw new AppError(`We couldn't find ${slot} recipes that match your diet and exclusions. Try relaxing a filter.`, 422, "no_candidates");

      let best: { p: (typeof cands)[number]; score: number } | null = null;
      for (const p of cands) {
        const f = p.facts;
        const portion = planPortion(f);
        let score = 0;
        score += Math.max(0, 1 - Math.abs(f.calories * portion - slotTarget) / Math.max(slotTarget, 1)) * 30;
        score += f.totalTime <= cfg.maxMinutes ? 8 : -15;
        if (cfg.cuisines.includes(p.recipe.cuisine)) score += 8;
        if (args.favs.has(p.recipe.id)) score += 6;
        if (cfg.usePantry) {
          const owned = f.ingredientIds.filter((i) => args.pantryIds.has(i)).length;
          score += (owned / Math.max(f.ingredientIds.length, 1)) * 12;
          score += Math.min(2, f.ingredientIds.filter((i) => args.expiringIds.has(i)).length) * 5;
        }
        const cost = f.costPerServing ?? 0;
        if (cfg.budget === "low") score += cost > costCap("low") ? -25 : (costCap("low") - cost) / 9;
        else if (cfg.budget === "medium" && cost > costCap("medium")) score -= 10;
        if (cfg.weeklyBudget) {
          const perMeal = (cfg.weeklyBudget / Math.max(cfg.days * slots.length, 1)) / Math.max(ctx.householdSize, 1);
          if (cost > perMeal) score -= 12 + (cost - perMeal) / 4;
        }
        const last = used.get(p.recipe.id);
        if (last !== undefined) score -= cfg.variety ? 500 : last >= d - 2 ? 25 : 8;
        if (p.recipe.cuisine === prevCuisine) score -= 6;
        if (wantsProtein) score += Math.min(f.protein, 45) / 4;
        score += rng() * 8;
        if (!best || score > best.score) best = { p, score };
      }
      const chosen = best!.p;
      const portion = planPortion(chosen.facts);
      used.set(chosen.recipe.id, d);
      prevCuisine = chosen.recipe.cuisine;
      let servings = portion * ctx.householdSize;

      // cook-once, eat-twice: a big-batch dinner feeds tomorrow's lunch
      if (cfg.useLeftovers && slot === "dinner" && d < cfg.days - 1 && slots.includes("lunch") && chosen.recipe.mealTypes.includes("lunch") && chosen.recipe.servings >= servings * 2 && rng() < 0.45) {
        servings *= 2;
        leftoverQueue.set(d + 1, chosen.recipe.id);
      }
      plan.push({ dayIndex: d, mealType: slot, recipeId: chosen.recipe.id, portion, servings, isLeftover: false, position: si });
    });
  }
  return plan;
}

export async function generatePlan(userId: string, input: Partial<GenerateConfig> = {}) {
  await assertCanGeneratePlan(userId);
  const ctx = await getUserContext(userId);
  const base = await defaultConfig(userId);
  const cfg: GenerateConfig = { ...base, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as GenerateConfig;
  cfg.days = Math.min(Math.max(Math.round(cfg.days), 1), 14);
  const start = cfg.startDate ? dateOnly(cfg.startDate) : today();
  const [pool, favs, pantry] = await Promise.all([getRecipePool(userId), favoriteIds(userId), prisma.pantryItem.findMany({ where: { userId } })]);
  const soon = addDays(today(), 4);
  const pantryIds = new Set(pantry.map((p) => p.ingredientId).filter(Boolean) as string[]);
  const expiringIds = new Set(pantry.filter((p) => p.expiresAt && p.expiresAt <= soon && p.ingredientId).map((p) => p.ingredientId as string));

  const plan = await getActivePlan(userId, true);
  const dates = Array.from({ length: cfg.days }, (_, i) => addDays(start, i));
  // keep anything already logged; only replace unlogged items inside the range
  const existing = await prisma.mealPlanDay.findMany({ where: { mealPlanId: plan!.id, date: { in: dates } }, include: { items: { include: { logs: true } } } });
  const occupied = new Set<string>();
  const toDelete: string[] = [];
  const slotSet = new Set(cfg.mealTypes?.length ? cfg.mealTypes : SLOT_SETS[Math.min(Math.max(cfg.mealsPerDay, 1), 5)]);
  for (const day of existing) {
    const counts: Record<string, number> = {};
    for (const it of sortMeals(day.items.filter((x) => slotSet.has(x.mealType)))) {
      if (it.logs.length) { occupied.add(`${iso(day.date)}|${it.mealType}#${counts[it.mealType] ?? 0}`); counts[it.mealType] = (counts[it.mealType] ?? 0) + 1; }
      else toDelete.push(it.id);
    }
  }
  const chosen = planDays({ pool, cfg, ctx, pantryIds, expiringIds, favs, occupied, start, goals: ctx.prefs?.goals });

  await prisma.$transaction(async (tx) => {
    if (toDelete.length) await tx.mealPlanItem.deleteMany({ where: { id: { in: toDelete } } });
    const dayRows = new Map<number, string>();
    for (let i = 0; i < dates.length; i++) {
      const row = await tx.mealPlanDay.upsert({ where: { mealPlanId_date: { mealPlanId: plan!.id, date: dates[i] } }, create: { mealPlanId: plan!.id, date: dates[i] }, update: {} });
      dayRows.set(i, row.id);
    }
    await tx.mealPlanItem.createMany({ data: chosen.map((c) => ({ dayId: dayRows.get(c.dayIndex)!, mealType: c.mealType, recipeId: c.recipeId, servings: c.servings, portion: c.portion, isLeftover: c.isLeftover, position: c.position })) });
    await tx.mealPlan.update({ where: { id: plan!.id }, data: { name: `Plan from ${iso(start)}`, config: cfg as unknown as Prisma.InputJsonValue } });
  });
  await recordPlanGenerated(userId);
  return { planId: plan!.id, start: iso(start), days: cfg.days, itemCount: chosen.length };
}

// ───────────── Item operations ─────────────

async function nextPosition(dayId: string) {
  const agg = await prisma.mealPlanItem.aggregate({ where: { dayId }, _max: { position: true } });
  return (agg._max.position ?? -1) + 1;
}

export async function addItem(userId: string, a: { date: string; mealType: string; recipeId: string; servings?: number; portion?: number }) {
  if (!MEAL_ORDER.includes(a.mealType as never)) throw new AppError("Pick a meal type.");
  await getRecipe(userId, a.recipeId);
  const ctx = await getUserContext(userId);
  const plan = await getActivePlan(userId, true);
  const day = await ensureDay(plan!.id, dateOnly(a.date));
  const portion = a.portion ?? 1;
  return prisma.mealPlanItem.create({
    data: { dayId: day.id, mealType: a.mealType, recipeId: a.recipeId, portion, servings: a.servings ?? portion * ctx.householdSize, position: await nextPosition(day.id) },
    include: itemInclude,
  });
}

export async function removeItem(userId: string, itemId: string) {
  await assertOwnsItem(userId, itemId);
  await prisma.mealPlanItem.delete({ where: { id: itemId } });
}

export async function editItem(userId: string, itemId: string, patch: { servings?: number; portion?: number; note?: string | null }) {
  await assertOwnsItem(userId, itemId);
  return prisma.mealPlanItem.update({ where: { id: itemId }, data: patch, include: itemInclude });
}

export async function moveItem(userId: string, itemId: string, to: { date?: string; mealType?: string }) {
  const item = await assertOwnsItem(userId, itemId);
  if (item.logs.length) throw new AppError("This meal is already logged, so it can't be moved.", 409, "logged");
  const dayId = to.date ? (await ensureDay(item.day.mealPlanId, dateOnly(to.date))).id : item.dayId;
  return prisma.mealPlanItem.update({ where: { id: itemId }, data: { dayId, mealType: to.mealType ?? item.mealType, position: await nextPosition(dayId) }, include: itemInclude });
}

export async function duplicateItem(userId: string, itemId: string, to?: { date?: string; mealType?: string }) {
  const item = await assertOwnsItem(userId, itemId);
  const date = to?.date ? dateOnly(to.date) : addDays(item.day.date, 1);
  const day = await ensureDay(item.day.mealPlanId, date);
  return prisma.mealPlanItem.create({
    data: { dayId: day.id, mealType: to?.mealType ?? item.mealType, recipeId: item.recipeId, servings: item.servings, portion: item.portion, position: await nextPosition(day.id) },
    include: itemInclude,
  });
}

export async function replaceItem(userId: string, itemId: string, recipeId: string) {
  const item = await assertOwnsItem(userId, itemId);
  if (item.logs.length) throw new AppError("This meal is already logged, so it can't be swapped.", 409, "logged");
  await getRecipe(userId, recipeId);
  return prisma.mealPlanItem.update({ where: { id: itemId }, data: { recipeId, isLeftover: false }, include: itemInclude });
}

export type Constraints = { vegetarian?: boolean; vegan?: boolean; highProtein?: boolean; maxMinutes?: number; ingredient?: string; lowCalorie?: boolean; cuisine?: string };

export function passes(f: RecipeFacts, c?: Constraints) {
  if (!c) return true;
  if (c.vegan && f.dietType !== "vegan") return false;
  if (c.vegetarian && !["vegan", "vegetarian"].includes(f.dietType)) return false;
  if (c.highProtein && !isHighProtein(f.protein, f.calories)) return false;
  if (c.maxMinutes && f.totalTime > c.maxMinutes) return false;
  if (c.lowCalorie && f.calories > 400) return false;
  if (c.cuisine && f.cuisine.toLowerCase() !== c.cuisine.toLowerCase()) return false;
  if (c.ingredient && !f.ingredientNames.some((n) => n.includes(norm(c.ingredient!)))) return false;
  return true;
}

export type Alternative = { recipeId: string; title: string; cuisine: string; calories: number; protein: number; totalTime: number; image: string | null; dietType: string; score: number; reasons: string[] };

export async function alternativesFor(userId: string, itemId: string, constraints?: Constraints, limit = 6): Promise<Alternative[]> {
  const item = await assertOwnsItem(userId, itemId);
  const ctx = await getUserContext(userId);
  const [pool, favs, pantry, dayItems] = await Promise.all([
    getRecipePool(userId), favoriteIds(userId), prisma.pantryItem.findMany({ where: { userId } }),
    prisma.mealPlanItem.findMany({ where: { dayId: item.dayId }, select: { recipeId: true } }),
  ]);
  const byId = new Map(pool.map((p) => [p.recipe.id, p]));
  const cur = byId.get(item.recipeId)?.facts ?? toFacts((await getRecipe(userId, item.recipeId)) as RecipeFull);
  const soon = addDays(today(), 4);
  const candidates = pool.filter((p) => p.recipe.mealTypes.includes(item.mealType) && isSafeForUser(p.facts, { diet: ctx.diet, exclusions: ctx.exclusions }) && passes(p.facts, constraints)).map((p) => p.facts);
  const ranked: Scored[] = rankAlternatives(cur, candidates, {
    pantryIngredientIds: new Set(pantry.map((p) => p.ingredientId).filter(Boolean) as string[]),
    expiringIngredientIds: new Set(pantry.filter((p) => p.expiresAt && p.expiresAt <= soon && p.ingredientId).map((p) => p.ingredientId as string)),
    cuisines: ctx.cuisines, maxMinutes: ctx.maxMinutes, favoriteIds: favs, excludeRecipeIds: new Set(dayItems.map((d) => d.recipeId)),
  }, limit);
  return ranked.map((s) => {
    const r = byId.get(s.recipe.id)!.recipe;
    return { recipeId: r.id, title: r.title, cuisine: r.cuisine, calories: r.calories, protein: Math.round(r.protein), totalTime: r.totalTime, image: r.image, dietType: r.dietType, score: s.score, reasons: s.reasons };
  });
}

// ───────────── Day / week copy, templates ─────────────

export async function copyRange(userId: string, from: Date, to: Date, days: number) {
  const plan = await getActivePlan(userId, true);
  const src = await prisma.mealPlanDay.findMany({ where: { mealPlanId: plan!.id, date: { gte: from, lt: addDays(from, days) } }, include: { items: true } });
  let count = 0;
  for (const d of src) {
    const offset = Math.round((d.date.getTime() - from.getTime()) / 86400000);
    const target = await ensureDay(plan!.id, addDays(to, offset));
    for (const it of d.items) {
      await prisma.mealPlanItem.create({ data: { dayId: target.id, mealType: it.mealType, recipeId: it.recipeId, servings: it.servings, portion: it.portion, isLeftover: it.isLeftover, position: it.position } });
      count++;
    }
  }
  return count;
}

export async function saveTemplate(userId: string, name: string, weekStart: Date, description?: string) {
  const plan = await getActivePlan(userId);
  if (!plan) throw new AppError("There's no plan to save yet.");
  const days = await prisma.mealPlanDay.findMany({ where: { mealPlanId: plan.id, date: { gte: weekStart, lt: addDays(weekStart, 7) } }, include: { items: true } });
  const items = days.flatMap((d) => d.items.map((i) => ({ dayIndex: Math.round((d.date.getTime() - weekStart.getTime()) / 86400000), mealType: i.mealType, recipeId: i.recipeId, servings: i.servings, portion: i.portion })));
  if (!items.length) throw new AppError("That week has no meals to save.");
  return prisma.savedMealPlan.create({ data: { userId, name, description, items, dayCount: 7 } });
}

export const listTemplates = (userId: string) => prisma.savedMealPlan.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });

export async function deleteTemplate(userId: string, id: string) {
  const t = await prisma.savedMealPlan.findUnique({ where: { id } });
  if (!t || t.userId !== userId) throw notFound("That template");
  await prisma.savedMealPlan.delete({ where: { id } });
}

export async function applyTemplate(userId: string, id: string, start: Date) {
  const t = await prisma.savedMealPlan.findUnique({ where: { id } });
  if (!t || t.userId !== userId) throw notFound("That template");
  const items = t.items as { dayIndex: number; mealType: string; recipeId: string; servings: number; portion: number }[];
  const plan = await getActivePlan(userId, true);
  // replace unlogged meals in the target week
  const days = await prisma.mealPlanDay.findMany({ where: { mealPlanId: plan!.id, date: { gte: start, lt: addDays(start, t.dayCount) } }, include: { items: { include: { logs: true } } } });
  const del = days.flatMap((d) => d.items.filter((i) => !i.logs.length).map((i) => i.id));
  await prisma.mealPlanItem.deleteMany({ where: { id: { in: del } } });
  const valid = new Set((await prisma.recipe.findMany({ where: { id: { in: items.map((i) => i.recipeId) }, OR: [{ userId: null }, { userId }] }, select: { id: true } })).map((r) => r.id));
  let n = 0;
  for (const it of items) {
    if (!valid.has(it.recipeId)) continue;
    const day = await ensureDay(plan!.id, addDays(start, it.dayIndex));
    await prisma.mealPlanItem.create({ data: { dayId: day.id, mealType: it.mealType, recipeId: it.recipeId, servings: it.servings, portion: it.portion, position: await nextPosition(day.id) } });
    n++;
  }
  return n;
}

export async function clearRange(userId: string, from: Date, days: number) {
  const plan = await getActivePlan(userId);
  if (!plan) return 0;
  const rows = await prisma.mealPlanDay.findMany({ where: { mealPlanId: plan.id, date: { gte: from, lt: addDays(from, days) } }, include: { items: { include: { logs: true } } } });
  const ids = rows.flatMap((d) => d.items.filter((i) => !i.logs.length).map((i) => i.id));
  await prisma.mealPlanItem.deleteMany({ where: { id: { in: ids } } });
  return ids.length;
}

export const weekTotals = (items: PlanItemView[]) => sumMacros(items);
export { startOfWeek };
export { recipeInclude };
