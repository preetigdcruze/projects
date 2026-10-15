import { z } from "zod";
import { body, route, query } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { addManualItem, deleteItem, updateItem } from "@/server/services/grocery";

export const POST = route(async ({ userId, req }) => {
  const d = await body(req, z.object({ name: z.string().trim().min(1).max(80), quantity: z.number().positive().max(100000).optional(), unit: z.enum(["g", "kg", "ml", "l", "pc"]).optional(), category: z.string().optional() }));
  return { id: (await addManualItem(userId, d)).id };
});
export const PATCH = route(async ({ userId, req }) => {
  const d = await body(req, z.object({ id: z.string(), checked: z.boolean().optional(), quantity: z.number().positive().max(100000).optional(), unit: z.enum(["g", "kg", "ml", "l", "pc"]).optional(), category: z.string().optional(), name: z.string().trim().min(1).max(80).optional() }));
  const { id, ...patch } = d;
  await updateItem(userId, id, patch);
});
export const DELETE = route(async ({ userId, req }) => {
  const { id } = query(req);
  if (!id) throw new AppError("Pick an item first.");
  await deleteItem(userId, id);
});
