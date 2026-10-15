import { z } from "zod";
import { body, route } from "@/lib/api";
import { dateOnly } from "@/lib/dates";
import { applyTemplate } from "@/server/services/meal-plan";

export const POST = route(async ({ userId, req }) => {
  const d = await body(req, z.object({ id: z.string(), start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }));
  return { applied: await applyTemplate(userId, d.id, dateOnly(d.start)) };
});
