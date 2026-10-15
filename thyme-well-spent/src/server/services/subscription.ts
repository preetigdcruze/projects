import { prisma } from "@/lib/db";
import { AppError, proRequired } from "@/lib/errors";

// Feature gating. Real billing (Stripe / App Store / Play Billing) plugs in by setting Subscription.plan
// from a verified webhook — nothing in the app ever upgrades a user without that.
export const LIMITS = {
  free: { aiPlansPerMonth: 3, customRecipes: 10, assistantMessagesPerMonth: 15, pantryIntelligence: false, advancedInsights: false },
  pro: { aiPlansPerMonth: Infinity, customRecipes: Infinity, assistantMessagesPerMonth: Infinity, pantryIntelligence: true, advancedInsights: true },
} as const;

export type Plan = keyof typeof LIMITS;

export async function getSubscription(userId: string) {
  return (
    (await prisma.subscription.findUnique({ where: { userId } })) ??
    (await prisma.subscription.create({ data: { userId, plan: "free" } }))
  );
}

export async function getPlan(userId: string): Promise<Plan> {
  const s = await getSubscription(userId);
  const active = s.status === "active" && (!s.currentPeriodEnd || s.currentPeriodEnd > new Date());
  return s.plan === "pro" && active ? "pro" : "free";
}

export async function assertCanGeneratePlan(userId: string) {
  const s = await getSubscription(userId);
  const plan = await getPlan(userId);
  if (plan === "pro") return;
  const start = new Date(s.aiPlansPeriodStart);
  const expired = Date.now() - start.getTime() > 30 * 86400000;
  const used = expired ? 0 : s.aiPlansUsed;
  if (used >= LIMITS.free.aiPlansPerMonth) {
    throw new AppError(`You've used your ${LIMITS.free.aiPlansPerMonth} free AI meal plans this month. Upgrade to Thyme Pro for unlimited plans.`, 402, "limit_reached");
  }
}

export async function recordPlanGenerated(userId: string) {
  const s = await getSubscription(userId);
  const expired = Date.now() - new Date(s.aiPlansPeriodStart).getTime() > 30 * 86400000;
  await prisma.subscription.update({
    where: { userId },
    data: expired ? { aiPlansUsed: 1, aiPlansPeriodStart: new Date() } : { aiPlansUsed: { increment: 1 } },
  });
}

export async function assertPro(userId: string, feature: string) {
  if ((await getPlan(userId)) !== "pro") throw proRequired(feature);
}

export async function usageSummary(userId: string) {
  const s = await getSubscription(userId);
  const plan = await getPlan(userId);
  const expired = Date.now() - new Date(s.aiPlansPeriodStart).getTime() > 30 * 86400000;
  return {
    plan,
    status: s.status,
    aiPlansUsed: expired ? 0 : s.aiPlansUsed,
    aiPlansLimit: plan === "pro" ? null : LIMITS.free.aiPlansPerMonth,
    paymentsConfigured: Boolean(process.env.STRIPE_SECRET_KEY),
  };
}
