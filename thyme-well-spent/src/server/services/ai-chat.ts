import { prisma } from "@/lib/db";
import { AppError, notFound } from "@/lib/errors";
import { addDays, dateOnly, formatLong, iso, startOfWeek, today, MEAL_LABEL } from "@/lib/dates";
import { isSafeForUser } from "@/lib/diet";
import { toInr, formatMoney } from "@/lib/currency";
import { getProvider, TOOLS, type ChatMsg } from "@/server/ai";
import { getUserContext } from "./context";
import { findIngredient } from "./pantry";
import { favoriteIds, getRecipePool, toCard, type RecipeCard } from "./recipes";
import { addItem, alternativesFor, generatePlan, getDayItems, getWeek, passes, replaceItem, type Constraints } from "./meal-plan";
import { daySummary } from "./nutrition";
import { LIMITS, getPlan } from "./subscription";
import { mealsUsing } from "./pantry";

export type ToolResult = { summary: string; recipes?: RecipeCard[]; changed?: boolean };
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function resolveDay(input: unknown, now = today()): Date {
  const s = String(input ?? "today").toLowerCase();
  if (s === "today" || s === "tonight") return now;
  if (s === "tomorrow") return addDays(now, 1);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return dateOnly(s);
  const idx = WEEKDAYS.indexOf(s);
  if (idx >= 0) for (let i = 0; i < 7; i++) { const d = addDays(now, i); if (d.getUTCDay() === idx) return d; }
  return now;
}

const dayName = (d: Date) => (iso(d) === iso(today()) ? "today" : iso(d) === iso(addDays(today(), 1)) ? "tomorrow" : d.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }));
const possessive = (n: string) => (n === "today" || n === "tomorrow" ? `${n}'s` : `${n}'s`);
const describe = (c?: Constraints) => (c?.vegan ? "vegan" : c?.vegetarian ? "vegetarian" : c?.highProtein ? "high-protein" : c?.lowCalorie ? "lighter" : c?.maxMinutes ? `${c.maxMinutes}-minute` : c?.cuisine ? c.cuisine : "");

async function suggest(userId: string, a: { mealType?: string; ingredients?: string[]; constraints?: Constraints; limit?: number }): Promise<ToolResult> {
  const [ctx, pool, favs, today_] = await Promise.all([getUserContext(userId), getRecipePool(userId), favoriteIds(userId), daySummary(userId, today())]);
  const ids = new Set<string>();
  for (const name of a.ingredients ?? []) { const ing = await findIngredient(name); if (ing) ids.add(ing.id); }
  const mealType = a.mealType;
  const pantry = await prisma.pantryItem.findMany({ where: { userId, ingredientId: { not: null } } });
  const have = new Set(pantry.map((p) => p.ingredientId as string));
  const targetCal = mealType ? ctx.targets.calories * (mealType === "snack" ? 0.13 : 0.3) : today_.remaining.calories / 2;
  const scored = pool
    .filter((p) => isSafeForUser(p.facts, { diet: ctx.diet, exclusions: ctx.exclusions }) && (!mealType || p.recipe.mealTypes.includes(mealType)) && passes(p.facts, a.constraints))
    .map((p) => {
      const matches = p.facts.ingredientIds.filter((i) => ids.has(i)).length;
      let s = matches * 12 + (ids.size && matches === 0 ? -50 : 0);
      s += (p.facts.ingredientIds.filter((i) => have.has(i)).length / Math.max(p.facts.ingredientIds.length, 1)) * 5;
      s += p.recipe.rating + (ctx.cuisines.includes(p.recipe.cuisine) ? 3 : 0) + (favs.has(p.recipe.id) ? 2 : 0) + (p.recipe.totalTime <= ctx.maxMinutes ? 2 : 0);
      s -= Math.abs(p.recipe.calories - targetCal) / 100;
      return { p, s, matches };
    })
    .filter((x) => !ids.size || x.matches > 0)
    .sort((x, y) => y.s - x.s)
    .slice(0, a.limit ?? 4);
  if (!scored.length) return { summary: `I couldn't find ${describe(a.constraints) || ""} ${mealType ?? "meal"} ideas that fit your diet${ids.size ? " with those ingredients" : ""}. Try loosening a filter.`.replace(/\s+/g, " ") };
  const lead = ids.size ? `Here's what you can make with ${(a.ingredients ?? []).join(", ")}:` : mealType === "dinner" && !a.constraints ? "Here are a few dinner ideas that fit your day:" : `Here are ${scored.length} ${describe(a.constraints)} ${mealType ?? "meal"} ideas:`.replace(/\s+/g, " ");
  return { summary: `${lead}\n${scored.map((x) => `• ${x.p.recipe.title} — ${x.p.recipe.calories} kcal, ${Math.round(x.p.recipe.protein)}g protein, ${x.p.recipe.totalTime} min${x.matches > 1 ? ` (uses ${x.matches} of your ingredients)` : ""}`).join("\n")}`, recipes: scored.map((x) => toCard(x.p.recipe, favs)) };
}

