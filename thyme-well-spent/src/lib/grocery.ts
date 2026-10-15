import { toBase, type IngredientUnitInfo } from "./units";

export type RawNeed = {
  ingredientId: string;
  name: string;
  category: string;
  defaultUnit: string;
  gramsPerPiece?: number | null;
  pricePer100?: number | null;
  quantity: number;
  unit: string;
  recipeTitle?: string;
  optional?: boolean;
};

export type ConsolidatedItem = {
  ingredientId: string;
  name: string;
  category: string;
  unit: string; // base unit
  quantity: number; // base unit
  pricePer100?: number | null;
  gramsPerPiece?: number | null;
  recipeTitles: string[];
};

/** Merge duplicate ingredients across recipes into one entry in the base unit. */
export function consolidate(needs: RawNeed[]): ConsolidatedItem[] {
  const map = new Map<string, ConsolidatedItem>();
  for (const n of needs) {
    if (n.optional) continue;
    const qty = toBase(n.quantity, n.unit, n as IngredientUnitInfo);
    const cur = map.get(n.ingredientId);
    if (cur) {
      cur.quantity += qty;
      if (n.recipeTitle && !cur.recipeTitles.includes(n.recipeTitle)) cur.recipeTitles.push(n.recipeTitle);
    } else {
      map.set(n.ingredientId, {
        ingredientId: n.ingredientId, name: n.name, category: n.category, unit: n.defaultUnit,
        quantity: qty, pricePer100: n.pricePer100, gramsPerPiece: n.gramsPerPiece,
        recipeTitles: n.recipeTitle ? [n.recipeTitle] : [],
      });
    }
  }
  return [...map.values()];
}

export type PantryStock = { ingredientId: string | null; quantity: number; unit: string };

/** Subtract what the pantry already holds. Items fully covered are dropped. */
export function subtractPantry(items: ConsolidatedItem[], pantry: PantryStock[]) {
  const stock = new Map<string, number>();
  for (const p of pantry) if (p.ingredientId) stock.set(p.ingredientId, (stock.get(p.ingredientId) ?? 0) + p.quantity);
  const result: (ConsolidatedItem & { coveredByPantry: number })[] = [];
  for (const it of items) {
    const have = stock.get(it.ingredientId) ?? 0;
    const covered = Math.min(have, it.quantity);
    const left = it.quantity - covered;
    if (left > 0.0001) result.push({ ...it, quantity: left, coveredByPantry: covered });
  }
  return result;
}

/** Round up to shopping-friendly amounts (pieces → whole, grams → nearest 5/25). */
export function shoppingRound(qty: number, unit: string) {
  if (unit === "pc") return Math.max(1, Math.ceil(qty - 0.001));
  if (qty < 50) return Math.ceil(qty / 5) * 5;
  if (qty < 1000) return Math.ceil(qty / 25) * 25;
  return Math.ceil(qty / 50) * 50;
}

export function estimatePrice(qty: number, unit: string, pricePer100: number | null | undefined, gramsPerPiece?: number | null) {
  if (!pricePer100) return null;
  const grams = unit === "pc" ? qty * (gramsPerPiece ?? 100) : qty;
  return Math.round((grams / 100) * pricePer100 * 100) / 100;
}

export const GROCERY_CATEGORIES = ["Produce", "Meat & Seafood", "Dairy & Eggs", "Pantry", "Grains", "Frozen", "Spices & Condiments", "Snacks", "Other"] as const;
