import { ImportRecipe } from "./import-recipe";

export const metadata = { title: "Import a recipe" };

export default function ImportPage() {
  return <div className="mx-auto max-w-2xl space-y-6"><div><h1 className="text-3xl font-semibold">Import a recipe</h1><p className="text-muted-foreground">Paste a link and we'll pull in the ingredients and steps. You can review everything before saving.</p></div><ImportRecipe /></div>;
}
