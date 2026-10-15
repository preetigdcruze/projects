import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { AppError, notFound } from "@/lib/errors";
import { norm, isSafeForUser, matchesDiet, type RecipeFacts } from "@/lib/diet";
import { recipeTotals, perServing, isHighProtein } from "@/lib/nutrition";
import { toBase } from "@/lib/units";
import { scaleIngredients } from "@/lib/scale";
import { getUserContext } from "./context";

export const recipeInclude = { ingredients: { include: { ingredient: true }, orderBy: { position: "asc" as const } }, instructions: { orderBy: { step: "asc" as const } } } satisfies Prisma.RecipeInclude;
export type RecipeFull = Prisma.RecipeGetPayload<{ include: typeof recipeInclude }>;
export type PoolRecipe = Omit<RecipeFull, "ingredients" | "instructions"> & { facts: RecipeFacts };


export function toFacts(r: Omit<RecipeFull, "instructions">): RecipeFacts {
  let cost = 0;
  for (const i of r.ingredients) {
    if (i.optional) continue;
    const base = toBase(i.quantity, i.unit, i.ingredient);
    const grams = i.ingredient.defaultUnit === "pc" ? base * (i.ingredient.gramsPerPiece ?? 100) : base;
    cost += (grams / 100) * (i.ingredient.pricePer100 ?? 0);
  }
  return {
    id: r.id, title: r.title, cuisine: r.cuisine, mealTypes: r.mealTypes, dietType: r.dietType, totalTime: r.totalTime,
    calories: r.calories, protein: r.protein, carbs: r.carbs, fat: r.fat, tags: r.tags,
    ingredientIds: r.ingredients.map((i) => i.ingredientId),
    ingredientNames: r.ingredients.map((i) => i.ingredient.normalizedName),
    ingredientCategories: r.ingredients.map((i) => i.ingredient.category),
    costPerServing: Math.round((cost / Math.max(r.servings, 1)) * 10) / 10,
  };
}

/** All recipes a user may see: catalogue + their own. */
export async function getRecipePool(userId: string): Promise<{ recipe: RecipeFull; facts: RecipeFacts }[]> {
  const rows = await prisma.recipe.findMany({ where: { OR: [{ userId: null }, { userId }] }, include: recipeInclude });
  return rows.map((recipe) => ({ recipe, facts: toFacts(recipe) }));
}

export async function getRecipe(userId: string, id: string): Promise<RecipeFull> {
  const r = await prisma.recipe.findUnique({ where: { id }, include: recipeInclude });
  if (!r || (r.userId && r.userId !== userId)) throw notFound("That recipe");
  return r;
}

export type RecipeCard = {
  id: string; title: string; cuisine: string; mealTypes: string[]; dietType: string; totalTime: number; prepTime: number; cookTime: number;
  calories: number; protein: number; carbs: number; fat: number; rating: number; tags: string[]; image: string | null; isFavorite: boolean; isMine: boolean; difficulty: string; servings: number; description: string;
};

export const toCard = (r: { id: string; title: string; cuisine: string; mealTypes: string[]; dietType: string; totalTime: number; prepTime: number; cookTime: number; calories: number; protein: number; carbs: number; fat: number; rating: number; tags: string[]; image: string | null; userId: string | null; difficulty: string; servings: number; description: string }, favs: Set<string>): RecipeCard => ({
  id: r.id, title: r.title, cuisine: r.cuisine, mealTypes: r.mealTypes, dietType: r.dietType, totalTime: r.totalTime, prepTime: r.prepTime, cookTime: r.cookTime,
  calories: r.calories, protein: Math.round(r.protein), carbs: Math.round(r.carbs), fat: Math.round(r.fat), rating: r.rating, tags: r.tags, image: r.image,
  isFavorite: favs.has(r.id), isMine: !!r.userId, difficulty: r.difficulty, servings: r.servings, description: r.description,
});

export async function favoriteIds(userId: string) {
  const f = await prisma.favoriteRecipe.findMany({ where: { userId }, select: { recipeId: true } });
  return new Set(f.map((x) => x.recipeId));
}

// ───────────── Search ─────────────

export type SearchParams = {
  q?: string; collection?: string; cuisine?: string; mealType?: string; diet?: string;
  maxTime?: number; maxCalories?: number; minProtein?: number; tag?: string; sort?: string; page?: number; pageSize?: number;
};

