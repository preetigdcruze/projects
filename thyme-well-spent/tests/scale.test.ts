import { describe, expect, it } from "vitest";
import { scaleIngredients } from "@/lib/scale";
import { scaleMacros } from "@/lib/nutrition";
import { formatRecipeQty, toBase } from "@/lib/units";

describe("recipe serving scaling", () => {
  const rows = [{ quantity: 200, unit: "g", name: "chicken" }, { quantity: 1, unit: "tbsp", name: "oil" }, { quantity: 2, unit: "pc", name: "onion" }, { quantity: 0.5, unit: "tsp", name: "salt" }];
  it("doubles every quantity when servings double (2 → 4)", () => {
    const out = scaleIngredients(rows, 2, 4);
    expect(out.map((o) => o.scaledQuantity)).toEqual([400, 2, 4, 1]);
    expect(out[0].display).toBe("400 g");
  });
  it("halves and handles fractional factors", () => {
    expect(scaleIngredients(rows, 2, 1)[0].scaledQuantity).toBe(100);
    expect(scaleIngredients(rows, 2, 3)[0].scaledQuantity).toBe(300);
  });
  it("switches to kg display for large quantities", () => {
    expect(formatRecipeQty(1200, "g")).toBe("1.2 kg");
  });
  it("scales nutrition proportionally", () => {
    const m = scaleMacros({ calories: 420, protein: 28, carbs: 40, fat: 12, fiber: 5 }, 2);
    expect(m).toMatchObject({ calories: 840, protein: 56, carbs: 80, fat: 24, fiber: 10 });
  });
  it("rejects invalid base servings", () => {
    expect(() => scaleIngredients(rows, 0, 2)).toThrow();
  });
  it("converts units into an ingredient's base unit", () => {
    expect(toBase(1, "kg", { defaultUnit: "g" })).toBe(1000);
    expect(toBase(2, "tbsp", { defaultUnit: "ml" })).toBe(30);
    expect(toBase(300, "g", { defaultUnit: "pc", gramsPerPiece: 150 })).toBe(2);
    expect(toBase(3, "pc", { defaultUnit: "g", gramsPerPiece: 100 })).toBe(300);
  });
});
