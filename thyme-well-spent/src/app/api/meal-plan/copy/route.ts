import { z } from "zod";
import { body, route } from "@/lib/api";
import { dateOnly } from "@/lib/dates";
import { clearRange, copyRange } from "@/server/services/meal-plan";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const POST = route(async ({ userId, req }) => {
  const d = await body(req, z.object({ from: date, to: date, days: z.number().int().min(1).max(14) }));
  return { copied: await copyRange(userId, dateOnly(d.from), dateOnly(d.to), d.days) };
});
export const DELETE = route(async ({ userId, req }) => {
  const d = await body(req, z.object({ from: date, days: z.number().int().min(1).max(14) }));
  return { removed: await clearRange(userId, dateOnly(d.from), d.days) };
});
