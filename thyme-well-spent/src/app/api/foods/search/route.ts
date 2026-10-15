import { route, query } from "@/lib/api";
import { searchFoods } from "@/server/services/nutrition";

export const GET = route(async ({ req }) => ({ foods: await searchFoods(query(req).q ?? "") }));
