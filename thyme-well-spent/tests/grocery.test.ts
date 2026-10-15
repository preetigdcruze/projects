import { describe, expect, it } from "vitest";
import { consolidate, estimatePrice, shoppingRound, subtractPantry, type RawNeed } from "@/lib/grocery";
import { formatQty } from "@/lib/units";

const chicken = (qty: number, unit: string, title: string): RawNeed => ({ ingredientId: "chicken", name: "Chicken breast", category: "Meat & Seafood", defaultUnit: "g", quantity: qty, unit, recipeTitle: title });

describe("grocery consolidation", () => {
  it("merges the same ingredient across recipes (curry + salad + wraps → 1.2 kg)", () => {
    const items = consolidate([chicken(500, "g", "Chicken curry"), chicken(300, "g", "Chicken salad"), chicken(0.4, "kg", "Chicken wraps")]);
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBe(1200);
    expect(formatQty(items[0].quantity, items[0].unit)).toBe("1.2 kg");
    expect(items[0].recipeTitles).toEqual(["Chicken curry", "Chicken salad", "Chicken wraps"]);
  });
  it("combines mixed units for volume ingredients", () => {
    const oil = (q: number, u: string): RawNeed => ({ ingredientId: "oil", name: "Oil", category: "Pantry", defaultUnit: "ml", quantity: q, unit: u });
    expect(consolidate([oil(2, "tbsp"), oil(100, "ml"), oil(0.5, "cup")])[0].quantity).toBe(30 + 100 + 120);
  });
  it("skips optional ingredients", () => {
    expect(consolidate([{ ...chicken(100, "g", "x"), optional: true }])).toHaveLength(0);
  });
  it("keeps different ingredients separate", () => {
    expect(consolidate([chicken(100, "g", "a"), { ...chicken(1, "pc", "b"), ingredientId: "onion", name: "Onion", defaultUnit: "pc" }])).toHaveLength(2);
  });
  it("rounds to shopping-friendly amounts", () => {
    expect(shoppingRound(2.2, "pc")).toBe(3);
    expect(shoppingRound(230, "g")).toBe(250);
    expect(shoppingRound(12, "g")).toBe(15);
  });
  it("estimates price from per-100 g price", () => {
    expect(estimatePrice(500, "g", 32)).toBe(160);
    expect(estimatePrice(2, "pc", 10, 100)).toBe(20);
    expect(estimatePrice(1, "g", null)).toBeNull();
  });
});

describe("pantry subtraction", () => {
  const need = consolidate([chicken(1000, "g", "Curry")]);
  it("subtracts what the pantry has (1 kg needed, 500 g owned → 500 g)", () => {
    const out = subtractPantry(need, [{ ingredientId: "chicken", quantity: 500, unit: "g" }]);
    expect(out[0].quantity).toBe(500);
    expect(out[0].coveredByPantry).toBe(500);
  });
  it("drops items fully covered", () => {
    expect(subtractPantry(need, [{ ingredientId: "chicken", quantity: 1500, unit: "g" }])).toHaveLength(0);
  });
  it("sums several pantry rows of the same ingredient", () => {
    const out = subtractPantry(need, [{ ingredientId: "chicken", quantity: 300, unit: "g" }, { ingredientId: "chicken", quantity: 300, unit: "g" }]);
    expect(out[0].quantity).toBe(400);
  });
  it("ignores unrelated pantry items and custom (unlinked) items", () => {
    expect(subtractPantry(need, [{ ingredientId: "rice", quantity: 999, unit: "g" }, { ingredientId: null, quantity: 999, unit: "g" }])[0].quantity).toBe(1000);
  });
});
