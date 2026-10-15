import { route, query } from "@/lib/api";
import { alternativesFor } from "@/server/services/meal-plan";
import { AppError } from "@/lib/errors";

export const GET = route(async ({ userId, req }) => {
  const { itemId, vegetarian, highProtein, maxMinutes } = query(req);
  if (!itemId) throw new AppError("Pick a meal first.");
  return { alternatives: await alternativesFor(userId, itemId, { vegetarian: vegetarian === "1", highProtein: highProtein === "1", maxMinutes: maxMinutes ? Number(maxMinutes) : undefined }, 8) };
});
