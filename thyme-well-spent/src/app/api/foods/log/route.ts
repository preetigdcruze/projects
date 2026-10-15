import { z } from "zod";
import { body, route, query } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { deleteFoodLog, logFood } from "@/server/services/nutrition";

export const POST = route(async ({ userId, req }) => {
  const d = await body(req, z.object({
    name: z.string().trim().min(1).max(120), mealType: z.enum(["breakfast", "lunch", "dinner", "snack"]), calories: z.number().min(0).max(5000),
    protein: z.number().min(0).max(500).optional(), carbs: z.number().min(0).max(800).optional(), fat: z.number().min(0).max(500).optional(), fiber: z.number().min(0).max(200).optional(),
    quantity: z.number().min(0.1).max(20).optional(), source: z.enum(["search", "manual", "scan"]).optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }));
  const l = await logFood(userId, d);
  return { id: l.id };
});
export const DELETE = route(async ({ userId, req }) => {
  const { id } = query(req);
  if (!id) throw new AppError("Pick an entry first.");
  await deleteFoodLog(userId, id);
});
