import { z } from "zod";
import { body, route } from "@/lib/api";
import { createRecipe } from "@/server/services/recipes";
import { getImporter } from "@/server/services/importer";

/** Without `save`, returns the parsed draft for review. With `save`, stores it in My Recipes. */
export const POST = route(async ({ userId, req }) => {
  const d = await body(req, z.object({ url: z.string().url(), save: z.boolean().optional() }));
  const draft = await getImporter().import(d.url);
  if (!d.save) return { draft };
  const r = await createRecipe(userId, { ...draft, tags: [...(draft.tags ?? []), "imported"] });
  return { id: r.id };
});
