import { requireUserId } from "@/lib/session";
import { prisma } from "@/lib/db";
import { getUserContext } from "@/server/services/context";
import { SettingsView } from "./settings-view";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const userId = await requireUserId();
  const [c, n] = await Promise.all([getUserContext(userId), prisma.notificationPreference.upsert({ where: { userId }, create: { userId }, update: {} })]);
  return <SettingsView units={c.units} currency={c.currency} theme={c.profile?.theme ?? "system"} email={c.email ?? ""} notifications={{ enabled: n.enabled, morningMeal: n.morningMeal, mealReminder: n.mealReminder, groceryReminder: n.groceryReminder, weeklyPlanning: n.weeklyPlanning, expiring: n.expiring, mealPrep: n.mealPrep }} prefs={{ usePantry: c.prefs?.usePantry ?? true, preferVariety: c.prefs?.preferVariety ?? true, useLeftovers: c.prefs?.useLeftovers ?? true }} />;
}