async function replaceMeal(userId: string, a: { day?: string; mealType?: string; constraints?: Constraints }): Promise<ToolResult> {
  const date = resolveDay(a.day);
  const mealType = a.mealType ?? "dinner";
  const items = await getDayItems(userId, date);
  const target = items.find((i) => i.mealType === mealType && i.status === "planned");
  const dn = dayName(date);
  if (!target) {
    if (items.some((i) => i.mealType === mealType)) return { summary: `${possessive(dn)} ${mealType} is already logged, so I left it as is.` };
    return addMeal(userId, { day: a.day, mealType, constraints: a.constraints });
  }
  const alts = await alternativesFor(userId, target.id, a.constraints, 1);
  if (!alts.length) return { summary: `I couldn't find a ${describe(a.constraints)} ${mealType} that works for you, so ${possessive(dn)} ${target.title} stays.`.replace(/\s+/g, " ") };
  await replaceItem(userId, target.id, alts[0].recipeId);
  const flavour = describe(a.constraints);
  return { changed: true, summary: `Done. I replaced ${possessive(dn)} ${target.title} with ${alts[0].title}${flavour ? ` (${flavour})` : ""}. ${alts[0].reasons[0] ? `${alts[0].reasons[0]}.` : ""}`.trim() };
}

async function addMeal(userId: string, a: { day?: string; mealType?: string; query?: string; constraints?: Constraints }): Promise<ToolResult> {
  const [ctx, pool] = await Promise.all([getUserContext(userId), getRecipePool(userId)]);
  const date = resolveDay(a.day);
  const mealType = a.mealType ?? "dinner";
  const q = (a.query ?? "").toLowerCase().trim();
  const cands = pool.filter((p) => isSafeForUser(p.facts, { diet: ctx.diet, exclusions: ctx.exclusions }) && p.recipe.mealTypes.includes(mealType) && passes(p.facts, a.constraints));
  let pick = q ? cands.find((p) => p.recipe.title.toLowerCase().includes(q)) ?? cands.find((p) => p.facts.ingredientNames.some((n) => q.includes(n))) : undefined;
  pick ??= cands.sort((x, y) => y.recipe.rating + (ctx.cuisines.includes(y.recipe.cuisine) ? 2 : 0) - (x.recipe.rating + (ctx.cuisines.includes(x.recipe.cuisine) ? 2 : 0)))[0];
  if (!pick) return { summary: "I couldn't find a recipe that fits. Try describing it differently." };
  await addItem(userId, { date: iso(date), mealType, recipeId: pick.recipe.id });
  return { changed: true, summary: `Added ${pick.recipe.title} to ${possessive(dayName(date))} ${mealType}.` };
}

