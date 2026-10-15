import { z } from "zod";
import { body, route, query } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { saveLeftovers, suggestSlots } from "@/server/services/leftovers";

export const GET = route(async ({ userId, req }) => {
  const { recipeId } = query(req);
  if (!recipeId) throw new AppError("Pick a recipe first.");
  return { slots: await suggestSlots(userId, recipeId) };
});
export const POST = route(async ({ userId, req }) => saveLeftovers(userId, await body(req, z.object({ recipeId: z.string(), servings: z.number().min(0.5).max(50), planDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), mealType: z.enum(["lunch", "dinner"]).optional() }))));
