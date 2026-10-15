import { Check } from "lucide-react";
import { requireUserId } from "@/lib/session";
import { LIMITS, usageSummary } from "@/server/services/subscription";
import { UpgradeButton } from "./upgrade-button";

export const metadata = { title: "Thyme Pro" };
export const dynamic = "force-dynamic";

const FREE = [`${LIMITS.free.aiPlansPerMonth} AI meal plans a month`, `${LIMITS.free.customRecipes} recipes of your own`, `${LIMITS.free.assistantMessagesPerMonth} assistant messages a month`, "Basic tracking, grocery lists and pantry"];
const PRO = ["Unlimited AI meal plans", "Unlimited recipes & imports", "Unlimited assistant chat", "Advanced progress insights", "Pantry intelligence: use-soon meal ideas"];

export default async function SubscriptionPage() {
  const userId = await requireUserId();
  const u = await usageSummary(userId);
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header><h1 className="text-3xl font-semibold">Thyme Pro</h1><p className="text-muted-foreground">You're on the <strong className="text-foreground capitalize">{u.plan}</strong> plan.</p></header>
      {u.plan === "free" && <div className="rounded-3xl bg-card p-5 shadow-soft"><p className="text-sm text-muted-foreground">AI meal plans used this month</p><p className="mt-1 font-display text-3xl font-semibold">{u.aiPlansUsed} <span className="text-lg text-muted-foreground">/ {u.aiPlansLimit}</span></p></div>}
      <div className="grid gap-4 md:grid-cols-2">
        {[["Free", FREE, u.plan === "free"], ["Pro", PRO, u.plan === "pro"]].map(([n, list, cur]) => (
          <section key={n as string} className={`rounded-3xl p-6 shadow-soft ${n === "Pro" ? "bg-primary text-primary-foreground" : "bg-card"}`}>
            <h2 className="text-2xl font-semibold">{n as string}{cur ? <span className="ml-2 rounded-full bg-white/20 px-2.5 py-0.5 align-middle font-sans text-xs">Current</span> : null}</h2>
            <ul className="mt-4 space-y-2.5">{(list as string[]).map((f) => <li key={f} className="flex gap-2.5 text-[15px]"><Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{f}</li>)}</ul>
          </section>
        ))}
      </div>
      {u.plan === "free" && <UpgradeButton />}
      <p className="text-xs text-muted-foreground">Billing isn't connected in this build, so plans can't be purchased yet. Plans only change from a verified payment — never from the app itself.</p>
    </div>
  );
}
