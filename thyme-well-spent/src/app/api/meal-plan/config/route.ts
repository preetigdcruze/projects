import { route } from "@/lib/api";
import { defaultConfig } from "@/server/services/meal-plan";
export const GET = route(async ({ userId }) => defaultConfig(userId));
