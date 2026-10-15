// All "date-only" values are handled as UTC midnight to avoid timezone drift between server & Postgres DATE columns.
export const MEAL_ORDER = ["breakfast", "lunch", "snack", "dinner"] as const;
export type MealType = (typeof MEAL_ORDER)[number];
export const MEAL_LABEL: Record<string, string> = { breakfast: "Breakfast", lunch: "Lunch", snack: "Snack", dinner: "Dinner" };

export function dateOnly(d: Date | string): Date {
  if (typeof d === "string") return new Date(`${d.slice(0, 10)}T00:00:00.000Z`);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}
/** Date-only for "now" in the server's timezone. */
export const today = () => dateOnly(new Date());
export const iso = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
export function startOfWeek(d: Date) {
  const day = d.getUTCDay(); // 0 Sun
  return addDays(d, -((day + 6) % 7));
}
export const sortMeals = <T extends { mealType: string }>(a: T[]) => [...a].sort((x, y) => MEAL_ORDER.indexOf(x.mealType as MealType) - MEAL_ORDER.indexOf(y.mealType as MealType));
export const formatLong = (d: Date) => d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
export const formatShort = (d: Date) => d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
export function greeting(hour: number) {
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}
