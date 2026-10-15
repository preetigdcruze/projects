import { prisma } from "@/lib/db";
import { addDays, today } from "@/lib/dates";
import { isSafeForUser, matchesDiet, type RecipeFacts } from "@/lib/diet";
import { getUserContext } from "./context";
import { favoriteIds, getRecipePool, toCard, type RecipeCard } from "./recipes";

export type Section = { id: string; title: string; subtitle?: string; recipes: RecipeCard[] };

/** RecipeRecommendationService — behaviour-driven sections for Home. */
export async function homeSections(userId: string): Promise<Section[]> {
  const [ctx, pool, favs, pantry, recentLogs, recentFavs, trending] = await Promise.all([
    getUserContext(userId), getRecipePool(userId), favoriteIds(userId),
    prisma.pantryItem.findMany({ where: { userId, ingredientId: { not: null } } }),
    prisma.mealLog.findMany({ where: { userId, status: "eaten", logDate: { gte: addDays(today(), -30) } }, select: { recipeId: true } }),
    prisma.favoriteRecipe.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 5, include: { recipe: { select: { title: true, cuisine: true, tags: true } } } }),
    prisma.mealPlanItem.groupBy({ by: ["recipeId"], where: { day: { date: { gte: addDays(today(), -7) } } }, _count: { recipeId: true }, orderBy: { _count: { recipeId: "desc" } }, take: 30 }),
  ]);
  const dietCtx = { diet: ctx.diet, exclusions: ctx.exclusions };
  const safe = pool.filter((p) => isSafeForUser(p.facts, dietCtx));
  const card = (p: { recipe: Parameters<typeof toCard>[0] }) => toCard(p.recipe, favs);
  const seen = new Set<string>();
  const pick = (list: typeof safe, n = 8) => { const out = []; for (const p of list) { if (out.length >= n) break; out.push(p); } return out; };
  const sections: Section[] = [];

  // Because you liked …
  const lastFav = recentFavs[0]?.recipe;
  const loggedIds = new Set(recentLogs.map((l) => l.recipeId));
  if (lastFav) {
    const sim = safe.filter((p) => !favs.has(p.recipe.id) && (p.recipe.cuisine === lastFav.cuisine || p.recipe.tags.some((t) => lastFav.tags.includes(t)))).sort((a, b) => b.recipe.rating - a.recipe.rating);
    if (sim.length) sections.push({ id: "liked", title: `Because you liked ${lastFav.title}`, subtitle: "Similar flavours and styles", recipes: pick(sim).map(card) });
  } else if (loggedIds.size) {
    const cuisines = new Set(pool.filter((p) => loggedIds.has(p.recipe.id)).map((p) => p.recipe.cuisine));
    const sim = safe.filter((p) => cuisines.has(p.recipe.cuisine) && !loggedIds.has(p.recipe.id)).sort((a, b) => b.recipe.rating - a.recipe.rating);
    if (sim.length) sections.push({ id: "liked", title: "Because of what you've been eating", recipes: pick(sim).map(card) });
  }

  // Quick dinners
  const quick = safe.filter((p) => p.recipe.mealTypes.includes("dinner") && p.recipe.totalTime <= 25).sort((a, b) => a.recipe.totalTime - b.recipe.totalTime || b.recipe.rating - a.recipe.rating);
  sections.push({ id: "quick", title: "Quick dinners", subtitle: "Ready in 25 minutes or less", recipes: pick(quick).map(card) });

  // Goals
  const goals = ctx.prefs?.goals ?? [];
  let goalList: typeof safe; let goalTitle = "Based on your goals"; let goalSub = "Balanced meals near your targets";
  if (goals.includes("gain_muscle") || ctx.diet === "high_protein") { goalList = [...safe].sort((a, b) => b.recipe.protein - a.recipe.protein); goalSub = "High-protein picks"; }
  else if (goals.includes("lose_weight")) { goalList = safe.filter((p) => p.recipe.calories <= 450).sort((a, b) => b.recipe.protein / Math.max(b.recipe.calories, 1) - a.recipe.protein / Math.max(a.recipe.calories, 1)); goalSub = "Satisfying and lighter"; }
  else { const target = ctx.targets.calories / 3; goalList = [...safe].sort((a, b) => Math.abs(a.recipe.calories - target) - Math.abs(b.recipe.calories - target) || b.recipe.protein - a.recipe.protein); }
  sections.push({ id: "goals", title: goalTitle, subtitle: goalSub, recipes: pick(goalList).map(card) });

  // Use what you have
  if (pantry.length) {
    const have = new Set(pantry.map((p) => p.ingredientId as string));
    const soon = new Set(pantry.filter((p) => p.expiresAt && p.expiresAt <= addDays(today(), 4)).map((p) => p.ingredientId as string));
    const scored = safe.map((p) => ({ p, s: p.facts.ingredientIds.filter((i) => have.has(i)).length / Math.max(p.facts.ingredientIds.length, 1) + p.facts.ingredientIds.filter((i) => soon.has(i)).length * 0.15 })).filter((x) => x.s > 0.2).sort((a, b) => b.s - a.s);
    if (scored.length) sections.push({ id: "pantry", title: "Use what you have", subtitle: "Matches your pantry", recipes: pick(scored.map((x) => x.p)).map(card) });
  }

  // Popular this week
  const trendIds = new Map(trending.map((t) => [t.recipeId, t._count.recipeId]));
  const pop = [...safe].sort((a, b) => (trendIds.get(b.recipe.id) ?? 0) * 5 + b.recipe.popularity - ((trendIds.get(a.recipe.id) ?? 0) * 5 + a.recipe.popularity));
  sections.push({ id: "popular", title: "Popular this week", recipes: pick(pop).map(card) });

  // Try something new
  const tried = new Set(pool.filter((p) => loggedIds.has(p.recipe.id) || favs.has(p.recipe.id)).map((p) => p.recipe.cuisine));
  const fresh = safe.filter((p) => !tried.has(p.recipe.cuisine)).sort((a, b) => b.recipe.rating - a.recipe.rating);
  if (fresh.length) sections.push({ id: "new", title: "Try something new", subtitle: `Explore ${[...new Set(fresh.map((f) => f.recipe.cuisine))].slice(0, 3).join(", ")}`, recipes: pick(fresh).map(card) });

  // dedupe lightly across sections is intentionally skipped: overlap is fine, order matters.
  void seen; void matchesDiet;
  return sections.filter((s) => s.recipes.length);
}

export type { RecipeFacts };
