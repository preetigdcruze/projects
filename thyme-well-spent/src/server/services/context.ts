import { prisma } from "@/lib/db";
import { estimateTargets, type Targets } from "@/lib/nutrition";
import { norm } from "@/lib/diet";

export type UserContext = Awaited<ReturnType<typeof getUserContext>>;

export async function getUserContext(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { profile: true, preference: true, goal: true, restrictions: true, allergies: true, subscription: true },
  });
  const prefs = user.preference;
  const profile = user.profile;
  const exclusions = [
    ...user.allergies.map((a) => a.name),
    ...user.restrictions.map((r) => r.value),
  ].map(norm).filter(Boolean);
  const targets: Targets = user.goal
    ? { calories: user.goal.calories, proteinG: user.goal.proteinG, carbsG: user.goal.carbsG, fatG: user.goal.fatG }
    : estimateTargets({ ...profile, goals: prefs?.goals, dietType: prefs?.dietType });
  return {
    userId,
    name: user.name ?? "there",
    email: user.email,
    onboarded: user.onboarded,
    profile,
    prefs,
    goal: user.goal,
    targets,
    diet: prefs?.dietType ?? "everything",
    exclusions: [...new Set(exclusions)],
    allergies: user.allergies.map((a) => a.name),
    restrictions: user.restrictions,
    householdSize: prefs?.householdSize ?? 1,
    maxMinutes: prefs?.maxCookMinutes ?? 30,
    cuisines: prefs?.cuisines ?? [],
    mealTypes: prefs?.mealTypes?.length ? prefs.mealTypes : ["breakfast", "lunch", "dinner"],
    currency: profile?.currency ?? "INR",
    units: profile?.units ?? "metric",
    plan: user.subscription?.plan ?? "free",
    subscription: user.subscription,
  };
}
