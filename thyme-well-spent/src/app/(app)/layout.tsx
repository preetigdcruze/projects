import { redirect } from "next/navigation";
import { AppShell } from "@/components/app/app-shell";
import { requireUserId } from "@/lib/session";
import { getUserContext } from "@/server/services/context";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const userId = await requireUserId();
  const ctx = await getUserContext(userId);
  if (!ctx.onboarded) redirect("/onboarding");
  return <AppShell name={ctx.name} theme={ctx.profile?.theme ?? "system"}>{children}</AppShell>;
}
