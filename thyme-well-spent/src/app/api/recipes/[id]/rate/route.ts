import { z } from "zod";
import { body, route } from "@/lib/api";
import { rateRecipe } from "@/server/services/recipes";

export const POST = route<{ id: string }>(async ({ userId, req, params }) => {
  await rateRecipe(userId, params.id, (await body(req, z.object({ stars: z.number().int().min(1).max(5) }))).stars);
});
