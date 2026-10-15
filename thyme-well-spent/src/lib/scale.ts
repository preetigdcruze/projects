import { formatRecipeQty } from "./units";

export type ScalableIngredient = { quantity: number; unit: string };

export const scaleFactor = (baseServings: number, targetServings: number) => {
  if (baseServings <= 0) throw new Error("baseServings must be > 0");
  return targetServings / baseServings;
};

/** Scale every ingredient quantity to the target number of servings. */
export function scaleIngredients<T extends ScalableIngredient>(
  list: T[],
  baseServings: number,
  targetServings: number,
): (T & { scaledQuantity: number; display: string })[] {
  const f = scaleFactor(baseServings, targetServings);
  return list.map((i) => {
    const scaledQuantity = i.quantity * f;
    return { ...i, scaledQuantity, display: formatRecipeQty(scaledQuantity, i.unit) };
  });
}
