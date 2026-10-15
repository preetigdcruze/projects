import { describe, expect, it } from "vitest";
import type { RecipeFacts } from "@/lib/diet";
import { isSafeForUser, matchesDiet, violatedExclusion } from "@/lib/diet";
import { rankAlternatives } from "@/lib/swap";
import { parseQuery } from "@/server/services/recipes";

const f = (o: Partial<RecipeFacts>): RecipeFacts => ({ id: "x", title: "T", cuisine: "Indian", mealTypes: ["dinner"], dietType: "vegetarian", totalTime: 30, calories: 500, protein: 25, carbs: 50, fat: 15, tags: [], ingredientIds: [], ingredientNames: [], ingredientCategories: [], ...o });

describe("diet & exclusions", () => {
  it("vegetarian excludes non-veg but allows vegan", () => {
    expect(isSafeForUser(f({ dietType: "nonveg" }), { diet: "vegetarian", exclusions: [] })).toBe(false);
    expect(isSafeForUser(f({ dietType: "vegan" }), { diet: "vegetarian", exclusions: [] })).toBe(true);
    expect(isSafeForUser(f({ dietType: "eggetarian" }), { diet: "vegetarian", exclusions: [] })).toBe(false);
    expect(isSafeForUser(f({ dietType: "eggetarian" }), { diet: "eggetarian", exclusions: [] })).toBe(true);
  });
  it("matches free-text exclusions and broad allergens", () => {
    expect(violatedExclusion(f({ ingredientNames: ["mushroom", "garlic"] }), ["mushrooms"])).toBe("mushrooms");
    expect(violatedExclusion(f({ ingredientNames: ["peanut butter"] }), ["peanuts"])).toBe("peanuts");
    expect(violatedExclusion(f({ ingredientNames: ["prawns"] }), ["shellfish"])).toBe("shellfish");
    expect(violatedExclusion(f({ ingredientNames: ["cashews"] }), ["nuts"])).toBe("nuts");
    expect(violatedExclusion(f({ ingredientNames: ["pasta"] }), ["gluten"])).toBe("gluten");
    expect(violatedExclusion(f({ title: "Coconut curry", ingredientNames: ["coconut milk"] }), ["coconut"])).toBe("coconut");
    expect(violatedExclusion(f({ ingredientNames: ["chicken breast"] }), ["mushrooms"])).toBeNull();
  });
  it("applies style diets from macros", () => {
    expect(matchesDiet(f({ calories: 400, carbs: 10 }), "keto")).toBe(true);
    expect(matchesDiet(f({ calories: 400, carbs: 80 }), "keto")).toBe(false);
    expect(matchesDiet(f({ protein: 35 }), "high_protein")).toBe(true);
  });
});

describe("meal swapping", () => {
  const current = f({ id: "cur", title: "Chicken curry", calories: 520, protein: 40, totalTime: 40, cuisine: "Indian", ingredientIds: ["a", "b"] });
  const similar = f({ id: "sim", calories: 500, protein: 38, totalTime: 35, cuisine: "Indian" });
  const far = f({ id: "far", calories: 180, protein: 5, totalTime: 90, cuisine: "Japanese" });
  const pantryMatch = f({ id: "pan", calories: 480, protein: 36, totalTime: 40, cuisine: "Thai", ingredientIds: ["a", "b"] });
  const ctx = { pantryIngredientIds: new Set(["a", "b"]), cuisines: ["Indian"], maxMinutes: 45 };

  it("ranks nutritionally and time-wise similar meals first and excludes the current one", () => {
    const r = rankAlternatives(current, [far, current, similar], ctx);
    expect(r.map((x) => x.recipe.id)).toEqual(["sim", "far"]);
    expect(r[0].reasons.join(" ")).toMatch(/Similar protein and calories/);
  });
  it("explains pantry use", () => {
    const r = rankAlternatives(current, [pantryMatch], ctx)[0];
    expect(r.reasons).toContain("Uses ingredients already in your pantry");
  });
  it("respects excluded ids", () => {
    expect(rankAlternatives(current, [similar], { ...ctx, excludeRecipeIds: new Set(["sim"]) })).toHaveLength(0);
  });
});

describe("recipe search query parsing", () => {
  it("extracts filters from natural language", () => {
    const { filters, text } = parseQuery("high protein vegetarian under 30 minutes");
    expect(filters).toMatchObject({ highProtein: true, diet: "vegetarian", maxTime: 30 });
    expect(text).toBe("");
  });
  it("keeps plain ingredient searches as text", () => {
    expect(parseQuery("chicken").text).toBe("chicken");
    expect(parseQuery("indian dinner").filters).toMatchObject({ cuisine: "Indian", mealType: "dinner" });
  });
});
