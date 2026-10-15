import { z } from "zod";
import { body, route } from "@/lib/api";
import { addRecipeToList } from "@/server/services/grocery";

export const POST = route(async ({ userId, req }) => {
  const d = await body(req, z.object({ recipeId: z.string(), servings: z.number().min(1).max(50).optional(), subtractPantry: z.boolean().optional() }));
  return addRecipeToList(userId, d.recipeId, d.servings, { subtractPantry: d.subtractPantry });
});
