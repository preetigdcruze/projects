import { prisma } from "@/lib/db";
import { requireUserId } from "@/lib/session";
import { getUserContext } from "@/server/services/context";
import { usageSummary } from "@/server/services/subscription";
import { ProfileView } from "./profile-view";

export const metadata = { title: "Profile" };
export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const userId = await requireUserId();
  const [c, sub, u] = await Promise.all([getUserContext(userId), usageSummary(userId), prisma.user.findUnique({ where: { id: userId }, select: { image: true } })]);
  return (
    <ProfileView
      plan={sub.plan}
      data={{
        name: c.name, email: c.email ?? "", image: u?.image ?? null,
        goals: c.prefs?.goals ?? [], dietType: c.diet, allergies: c.allergies, avoid: c.restrictions.filter((r) => r.kind === "avoid" || r.kind === "intolerance").map((r) => r.value), dislikes: c.restrictions.filter((r) => r.kind === "dislike").map((r) => r.value),
        cuisines: c.cuisines, maxCookMinutes: c.maxMinutes, householdSize: c.householdSize, mealTypes: c.mealTypes, budget: c.prefs?.budget ?? "medium",
        sex: c.profile?.sex ?? null, age: c.profile?.age ?? null, heightCm: c.profile?.heightCm ?? null, weightKg: c.profile?.weightKg ?? null, activityLevel: c.profile?.activityLevel ?? "moderate",
        units: c.units, currency: c.currency, theme: c.profile?.theme ?? "system", nutritionMode: c.goal?.mode ?? "auto", targets: c.targets,
      }}
    />
  );
}
