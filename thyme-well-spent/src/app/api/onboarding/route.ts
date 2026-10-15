import { z } from "zod";
import { prisma } from "@/lib/db";
import { body, route } from "@/lib/api";
import { estimateTargets } from "@/lib/nutrition";
import { norm } from "@/lib/diet";

const list = z.array(z.string().trim().min(1).max(60)).max(40).default([]);
const onboardingSchema = z.object({
  goals: list, diet: z.string().default("everything"), allergies: list, intolerances: list, avoid: list, dislikes: list, cuisines: list, lovedIngredients: list,
  maxCookMinutes: z.number().int().min(5).max(240).default(30), householdSize: z.number().int().min(1).max(12).default(1),
  mealTypes: z.array(z.enum(["breakfast", "lunch", "dinner", "snack"])).min(1).default(["breakfast", "lunch", "dinner"]),
  nutritionMode: z.enum(["auto", "custom"]).default("auto"),
  sex: z.enum(["female", "male", "other"]).optional(), age: z.number().int().min(14).max(100).optional(),
  heightCm: z.number().min(100).max(250).optional(), weightKg: z.number().min(30).max(300).optional(),
  activityLevel: z.enum(["sedentary", "light", "moderate", "active", "very_active"]).default("moderate"),
  calories: z.number().int().min(1000).max(6000).optional(), proteinG: z.number().int().min(0).max(500).optional(),
  carbsG: z.number().int().min(0).max(800).optional(), fatG: z.number().int().min(0).max(300).optional(),
  units: z.enum(["metric", "imperial"]).default("metric"), currency: z.enum(["INR", "USD", "GBP", "EUR"]).default("INR"),
});

/** Pure preview used by the last onboarding screen (no writes). */
export async function GET(req: Request) {
  const u = new URL(req.url).searchParams;
  const t = estimateTargets({ sex: u.get("sex"), age: Number(u.get("age")) || undefined, heightCm: Number(u.get("heightCm")) || undefined, weightKg: Number(u.get("weightKg")) || undefined, activityLevel: u.get("activityLevel"), goals: u.getAll("goal"), dietType: u.get("diet") });
  return Response.json(t);
}

export const POST = route(async ({ userId, req }) => {
  const d = await body(req, onboardingSchema);
  const targets = d.nutritionMode === "custom" && d.calories
    ? { calories: d.calories, proteinG: d.proteinG ?? Math.round((d.calories * 0.25) / 4), carbsG: d.carbsG ?? Math.round((d.calories * 0.45) / 4), fatG: d.fatG ?? Math.round((d.calories * 0.3) / 9) }
    : estimateTargets({ ...d, dietType: d.diet });
  const restrictions = [
    ...d.intolerances.map((v) => ({ kind: "intolerance", value: norm(v) })), ...d.avoid.map((v) => ({ kind: "avoid", value: norm(v) })), ...d.dislikes.map((v) => ({ kind: "dislike", value: norm(v) })),
  ].filter((r) => r.value);
  await prisma.$transaction([
    prisma.userProfile.upsert({ where: { userId }, create: { userId, sex: d.sex, age: d.age, heightCm: d.heightCm, weightKg: d.weightKg, activityLevel: d.activityLevel, units: d.units, currency: d.currency }, update: { sex: d.sex, age: d.age, heightCm: d.heightCm, weightKg: d.weightKg, activityLevel: d.activityLevel, units: d.units, currency: d.currency } }),
    prisma.userPreference.upsert({
      where: { userId },
      create: { userId, goals: d.goals, dietType: d.diet, cuisines: d.cuisines, lovedIngredients: d.lovedIngredients, maxCookMinutes: d.maxCookMinutes, householdSize: d.householdSize, mealTypes: d.mealTypes },
      update: { goals: d.goals, dietType: d.diet, cuisines: d.cuisines, lovedIngredients: d.lovedIngredients, maxCookMinutes: d.maxCookMinutes, householdSize: d.householdSize, mealTypes: d.mealTypes },
    }),
    prisma.nutritionGoal.upsert({ where: { userId }, create: { userId, mode: d.nutritionMode, ...targets }, update: { mode: d.nutritionMode, ...targets } }),
    prisma.allergy.deleteMany({ where: { userId } }),
    prisma.dietaryRestriction.deleteMany({ where: { userId } }),
    prisma.allergy.createMany({ data: [...new Set(d.allergies.map(norm).filter(Boolean))].map((name) => ({ userId, name })), skipDuplicates: true }),
    prisma.dietaryRestriction.createMany({ data: restrictions.map((r) => ({ userId, ...r })), skipDuplicates: true }),
    prisma.notificationPreference.upsert({ where: { userId }, create: { userId }, update: {} }),
    prisma.user.update({ where: { id: userId }, data: { onboarded: true } }),
  ]);
  return { targets };
});
