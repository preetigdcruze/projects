import { route, query } from "@/lib/api";
import { deleteMyRecipe, recipeDetail } from "@/server/services/recipes";

export const GET = route<{ id: string }>(async ({ userId, req, params }) => {
  const s = query(req).servings;
  const d = await recipeDetail(userId, params.id, s ? Number(s) : undefined);
  const { recipe, ...rest } = d;
  return { ...rest, recipe: { id: recipe.id, title: recipe.title, servings: recipe.servings } };
});
export const DELETE = route<{ id: string }>(async ({ userId, params }) => { await deleteMyRecipe(userId, params.id); });
