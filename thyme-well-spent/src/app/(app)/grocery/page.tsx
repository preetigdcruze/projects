import { requireUserId } from "@/lib/session";
import { getListWithItems } from "@/server/services/grocery";
import { GroceryView } from "./grocery-view";

export const metadata = { title: "Grocery list" };
export const dynamic = "force-dynamic";

export default async function GroceryPage() {
  const userId = await requireUserId();
  const { list, items, estimatedTotal } = await getListWithItems(userId);
  return (
    <GroceryView
      currency={list.currency} estimatedTotal={estimatedTotal}
      items={items.map((i) => ({ id: i.id, name: i.name, quantity: i.quantity, unit: i.unit, category: i.category, checked: i.checked, fromMealPlan: i.fromMealPlan, recipeTitles: i.recipeTitles, estimatedPrice: i.estimatedPrice }))}
    />
  );
}
