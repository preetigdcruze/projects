import { z } from "zod";
import { body, route } from "@/lib/api";
import { replaceItem } from "@/server/services/meal-plan";

export const POST = route(async ({ userId, req }) => {
  const { itemId, recipeId } = await body(req, z.object({ itemId: z.string(), recipeId: z.string() }));
  await replaceItem(userId, itemId, recipeId);
  return { ok: true };
});
