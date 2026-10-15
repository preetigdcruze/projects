import { dateOnly, iso, startOfWeek, today, addDays } from "@/lib/dates";
import { requireUserId } from "@/lib/session";
import { getWeek, listTemplates } from "@/server/services/meal-plan";
import { WeekPlanner } from "./week-planner";

export const metadata = { title: "Meal plan" };
export const dynamic = "force-dynamic";

export default async function PlanPage({ searchParams }: { searchParams: Promise<{ week?: string; review?: string }> }) {
  const userId = await requireUserId();
  const sp = await searchParams;
  const weekStart = startOfWeek(sp.week && /^\d{4}-\d{2}-\d{2}$/.test(sp.week) ? dateOnly(sp.week) : today());
  const [days, templates] = await Promise.all([getWeek(userId, weekStart), listTemplates(userId)]);
  return (
    <WeekPlanner
      weekStart={iso(weekStart)} prevWeek={iso(addDays(weekStart, -7))} nextWeek={iso(addDays(weekStart, 7))} today={iso(today())} days={days} review={sp.review === "1"}
      templates={templates.map((t) => ({ id: t.id, name: t.name, mealCount: (t.items as unknown[]).length }))}
    />
  );
}
