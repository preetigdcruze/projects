import { describe, expect, it } from "vitest";
import { estimateTargets, perServing, recipeTotals, remaining, sumMacros } from "@/lib/nutrition";

const ing = (o: Partial<Parameters<typeof recipeTotals>[0][0]["ingredient"]>) => ({ defaultUnit: "g", gramsPerPiece: null, kcal100: 0, protein100: 0, carbs100: 0, fat100: 0, fiber100: 0, ...o });

describe("nutrition calculation", () => {
  it("derives recipe totals from relational ingredient data", () => {
    const chicken = ing({ kcal100: 165, protein100: 31, fat100: 3.6 });
    const egg = ing({ defaultUnit: "pc", gramsPerPiece: 50, kcal100: 143, protein100: 12.6, fat100: 9.5 });
    const t = recipeTotals([{ quantity: 200, unit: "g", ingredient: chicken }, { quantity: 2, unit: "pc", ingredient: egg }]);
    expect(t.calories).toBe(330 + 143);
    expect(t.protein).toBeCloseTo(62 + 12.6, 1);
    expect(perServing(t, 2).calories).toBe(Math.round(473 / 2));
  });
  it("ignores optional ingredients", () => {
    expect(recipeTotals([{ quantity: 100, unit: "g", optional: true, ingredient: ing({ kcal100: 500 }) }]).calories).toBe(0);
  });
  it("sums logged meals and foods", () => {
    expect(sumMacros([{ calories: 420, protein: 28 }, { calories: 105, protein: 1.3, carbs: 27 }])).toMatchObject({ calories: 525, protein: 29.3, carbs: 27 });
  });
  it("computes remaining targets and never goes negative", () => {
    const r = remaining({ calories: 2050, proteinG: 140, carbsG: 210, fatG: 70 }, { calories: 2300, protein: 82, carbs: 124, fat: 43, fiber: 0 });
    expect(r).toEqual({ calories: 0, protein: 58, carbs: 86, fat: 27 });
  });
  it("estimates targets sensibly and respects goal / diet", () => {
    const base = { sex: "female", age: 29, heightCm: 168, weightKg: 64, activityLevel: "moderate" };
    const maintain = estimateTargets({ ...base, goals: ["maintain"] });
    const lose = estimateTargets({ ...base, goals: ["lose_weight"] });
    const gain = estimateTargets({ ...base, goals: ["gain_muscle"] });
    expect(maintain.calories).toBeGreaterThan(1900);
    expect(maintain.calories).toBeLessThan(2400);
    expect(lose.calories).toBeLessThan(maintain.calories);
    expect(gain.calories).toBeGreaterThan(maintain.calories);
    expect(estimateTargets({ ...base, dietType: "keto" }).carbsG).toBeLessThan(maintain.carbsG / 3);
    expect(estimateTargets({ sex: "female", age: 80, heightCm: 140, weightKg: 35, goals: ["lose_weight"] }).calories).toBeGreaterThanOrEqual(1200);
  });
});
