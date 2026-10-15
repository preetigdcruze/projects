import { z } from "zod";
import { body, route } from "@/lib/api";
import { addItem } from "@/server/services/meal-plan";

export const POST = route(async ({ userId, req }) => {
  const d = await body(req, z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), mealType: z.enum(["breakfast", "lunch", "dinner", "snack"]), recipeId: z.string(), servings: z.number().min(0.25).max(50).optional(), portion: z.number().min(0.25).max(5).optional() }));
  const item = await addItem(userId, d);
  return { id: item.id };
});
