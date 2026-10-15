import { z } from "zod";
import { body, route, query } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { duplicateItem, editItem, moveItem, removeItem } from "@/server/services/meal-plan";

const mt = z.enum(["breakfast", "lunch", "dinner", "snack"]);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const DELETE = route(async ({ userId, req }) => {
  const { id } = query(req);
  if (!id) throw new AppError("Pick a meal first.");
  await removeItem(userId, id);
});

/** action: "move" | "duplicate" | "edit" */
export const PATCH = route(async ({ userId, req }) => {
  const d = await body(req, z.discriminatedUnion("action", [
    z.object({ action: z.literal("move"), id: z.string(), date: date.optional(), mealType: mt.optional() }),
    z.object({ action: z.literal("duplicate"), id: z.string(), date: date.optional(), mealType: mt.optional() }),
    z.object({ action: z.literal("edit"), id: z.string(), servings: z.number().min(0.25).max(50).optional(), portion: z.number().min(0.25).max(5).optional(), note: z.string().max(200).nullable().optional() }),
  ]));
  if (d.action === "move") await moveItem(userId, d.id, { date: d.date, mealType: d.mealType });
  else if (d.action === "duplicate") await duplicateItem(userId, d.id, { date: d.date, mealType: d.mealType });
  else await editItem(userId, d.id, { servings: d.servings, portion: d.portion, note: d.note });
});
