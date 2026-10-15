import { z } from "zod";
import { body, route, query } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { deleteMealLog, logMeal } from "@/server/services/nutrition";

export const POST = route(async ({ userId, req }) => {
  const d = await body(req, z.object({
    mealPlanItemId: z.string().optional(), recipeId: z.string().optional(), mealType: z.enum(["breakfast", "lunch", "dinner", "snack"]).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), status: z.enum(["eaten", "skipped"]).optional(), consumedQuantity: z.number().min(0.1).max(10).optional(),
    notes: z.string().max(300).nullable().optional(), cooked: z.boolean().optional(),
  }));
  const log = await logMeal(userId, d);
  return { id: log.id, calories: log.calories, protein: log.protein, status: log.status };
});
export const DELETE = route(async ({ userId, req }) => {
  const { id } = query(req);
  if (!id) throw new AppError("Pick a log first.");
  await deleteMealLog(userId, id);
});
