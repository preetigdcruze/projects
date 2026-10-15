// Unit handling: every ingredient has a base unit (g | ml | pc). All grocery & pantry math happens in that base unit.

export type BaseUnit = "g" | "ml" | "pc";

const MASS: Record<string, number> = { g: 1, kg: 1000, mg: 0.001, oz: 28.35, lb: 453.6 };
const VOLUME: Record<string, number> = { ml: 1, l: 1000, tsp: 5, tbsp: 15, cup: 240, pinch: 0.4 };
const COUNT: Record<string, number> = { pc: 1, clove: 1, slice: 1, can: 1, bunch: 1, sprig: 1 };

export const RECIPE_UNITS = ["g", "kg", "ml", "l", "tsp", "tbsp", "cup", "pc", "pinch"] as const;

export type IngredientUnitInfo = { defaultUnit: string; gramsPerPiece?: number | null };

/** Convert a quantity in any recipe unit into the ingredient's base unit. */
export function toBase(qty: number, unit: string, ing: IngredientUnitInfo): number {
  const u = unit.toLowerCase();
  const base = (ing.defaultUnit as BaseUnit) || "g";
  const gpp = ing.gramsPerPiece ?? 100;
  let grams: number | null = null; // normalised mass/volume (density 1)
  let pieces: number | null = null;
  if (u in MASS) grams = qty * MASS[u];
  else if (u in VOLUME) grams = qty * VOLUME[u];
  else if (u in COUNT) pieces = qty * COUNT[u];
  else grams = qty;

  if (base === "pc") return pieces !== null ? pieces : (grams as number) / gpp;
  return grams !== null ? grams : (pieces as number) * gpp;
}

/** Nicest way to show a base-unit quantity. */
export function formatQty(qty: number, base: string): string {
  const r = (n: number, d = 1) => {
    const v = Math.round(n * 10 ** d) / 10 ** d;
    return Number.isInteger(v) ? String(v) : v.toFixed(d).replace(/0+$/, "").replace(/\.$/, "");
  };
  if (base === "g") return qty >= 1000 ? `${r(qty / 1000, 2)} kg` : `${r(qty, 0)} g`;
  if (base === "ml") return qty >= 1000 ? `${r(qty / 1000, 2)} L` : `${r(qty, 0)} ml`;
  return `${r(qty, qty < 10 ? 1 : 0)}`;
}

/** Display a recipe-level quantity (keeps the recipe's own unit, rounds sensibly). */
export function formatRecipeQty(qty: number, unit: string): string {
  const fractions: [number, string][] = [[0.25, "¼"], [0.33, "⅓"], [0.5, "½"], [0.67, "⅔"], [0.75, "¾"]];
  let q = qty;
  let u = unit;
  if (u === "g" && q >= 1000) { q /= 1000; u = "kg"; }
  if (u === "ml" && q >= 1000) { q /= 1000; u = "l"; }
  if (["tsp", "tbsp", "cup", "pc"].includes(u) && q < 10) {
    const whole = Math.floor(q);
    const frac = q - whole;
    const hit = fractions.find(([v]) => Math.abs(v - frac) < 0.05);
    if (frac < 0.05) q = whole;
    else if (hit) return `${whole > 0 ? whole : ""}${hit[1]} ${u === "pc" ? "" : u}`.trim();
    else q = Math.round(q * 10) / 10;
  } else q = q >= 100 ? Math.round(q / 5) * 5 : Math.round(q * 10) / 10;
  const num = Number.isInteger(q) ? String(q) : String(q);
  return u === "pc" ? num : `${num} ${u}`;
}

export function baseUnitLabel(base: string) {
  return base === "pc" ? "" : base;
}