async function makeDayVegetarian(userId: string, a: { day?: string }): Promise<ToolResult> {
  const date = resolveDay(a.day);
  const items = await getDayItems(userId, date);
  const nonveg = items.filter((i) => !["vegan", "vegetarian"].includes(i.dietType) && i.status === "planned");
  const dn = dayName(date);
  if (!items.length) return { summary: `You don't have anything planned for ${dn} yet.` };
  if (!nonveg.length) return { summary: `${dn[0].toUpperCase() + dn.slice(1)} is already vegetarian.` };
  const done: string[] = [];
  for (const it of nonveg) {
    const alts = await alternativesFor(userId, it.id, { vegetarian: true }, 1);
    if (alts[0]) { await replaceItem(userId, it.id, alts[0].recipeId); done.push(`${MEAL_LABEL[it.mealType].toLowerCase()}: ${it.title} → ${alts[0].title}`); }
  }
  return { changed: done.length > 0, summary: done.length ? `Done — ${dn} is vegetarian now.\n${done.map((d) => `• ${d}`).join("\n")}` : "I couldn't find vegetarian swaps that fit." };
}

async function useUp(userId: string, a: { ingredient: string }): Promise<ToolResult> {
  const recipes = await mealsUsing(userId, a.ingredient, 5);
  if (!recipes.length) return { summary: `I couldn't find recipes that use ${a.ingredient} and fit your diet.` };
  const pantry = await prisma.pantryItem.findFirst({ where: { userId, name: { contains: a.ingredient, mode: "insensitive" } } });
  const soon = pantry?.expiresAt && pantry.expiresAt <= addDays(today(), 4);
  return { summary: `${soon ? `Your ${pantry!.name.toLowerCase()} needs using soon. ` : ""}Here are ${recipes.length} meals that use ${a.ingredient}:\n${recipes.map((r) => `• ${r.title} — ${r.calories} kcal, ${r.totalTime} min`).join("\n")}`, recipes };
}

