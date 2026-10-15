import { z } from "zod";
import { body, route } from "@/lib/api";
import { generatePlan } from "@/server/services/meal-plan";

const schema = z.object({
  days: z.number().int().min(1).max(14), startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  calories: z.union([z.literal("auto"), z.number().int().min(1000).max(6000)]).optional(), mealsPerDay: z.number().int().min(1).max(5).optional(),
  maxMinutes: z.number().int().min(5).max(240).optional(), budget: z.enum(["low", "medium", "flexible"]).optional(),
  cuisines: z.array(z.string()).max(12).optional(), diet: z.string().optional(), allergies: z.array(z.string().max(60)).max(30).optional(), avoid: z.array(z.string().max(60)).max(30).optional(),
  usePantry: z.boolean().optional(), variety: z.boolean().optional(), useLeftovers: z.boolean().optional(),
});
export const POST = route(async ({ userId, req }) => generatePlan(userId, await body(req, schema)));