/** Pulls structured filters out of natural language like "high protein vegetarian under 30 minutes". */
export function parseQuery(q: string) {
  let rest = ` ${q.toLowerCase()} `;
  const f: Partial<SearchParams> & { highProtein?: boolean; lowCal?: boolean } = {};
  const take = (re: RegExp, fn: (m: RegExpMatchArray) => void) => { const m = rest.match(re); if (m) { fn(m); rest = rest.replace(re, " "); } };
  take(/\b(?:under|below|less than|within|in|<)\s*(\d+)\s*(?:min|mins|minutes)\b/, (m) => (f.maxTime = +m[1]));
  take(/\b(\d+)\s*(?:min|mins|minute|minutes)\b/, (m) => (f.maxTime = f.maxTime ?? +m[1]));
  take(/\b(?:under|below|less than|<)\s*(\d+)\s*(?:cal|kcal|calories)\b/, (m) => (f.maxCalories = +m[1]));
  take(/\b(?:over|above|more than|at least)\s*(\d+)\s*g?\s*protein\b/, (m) => (f.minProtein = +m[1]));
  take(/\bhigh[- ]protein\b/, () => (f.highProtein = true));
  take(/\blow[- ]cal(?:orie)?s?\b/, () => (f.lowCal = true));
  take(/\bvegan\b/, () => (f.diet = "vegan"));
  take(/\bvegetarian\b|\bveg\b/, () => (f.diet = f.diet ?? "vegetarian"));
  take(/\beggetarian\b/, () => (f.diet = "eggetarian"));
  take(/\bpescatarian\b/, () => (f.diet = "pescatarian"));
  take(/\bquick\b|\bfast\b/, () => (f.maxTime = f.maxTime ?? 20));
  for (const m of ["breakfast", "lunch", "dinner", "snack", "dessert"]) take(new RegExp(`\\b${m}s?\\b`), () => (f.mealType = m));
  for (const c of ["indian", "italian", "mexican", "thai", "japanese", "american", "mediterranean", "middle eastern"]) take(new RegExp(`\\b${c}\\b`), () => (f.cuisine = c.replace(/\b\w/g, (x) => x.toUpperCase())));
  return { filters: f, text: rest.replace(/\s+/g, " ").trim() };
}

const COLLECTIONS: Record<string, (r: RecipeFull, f: RecipeFacts) => boolean> = {
  quick: (r) => r.totalTime <= 20,
  "high-protein": (r) => isHighProtein(r.protein, r.calories),
  "low-calorie": (r) => r.calories <= 350,
  vegetarian: (r) => ["vegan", "vegetarian", "eggetarian"].includes(r.dietType) && r.dietType !== "eggetarian",
  vegan: (r) => r.dietType === "vegan",
  breakfast: (r) => r.mealTypes.includes("breakfast"),
  lunch: (r) => r.mealTypes.includes("lunch"),
  dinner: (r) => r.mealTypes.includes("dinner"),
  snacks: (r) => r.mealTypes.includes("snack"),
  desserts: (r) => r.mealTypes.includes("dessert"),
};

