import { z } from "zod";
import { body, route, query } from "@/lib/api";
import { createRecipe, searchRecipes } from "@/server/services/recipes";

export const GET = route(async ({ userId, req }) => {
  const q = query(req);
  const n = (v?: string) => (v ? Number(v) : undefined);
  return searchRecipes(userId, { q: q.q, collection: q.collection, cuisine: q.cuisine, mealType: q.mealType, diet: q.diet, maxTime: n(q.maxTime), maxCalories: n(q.maxCalories), minProtein: n(q.minProtein), tag: q.tag, sort: q.sort, page: n(q.page), pageSize: n(q.pageSize) });
});

const recipeSchema = z.object({
  title: z.string().trim().min(1).max(120), description: z.string().max(500).optional(), image: z.string().url().max(500).nullable().optional(), cuisine: z.string().max(40).optional(),
  mealTypes: z.array(z.enum(["breakfast", "lunch", "dinner", "snack", "dessert"])).optional(), servings: z.number().int().min(1).max(50), prepTime: z.number().int().min(0).max(1000), cookTime: z.number().int().min(0).max(1000),
  difficulty: z.enum(["easy", "medium", "hard"]).optional(), tags: z.array(z.string().max(30)).max(15).optional(), sourceUrl: z.string().url().nullable().optional(),
  ingredients: z.array(z.object({ name: z.string().trim().min(1).max(80), quantity: z.number().positive().max(100000), unit: z.enum(["g", "kg", "ml", "l", "tsp", "tbsp", "cup", "pc", "pinch"]), optional: z.boolean().optional(), note: z.string().max(80).optional() })).min(1).max(60),
  instructions: z.array(z.string().max(1000)).min(1).max(40),
  nutrition: z.object({ calories: z.number().min(0).max(5000).optional(), protein: z.number().min(0).optional(), carbs: z.number().min(0).optional(), fat: z.number().min(0).optional(), fiber: z.number().min(0).optional() }).nullable().optional(),
});

export const POST = route(async ({ userId, req }) => {
  const r = await createRecipe(userId, await body(req, recipeSchema));
  return { id: r.id };
});
