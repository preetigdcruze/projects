import { RecipeForm } from "@/components/app/recipe-form";

export const metadata = { title: "New recipe" };

export default function NewRecipePage() {
  return <div className="mx-auto max-w-2xl space-y-6"><div><h1 className="text-3xl font-semibold">New recipe</h1><p className="text-muted-foreground">Saved to My Recipes — only you can see it.</p></div><RecipeForm /></div>;
}