async function planBudget(userId: string, a: { mealType?: string; days?: number; budget: number }): Promise<ToolResult> {
  const ctx = await getUserContext(userId);
  const mealType = a.mealType ?? "dinner";
  const days = Math.min(Math.max(Math.round(a.days ?? 7), 1), 14);
  const budgetInr = toInr(a.budget, ctx.currency);
  const res = await generatePlan(userId, { mealTypes: [mealType], days, weeklyBudget: budgetInr, budget: "low", variety: true, useLeftovers: false });
  const rows = await prisma.mealPlanItem.findMany({ where: { mealType, day: { date: { gte: dateOnly(res.start), lt: addDays(dateOnly(res.start), days) }, mealPlan: { userId, isActive: true } } }, include: { recipe: { include: { ingredients: { include: { ingredient: true } } } } } });
  const { toFacts } = await import("./recipes");
  const est = rows.reduce((t, r) => t + (toFacts(r.recipe).costPerServing ?? 0) * r.servings, 0);
  const estLocal = est * (ctx.currency === "INR" ? 1 : a.budget / budgetInr);
  const within = est <= budgetInr;
  return { changed: true, summary: `Done. I planned ${rows.length} ${mealType}${rows.length === 1 ? "" : "s"} over ${days} days. Estimated cost is about ${formatMoney(Math.round(estLocal), ctx.currency)}${within ? `, within your ${formatMoney(a.budget, ctx.currency)} budget.` : `, slightly above your ${formatMoney(a.budget, ctx.currency)} budget — it's the closest I could get with your diet and tastes.`} Estimates use typical prices.` };
}

export async function executeTool(userId: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const c = args.constraints as Constraints | undefined;
  switch (name) {
    case "replace_meal": return replaceMeal(userId, { day: args.day as string, mealType: args.mealType as string, constraints: c });
    case "make_day_vegetarian": return makeDayVegetarian(userId, { day: args.day as string });
    case "add_meal": return addMeal(userId, { day: args.day as string, mealType: args.mealType as string, query: args.query as string, constraints: c });
    case "suggest_meals": return suggest(userId, { mealType: args.mealType as string, ingredients: args.ingredients as string[], constraints: c });
    case "use_up_ingredient": return useUp(userId, { ingredient: String(args.ingredient ?? "") });
    case "plan_budget_meals": return planBudget(userId, { mealType: args.mealType as string, days: args.days as number, budget: Number(args.budget) });
    default: return { summary: "I'm not sure how to do that yet." };
  }
}

async function systemPrompt(userId: string) {
  const ctx = await getUserContext(userId);
  const week = await getWeek(userId, startOfWeek(today()));
  const sum = await daySummary(userId, today());
  const pantry = await prisma.pantryItem.findMany({ where: { userId }, take: 40 });
  return [
    "You are Thyme, a warm, concise meal-planning and nutrition assistant. Never give medical advice; calorie figures are estimates.",
    "Only modify the plan with tools when the user explicitly asks. For questions, suggest meals (suggest_meals / use_up_ingredient). Keep replies short.",
    `Today is ${formatLong(today())}. User: ${ctx.name}. Diet: ${ctx.diet}. Avoids: ${ctx.exclusions.join(", ") || "nothing"}. Household: ${ctx.householdSize}. Max cook time: ${ctx.maxMinutes} min. Currency: ${ctx.currency}.`,
    `Targets/day: ${ctx.targets.calories} kcal, ${ctx.targets.proteinG}g protein. Eaten today: ${sum.consumed.calories} kcal, ${Math.round(sum.consumed.protein)}g protein.`,
    `Pantry: ${pantry.map((p) => p.name).join(", ") || "empty"}.`,
    `This week's plan:\n${week.map((d) => `${d.date}: ${d.items.map((i) => `${i.mealType}=${i.title}`).join("; ") || "-"}`).join("\n")}`,
  ].join("\n");
}

export type ChatResult = { conversationId: string; reply: string; recipes: RecipeCard[]; changed: boolean };

export async function chat(userId: string, input: { message: string; conversationId?: string }): Promise<ChatResult> {
  const message = input.message.trim().slice(0, 1000);
  if (!message) throw new AppError("Type a message first.");
  const plan = await getPlan(userId);
  if (plan === "free") {
    const used = await prisma.aIMessage.count({ where: { role: "user", createdAt: { gte: addDays(new Date(), -30) }, conversation: { userId } } });
    if (used >= LIMITS.free.assistantMessagesPerMonth) throw new AppError("You've used your free assistant messages for this month. Upgrade to Thyme Pro for unlimited chat.", 402, "limit_reached");
  }
  let conv = input.conversationId ? await prisma.aIConversation.findUnique({ where: { id: input.conversationId } }) : null;
  if (input.conversationId && (!conv || conv.userId !== userId)) throw notFound("That conversation");
  conv ??= await prisma.aIConversation.create({ data: { userId, title: message.slice(0, 50) } });
  const history = await prisma.aIMessage.findMany({ where: { conversationId: conv.id }, orderBy: { createdAt: "desc" }, take: 8 });
  await prisma.aIMessage.create({ data: { conversationId: conv.id, role: "user", content: message } });

  const msgs: ChatMsg[] = [...history.reverse().map((m) => ({ role: m.role as "user" | "assistant", content: m.content })), { role: "user", content: message }];
  const result = await getProvider().respond({ system: await systemPrompt(userId), messages: msgs, tools: TOOLS });

  const parts: string[] = [];
  if (result.text) parts.push(result.text);
  const recipes: RecipeCard[] = [];
  let changed = false;
  for (const call of result.toolCalls.slice(0, 3)) {
    try {
      const r = await executeTool(userId, call.name, call.args);
      parts.push(r.summary);
      if (r.recipes) recipes.push(...r.recipes);
      changed ||= !!r.changed;
    } catch (e) {
      parts.push(e instanceof AppError ? e.message : "Sorry, I couldn't do that just now.");
    }
  }
  const reply = parts.filter(Boolean).join("\n\n") || "I'm not sure how to help with that yet.";
  await prisma.aIMessage.create({ data: { conversationId: conv.id, role: "assistant", content: reply, actions: { recipes, changed } as never } });
  return { conversationId: conv.id, reply, recipes, changed };
}

export async function getConversation(userId: string, id?: string) {
  const conv = id
    ? await prisma.aIConversation.findUnique({ where: { id }, include: { messages: { orderBy: { createdAt: "asc" } } } })
    : await prisma.aIConversation.findFirst({ where: { userId }, orderBy: { createdAt: "desc" }, include: { messages: { orderBy: { createdAt: "asc" } } } });
  if (!conv) return null;
  if (conv.userId !== userId) throw notFound("That conversation");
  return conv;
}
