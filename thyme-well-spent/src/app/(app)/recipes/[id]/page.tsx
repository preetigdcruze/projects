import { notFound } from "next/navigation";
import { requireUserId } from "@/lib/session";
import { AppError } from "@/lib/errors";
import { recipeDetail } from "@/server/services/recipes";
import { getUserContext } from "@/server/services/context";
import { RecipeDetail } from "./recipe-detail";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try { const userId = await requireUserId(); return { title: (await recipeDetail(userId, id)).recipe.title }; } catch { return { title: "Recipe" }; }
}

export default async function RecipePage({ params }: { params: Promise<{ id: string }> }) {
  const userId = await requireUserId();
  const { id } = await params;
  const [d, ctx] = await Promise.all([recipeDetail(userId, id).catch((e) => { if (e instanceof AppError) return null; throw e; }), getUserContext(userId)]);
  if (!d) notFound();
  const r = d.recipe;
  return (
    <RecipeDetail
      isFavorite={d.isFavorite} isMine={!!r.userId} householdSize={ctx.householdSize}
      recipe={{ id: r.id, title: r.title, description: r.description, image: r.image, cuisine: r.cuisine, dietType: r.dietType, mealTypes: r.mealTypes, prepTime: r.prepTime, cookTime: r.cookTime, totalTime: r.totalTime, servings: r.servings, difficulty: r.difficulty, rating: r.rating, ratingCount: r.ratingCount, tags: r.tags, calories: r.calories, protein: r.protein, carbs: r.carbs, fat: r.fat, fiber: r.fiber, sourceUrl: r.sourceUrl }}
      ingredients={r.ingredients.map((i) => ({ id: i.id, name: i.ingredient.name, quantity: i.quantity, unit: i.unit, optional: i.optional, note: i.preparationNote }))}
      steps={r.instructions.map((s) => s.text)}
    />
  );
}
