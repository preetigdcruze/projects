import type { RecipeFacts } from "./diet";

export type SwapContext = {
  pantryIngredientIds: Set<string>;
  expiringIngredientIds?: Set<string>;
  cuisines: string[];
  maxMinutes?: number;
  favoriteIds?: Set<string>;
  excludeRecipeIds?: Set<string>;
};

export type Scored = { recipe: RecipeFacts; score: number; reasons: string[] };

const closeness = (a: number, b: number, tolerance: number) => Math.max(0, 1 - Math.abs(a - b) / tolerance);

/**
 * Rank candidate replacements. Priority order (matches product spec):
 * nutrition similarity → cooking time → user preferences → pantry → cuisine.
 * Dietary compatibility is applied BEFORE scoring as a hard filter by callers.
 */
export function scoreAlternative(current: RecipeFacts, cand: RecipeFacts, ctx: SwapContext): Scored {
  const reasons: string[] = [];
  const calSim = closeness(cand.calories, current.calories, Math.max(150, current.calories * 0.6));
  const proSim = closeness(cand.protein, current.protein, Math.max(12, current.protein * 0.8));
  const nutrition = (calSim * 0.6 + proSim * 0.4) * 40;
  if (calSim > 0.75 && proSim > 0.6) reasons.push("Similar protein and calories");
  else if (proSim > 0.8) reasons.push("Similar protein");
  else if (calSim > 0.85) reasons.push("Similar calories");

  const timeSim = closeness(cand.totalTime, current.totalTime, 40);
  let time = timeSim * 20;
  if (ctx.maxMinutes && cand.totalTime > ctx.maxMinutes) time -= 8;
  if (cand.totalTime <= (ctx.maxMinutes ?? current.totalTime) ) reasons.push(`Ready in ${cand.totalTime} minutes`);

  let pref = 0;
  if (ctx.favoriteIds?.has(cand.id)) { pref += 8; reasons.push("One of your favorites"); }
  if (ctx.cuisines.includes(cand.cuisine)) { pref += 7; reasons.push(`You like ${cand.cuisine} food`); }

  const owned = cand.ingredientIds.filter((i) => ctx.pantryIngredientIds.has(i)).length;
  const ownedShare = cand.ingredientIds.length ? owned / cand.ingredientIds.length : 0;
  let pantry = ownedShare * 15;
  const expiring = cand.ingredientIds.filter((i) => ctx.expiringIngredientIds?.has(i)).length;
  if (expiring) { pantry += 4; reasons.push("Uses ingredients that need using soon"); }
  else if (owned >= 2) reasons.push("Uses ingredients already in your pantry");

  const cuisine = cand.cuisine === current.cuisine ? 10 : ctx.cuisines.includes(cand.cuisine) ? 6 : 0;
  if (cand.cuisine === current.cuisine) reasons.push(`Same cuisine (${cand.cuisine})`);

  return { recipe: cand, score: Math.round((nutrition + time + pref + pantry + cuisine) * 10) / 10, reasons: [...new Set(reasons)].slice(0, 3) };
}

export function rankAlternatives(current: RecipeFacts, pool: RecipeFacts[], ctx: SwapContext, limit = 6): Scored[] {
  return pool
    .filter((r) => r.id !== current.id && !ctx.excludeRecipeIds?.has(r.id))
    .map((r) => scoreAlternative(current, r, ctx))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