export async function searchRecipes(userId: string, p: SearchParams) {
  const [pool, favs, ctx] = await Promise.all([getRecipePool(userId), favoriteIds(userId), getUserContext(userId)]);
  const parsed = p.q ? parseQuery(p.q) : { filters: {} as ReturnType<typeof parseQuery>["filters"], text: "" };
  const f = { ...parsed.filters, ...Object.fromEntries(Object.entries(p).filter(([k, v]) => v !== undefined && v !== "" && k !== "q")) } as SearchParams & { highProtein?: boolean; lowCal?: boolean };
  const text = norm(parsed.text);
  const terms = text.split(" ").filter(Boolean);

  let rows = pool.filter(({ recipe: r, facts }) => {
    if (f.collection === "favorites" && !favs.has(r.id)) return false;
    if (f.collection === "mine" && !r.userId) return false;
    if (f.collection && COLLECTIONS[f.collection] && !COLLECTIONS[f.collection](r, facts)) return false;
    if (f.cuisine && r.cuisine.toLowerCase() !== f.cuisine.toLowerCase()) return false;
    if (f.mealType && !r.mealTypes.includes(f.mealType)) return false;
    if (f.diet && !matchesDiet(facts, f.diet)) return false;
    if (f.maxTime && r.totalTime > f.maxTime) return false;
    if (f.maxCalories && r.calories > f.maxCalories) return false;
    if (f.minProtein && r.protein < f.minProtein) return false;
    if (f.highProtein && !isHighProtein(r.protein, r.calories)) return false;
    if (f.lowCal && r.calories > 400) return false;
    if (f.tag && !r.tags.includes(f.tag)) return false;
    if (terms.length) {
      const hay = norm([r.title, r.cuisine, r.description, ...r.tags, ...r.mealTypes, r.dietType, ...facts.ingredientNames].join(" "));
      if (!terms.every((t) => hay.includes(t.endsWith("s") && t.length > 3 ? t.slice(0, -1) : t))) return false;
    }
    return true;
  });

  const sort = f.sort ?? (f.collection === "popular" ? "popular" : text ? "relevance" : "recommended");
  const score = (x: (typeof rows)[number]) => {
    const r = x.recipe;
    let s = r.popularity / 100 + r.rating;
    if (favs.has(r.id)) s += 3;
    if (ctx.cuisines.includes(r.cuisine)) s += 2;
    if (isSafeForUser(x.facts, { diet: ctx.diet, exclusions: ctx.exclusions })) s += 4; else s -= 6;
    if (r.totalTime <= ctx.maxMinutes) s += 1;
    if (text && norm(r.title).includes(text)) s += 6;
    return s;
  };
  rows = rows.sort((a, b) => {
    switch (sort) {
      case "popular": return b.recipe.popularity - a.recipe.popularity;
      case "quickest": return a.recipe.totalTime - b.recipe.totalTime;
      case "protein": return b.recipe.protein - a.recipe.protein;
      case "calories": return a.recipe.calories - b.recipe.calories;
      case "rating": return b.recipe.rating - a.recipe.rating;
      case "newest": return b.recipe.createdAt.getTime() - a.recipe.createdAt.getTime();
      default: return score(b) - score(a);
    }
  });

  const pageSize = Math.min(p.pageSize ?? 24, 60);
  const page = Math.max(p.page ?? 1, 1);
  const slice = rows.slice((page - 1) * pageSize, page * pageSize);
  return { total: rows.length, page, pageSize, hasMore: page * pageSize < rows.length, items: slice.map((x) => toCard(x.recipe, favs)), appliedFilters: parsed.filters };
}

// ───────────── Detail with scaling ─────────────

export async function recipeDetail(userId: string, id: string, servings?: number) {
  const r = await getRecipe(userId, id);
  const target = Math.min(Math.max(servings ?? r.servings, 1), 50);
  const scaled = scaleIngredients(r.ingredients.map((i) => ({ ...i, quantity: i.quantity })), r.servings, target);
  const factor = target / r.servings;
  const fav = await prisma.favoriteRecipe.findUnique({ where: { userId_recipeId: { userId, recipeId: id } } });
  return {
    recipe: r, servings: target, isFavorite: !!fav,
    ingredients: scaled.map((i) => ({ id: i.id, name: i.ingredient.name, quantity: i.scaledQuantity, unit: i.unit, display: i.display, optional: i.optional, note: i.preparationNote, category: i.ingredient.category })),
    perServing: { calories: r.calories, protein: r.protein, carbs: r.carbs, fat: r.fat, fiber: r.fiber },
    total: { calories: Math.round(r.calories * target), protein: Math.round(r.protein * target), carbs: Math.round(r.carbs * target), fat: Math.round(r.fat * target), fiber: Math.round(r.fiber * target) },
    factor,
  };
}

// ───────────── Create custom ─────────────

export type NewRecipeInput = {
  title: string; description?: string; image?: string | null; cuisine?: string; mealTypes?: string[]; servings: number; prepTime: number; cookTime: number;
  difficulty?: string; tags?: string[]; sourceUrl?: string | null;
  ingredients: { name: string; quantity: number; unit: string; optional?: boolean; note?: string }[];
  instructions: string[];
  nutrition?: { calories?: number; protein?: number; carbs?: number; fat?: number; fiber?: number } | null; // per serving; computed if omitted
  dietType?: string;
};

const FISH = ["salmon", "prawn", "shrimp", "fish", "tuna", "cod"];
const MEAT = ["chicken", "mutton", "lamb", "beef", "pork", "bacon", "turkey", "ham"];
const DAIRY = ["milk", "cheese", "paneer", "yogurt", "curd", "butter", "ghee", "cream", "honey"];

export function inferDiet(names: string[]): string {
  const n = names.map(norm);
  const has = (list: string[]) => n.some((x) => list.some((w) => x.includes(w)));
  if (has(MEAT)) return "nonveg";
  if (has(FISH)) return "pescatarian";
  if (n.some((x) => x.includes("egg"))) return "eggetarian";
  if (has(DAIRY)) return "vegetarian";
  return "vegan";
}

