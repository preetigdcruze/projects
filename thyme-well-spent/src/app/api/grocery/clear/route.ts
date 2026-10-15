import { z } from "zod";
import { body, route } from "@/lib/api";
import { clearCompleted, clearList } from "@/server/services/grocery";

export const POST = route(async ({ userId, req }) => {
  const d = await body(req, z.object({ all: z.boolean().optional(), toPantry: z.boolean().optional() }));
  if (d.all) { await clearList(userId); return { cleared: "all" }; }
  return { cleared: await clearCompleted(userId, { toPantry: d.toPantry }) };
});
