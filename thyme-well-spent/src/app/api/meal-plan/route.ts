import { route, query } from "@/lib/api";
import { dateOnly, startOfWeek, today } from "@/lib/dates";
import { getWeek } from "@/server/services/meal-plan";

export const GET = route(async ({ userId, req }) => {
  const { start } = query(req);
  return { days: await getWeek(userId, start ? startOfWeek(dateOnly(start)) : startOfWeek(today())) };
});
