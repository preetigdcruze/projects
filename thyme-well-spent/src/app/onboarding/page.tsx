import { redirect } from "next/navigation";
import { requireUserId } from "@/lib/session";
import { getUserContext } from "@/server/services/context";
import { Onboarding } from "./onboarding";

export const metadata = { title: "Welcome" };
export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const userId = await requireUserId();
  const c = await getUserContext(userId);
  if (c.onboarded) redirect("/");
  return <Onboarding name={c.name.split(" ")[0]} />;
}
