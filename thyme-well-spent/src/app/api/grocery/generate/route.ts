import { z } from "zod";
import { body, route } from "@/lib/api";
import { generateList } from "@/server/services/grocery";

export const POST = route(async ({ userId, req }) => generateList(userId, await body(req, z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), days: z.number().int().min(1).max(28).optional(), subtractPantry: z.boolean().optional() }))));
