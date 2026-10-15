export type ParsedIngredient = { name: string; quantity: number; unit: string; optional: boolean; note?: string };
export type RecipeSeed = {
  title: string; cuisine: string; meals: string[]; prep: number; cook: number; servings: number;
  difficulty: string; tags: string[]; ingredients: ParsedIngredient[]; steps: string[]; description: string;
};

const RE = /^(.+?)\s+(\d*\.?\d+)\s?(g|kg|ml|l|tsp|tbsp|cup|pc|pinch)(\?)?$/;
const MEAL: Record<string, string> = { b: "breakfast", l: "lunch", d: "dinner", s: "snack", x: "dessert" };

export function parseIngredients(s: string): ParsedIngredient[] {
  return s.split(",").map((raw) => {
    const [main, note] = raw.trim().split("/");
    const m = RE.exec(main.trim());
    if (!m) throw new Error(`Bad ingredient "${raw}"`);
    return { name: m[1].trim().toLowerCase(), quantity: parseFloat(m[2]), unit: m[3], optional: !!m[4], note: note?.trim() };
  });
}

/** R(title, meals "bld", [prep, cook, servings], "name qty unit, ...", "step | step", description, tags?) */
export const maker = (cuisine: string) => (
  title: string, meals: string, t: [number, number, number], ing: string, steps: string, description: string, tags = "", difficulty = "easy",
): RecipeSeed => ({
  title, cuisine, meals: [...meals].map((c) => MEAL[c]), prep: t[0], cook: t[1], servings: t[2], difficulty,
  tags: tags ? tags.split(",").map((x) => x.trim()) : [], ingredients: parseIngredients(ing),
  steps: steps.split("|").map((x) => x.trim()), description,
});
