import { route } from "@/lib/api";
import { getPlan } from "@/server/services/subscription";
import { useSoon } from "@/server/services/pantry";

export const GET = route(async ({ userId }) => {
  if ((await getPlan(userId)) !== "pro") return { locked: true, groups: [] };
  return { locked: false, groups: await useSoon(userId) };
});