const UNIT_BASE: Record<string, string> = { g: "g", kg: "g", ml: "ml", l: "ml", tsp: "ml", tbsp: "ml", cup: "ml", pinch: "g", pc: "pc" };

export async function createRecipe(userId: string, input: NewRecipeInput) {
  const own = await prisma.recipe.count({ where: { userId } });
  const { getPlan, LIMITS } = await import("./subscription");
  if (own >= LIMITS[await getPlan(userId)].customRecipes) throw new AppError("You've reached the free limit for My Recipes. Upgrade to Thyme Pro for unlimited recipes.", 402, "limit_reached");

  // resolve / create ingredients (relational — never a text blob)
  const resolved = [] as { ingredientId: string; ing: Awaited<ReturnType<typeof prisma.ingredient.findFirstOrThrow>>; row: NewRecipeInput["ingredients"][number] }[];
  for (const row of input.ingredients) {
    const nn = norm(row.name);
    if (!nn) continue;
    let ing = await prisma.ingredient.findUnique({ where: { normalizedName: nn } });
    if (!ing) {
      ing = await prisma.ingredient.create({ data: { name: row.name.trim().replace(/^./, (c) => c.toUpperCase()), normalizedName: nn, category: "Other", defaultUnit: UNIT_BASE[row.unit] ?? "g", gramsPerPiece: row.unit === "pc" ? 100 : null } });
    }
    resolved.push({ ingredientId: ing.id, ing, row });
  }
  if (!resolved.length) throw new AppError("Add at least one ingredient.");
  const computed = perServing(recipeTotals(resolved.map((x) => ({ quantity: x.row.quantity, unit: x.row.unit, optional: x.row.optional, ingredient: x.ing }))), input.servings);
  const n = { calories: input.nutrition?.calories ?? computed.calories, protein: input.nutrition?.protein ?? computed.protein, carbs: input.nutrition?.carbs ?? computed.carbs, fat: input.nutrition?.fat ?? computed.fat, fiber: input.nutrition?.fiber ?? computed.fiber };
  const slugBase = norm(input.title).replace(/\s+/g, "-") || "recipe";
  const slug = `${slugBase}-${Math.random().toString(36).slice(2, 8)}`;
  return prisma.recipe.create({
    data: {
      slug, userId, title: input.title.trim(), description: input.description ?? "", image: input.image || null, cuisine: input.cuisine || "Other",
      mealTypes: input.mealTypes?.length ? input.mealTypes : ["dinner"], dietType: input.dietType ?? inferDiet(resolved.map((x) => x.ing.name)),
      prepTime: input.prepTime, cookTime: input.cookTime, totalTime: input.prepTime + input.cookTime, servings: input.servings,
      calories: Math.round(n.calories), protein: n.protein, carbs: n.carbs, fat: n.fat, fiber: n.fiber,
      difficulty: input.difficulty ?? "easy", tags: input.tags ?? [], sourceUrl: input.sourceUrl ?? null, rating: 0, ratingCount: 0,
      ingredients: { create: resolved.map((x, i) => ({ ingredientId: x.ingredientId, quantity: x.row.quantity, unit: x.row.unit, optional: x.row.optional ?? false, preparationNote: x.row.note, position: i })) },
      instructions: { create: input.instructions.filter(Boolean).map((text, i) => ({ step: i + 1, text })) },
    },
  });
}

export async function toggleFavorite(userId: string, recipeId: string) {
  await getRecipe(userId, recipeId); // authz + existence
  const key = { userId_recipeId: { userId, recipeId } };
  const existing = await prisma.favoriteRecipe.findUnique({ where: key });
  if (existing) { await prisma.favoriteRecipe.delete({ where: key }); return false; }
  await prisma.favoriteRecipe.create({ data: { userId, recipeId } });
  return true;
}

export async function rateRecipe(userId: string, recipeId: string, stars: number) {
  await getRecipe(userId, recipeId);
  await prisma.recipeRating.upsert({ where: { userId_recipeId: { userId, recipeId } }, create: { userId, recipeId, stars }, update: { stars } });
}

export async function deleteMyRecipe(userId: string, id: string) {
  const r = await prisma.recipe.findUnique({ where: { id } });
  if (!r || r.userId !== userId) throw notFound("That recipe");
  const used = await prisma.mealPlanItem.count({ where: { recipeId: id } });
  const logged = await prisma.mealLog.count({ where: { recipeId: id } });
  if (used || logged) throw new AppError("This recipe is used in your plan or history, so it can't be deleted.", 409, "in_use");
  await prisma.recipe.delete({ where: { id } });
}
