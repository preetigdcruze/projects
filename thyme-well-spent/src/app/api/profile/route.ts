import { z } from "zod";
import { prisma } from "@/lib/db";
import { body, route } from "@/lib/api";
import { norm } from "@/lib/diet";
import { getUserContext } from "@/server/services/context";
import { estimateTargets } from "@/lib/nutrition";

export const GET = route(async ({ userId }) => {
  const c = await getUserContext(userId);
  return { name: c.name, email: c.email, profile: c.profile, prefs: c.prefs, targets: c.targets, goalMode: c.goal?.mode ?? "auto", allergies: c.allergies, restrictions: c.restrictions };
});

const list = z.array(z.string().trim().min(1).max(60)).max(40);
const schema = z.object({
  name: z.string().trim().min(1).max(80), image: z.string().max(500000).nullable(),
  goals: list, dietType: z.string(), cuisines: list, maxCookMinutes: z.number().int().min(5).max(240), householdSize: z.number().int().min(1).max(12),
  mealTypes: z.array(z.enum(["breakfast", "lunch", "dinner", "snack"])).min(1), budget: z.enum(["low", "medium", "flexible"]), weeklyBudget: z.number().min(0).nullable(),
  allergies: list, avoid: list, dislikes: list,
  sex: z.enum(["female", "male", "other"]).nullable(), age: z.number().int().min(14).max(100).nullable(), heightCm: z.number().min(100).max(250).nullable(), weightKg: z.number().min(30).max(300).nullable(),
  activityLevel: z.enum(["sedentary", "light", "moderate", "active", "very_active"]), units: z.enum(["metric", "imperial"]), currency: z.enum(["INR", "USD", "GBP", "EUR"]), theme: z.enum(["light", "dark", "system"]),
  nutritionMode: z.enum(["auto", "custom"]), calories: z.number().int().min(1000).max(6000), proteinG: z.number().int().min(0).max(500), carbsG: z.number().int().min(0).max(800), fatG: z.number().int().min(0).max(300),
  notifications: z.object({ enabled: z.boolean(), morningMeal: z.boolean(), mealReminder: z.boolean(), groceryReminder: z.boolean(), weeklyPlanning: z.boolean(), expiring: z.boolean(), mealPrep: z.boolean() }),
  usePantry: z.boolean(), preferVariety: z.boolean(), useLeftovers: z.boolean(),
}).partial();

export const PATCH = route(async ({ userId, req }) => {
  const d = await body(req, schema);
  const ops = [];
  if (d.name !== undefined || d.image !== undefined) ops.push(prisma.user.update({ where: { id: userId }, data: { ...(d.name !== undefined && { name: d.name }), ...(d.image !== undefined && { image: d.image }) } }));
  const prof = { sex: d.sex, age: d.age, heightCm: d.heightCm, weightKg: d.weightKg, activityLevel: d.activityLevel, units: d.units, currency: d.currency, theme: d.theme };
  if (Object.values(prof).some((v) => v !== undefined)) ops.push(prisma.userProfile.upsert({ where: { userId }, create: { userId, ...strip(prof) }, update: strip(prof) }));
  const pref = { goals: d.goals, dietType: d.dietType, cuisines: d.cuisines, maxCookMinutes: d.maxCookMinutes, householdSize: d.householdSize, mealTypes: d.mealTypes, budget: d.budget, weeklyBudget: d.weeklyBudget, usePantry: d.usePantry, preferVariety: d.preferVariety, useLeftovers: d.useLeftovers };
  if (Object.values(pref).some((v) => v !== undefined)) ops.push(prisma.userPreference.upsert({ where: { userId }, create: { userId, ...strip(pref) }, update: strip(pref) }));
  if (d.allergies) ops.push(prisma.allergy.deleteMany({ where: { userId } }), prisma.allergy.createMany({ data: [...new Set(d.allergies.map(norm).filter(Boolean))].map((name) => ({ userId, name })), skipDuplicates: true }));
  if (d.avoid || d.dislikes) {
    const kinds = [...(d.avoid ? ["avoid"] : []), ...(d.dislikes ? ["dislike"] : [])];
    ops.push(prisma.dietaryRestriction.deleteMany({ where: { userId, kind: { in: kinds } } }),
      prisma.dietaryRestriction.createMany({ data: [...(d.avoid ?? []).map((v) => ({ userId, kind: "avoid", value: norm(v) })), ...(d.dislikes ?? []).map((v) => ({ userId, kind: "dislike", value: norm(v) }))].filter((r) => r.value), skipDuplicates: true }));
  }
  if (d.notifications) ops.push(prisma.notificationPreference.upsert({ where: { userId }, create: { userId, ...d.notifications }, update: d.notifications }));
  if (d.nutritionMode) {
    const ctx = await getUserContext(userId);
    const t = d.nutritionMode === "custom"
      ? { calories: d.calories ?? ctx.targets.calories, proteinG: d.proteinG ?? ctx.targets.proteinG, carbsG: d.carbsG ?? ctx.targets.carbsG, fatG: d.fatG ?? ctx.targets.fatG }
      : estimateTargets({ ...ctx.profile, sex: d.sex ?? ctx.profile?.sex, age: d.age ?? ctx.profile?.age, heightCm: d.heightCm ?? ctx.profile?.heightCm, weightKg: d.weightKg ?? ctx.profile?.weightKg, goals: d.goals ?? ctx.prefs?.goals, dietType: d.dietType ?? ctx.prefs?.dietType });
    ops.push(prisma.nutritionGoal.upsert({ where: { userId }, create: { userId, mode: d.nutritionMode, ...t }, update: { mode: d.nutritionMode, ...t } }));
  }
  await prisma.$transaction(ops);
  return { ok: true };
});

function strip<T extends Record<string, unknown>>(o: T) { return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T; }
