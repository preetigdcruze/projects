import { z } from "zod";
import { body, route, query } from "@/lib/api";
import { dateOnly, startOfWeek } from "@/lib/dates";
import { AppError } from "@/lib/errors";
import { deleteTemplate, listTemplates, saveTemplate } from "@/server/services/meal-plan";

export const GET = route(async ({ userId }) => ({ templates: (await listTemplates(userId)).map((t) => ({ id: t.id, name: t.name, description: t.description, dayCount: t.dayCount, mealCount: (t.items as unknown[]).length })) }));
export const POST = route(async ({ userId, req }) => {
  const d = await body(req, z.object({ name: z.string().trim().min(1).max(60), weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), description: z.string().max(200).optional() }));
  const t = await saveTemplate(userId, d.name, startOfWeek(dateOnly(d.weekStart)), d.description);
  return { id: t.id };
});
export const DELETE = route(async ({ userId, req }) => {
  const { id } = query(req);
  if (!id) throw new AppError("Pick a template first.");
  await deleteTemplate(userId, id);
});
