import { z } from "zod";
import { body, route, query } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { addPantryItem, deletePantryItem, listPantry, updatePantryItem } from "@/server/services/pantry";

const unit = z.enum(["g", "kg", "ml", "l", "pc"]);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const GET = route(async ({ userId }) => ({ items: await listPantry(userId) }));
export const POST = route(async ({ userId, req }) => {
  const d = await body(req, z.object({ name: z.string().trim().min(1).max(80), quantity: z.number().positive().max(100000), unit, expiresAt: date.nullable().optional() }));
  return { id: (await addPantryItem(userId, d)).id };
});
export const PATCH = route(async ({ userId, req }) => {
  const d = await body(req, z.object({ id: z.string(), quantity: z.number().min(0).max(100000).optional(), unit: unit.optional(), expiresAt: date.nullable().optional(), name: z.string().trim().min(1).max(80).optional() }));
  const { id, ...patch } = d;
  await updatePantryItem(userId, id, patch);
});
export const DELETE = route(async ({ userId, req }) => {
  const { id } = query(req);
  if (!id) throw new AppError("Pick an item first.");
  await deletePantryItem(userId, id);
});
