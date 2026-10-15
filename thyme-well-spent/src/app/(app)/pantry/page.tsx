import { requireUserId } from "@/lib/session";
import { listPantry, useSoon } from "@/server/services/pantry";
import { getPlan } from "@/server/services/subscription";
import { PantryView } from "./pantry-view";

export const metadata = { title: "Pantry" };
export const dynamic = "force-dynamic";

export default async function PantryPage() {
  const userId = await requireUserId();
  const pro = (await getPlan(userId)) === "pro";
  const [items, soon] = await Promise.all([listPantry(userId), pro ? useSoon(userId) : Promise.resolve([])]);
  return (
    <PantryView
      pro={pro} soon={soon}
      items={items.map((i) => ({ id: i.id, name: i.name, quantity: i.quantity, unit: i.unit, category: i.category, expiresAt: i.expiresAt ? i.expiresAt.toISOString().slice(0, 10) : null, daysLeft: i.daysLeft, status: i.status as "ok" | "use_soon" | "expired" }))}
    />
  );
}
