/** Split a base-unit quantity into a friendly editable value + unit. */
export function splitQty(qty: number, base: string): { value: number; unit: "g" | "kg" | "ml" | "l" | "pc" } {
  if (base === "g") return qty >= 1000 ? { value: Math.round((qty / 1000) * 100) / 100, unit: "kg" } : { value: Math.round(qty), unit: "g" };
  if (base === "ml") return qty >= 1000 ? { value: Math.round((qty / 1000) * 100) / 100, unit: "l" } : { value: Math.round(qty), unit: "ml" };
  return { value: Math.round(qty * 10) / 10, unit: "pc" };
}
export const unitsFor = (base: string) => (base === "g" ? ["g", "kg"] : base === "ml" ? ["ml", "l"] : ["pc"]) as ("g" | "kg" | "ml" | "l" | "pc")[];
