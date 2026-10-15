import { requireUserId } from "@/lib/session";
import { searchRecipes } from "@/server/services/recipes";
import { RecipeBrowser } from "./recipe-browser";

export const metadata = { title: "Recipes" };
export const dynamic = "force-dynamic";

export default async function RecipesPage({ searchParams }: { searchParams: Promise<{ q?: string; collection?: string }> }) {
  const userId = await requireUserId();
  const sp = await searchParams;
  const collection = sp.collection ?? "recommended";
  const initial = await searchRecipes(userId, { q: sp.q, collection: collection === "recommended" ? undefined : collection, pageSize: 24 });
  return <RecipeBrowser initial={initial} initialQuery={sp.q ?? ""} initialCollection={collection} />;
}
