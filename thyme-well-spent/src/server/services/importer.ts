import { lookup } from "node:dns/promises";
import net from "node:net";
import { AppError } from "@/lib/errors";
import type { NewRecipeInput } from "./recipes";

export interface RecipeImporter {
  import(url: string): Promise<NewRecipeInput>;
}

// ── helpers ──
const UNIT_ALIASES: Record<string, string> = {
  g: "g", gram: "g", grams: "g", kg: "kg", kilogram: "kg", ml: "ml", l: "l", litre: "l", liter: "l", tsp: "tsp", teaspoon: "tsp", teaspoons: "tsp",
  tbsp: "tbsp", tablespoon: "tbsp", tablespoons: "tbsp", cup: "cup", cups: "cup", oz: "g", pinch: "pinch",
};
const FRACTIONS: Record<string, number> = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 0.33, "⅔": 0.67 };

export function parseIngredientLine(line: string): NewRecipeInput["ingredients"][number] {
  let s = line.replace(/\(.*?\)/g, "").replace(/\s+/g, " ").trim();
  let qty = 1;
  const m = s.match(/^(\d+\s+\d\/\d|\d+\/\d+|\d*\.?\d+|[½¼¾⅓⅔])\s*([a-zA-Z]+)?\s*(.*)$/);
  let unit = "pc";
  if (m) {
    const raw = m[1];
    qty = FRACTIONS[raw] ?? (raw.includes(" ") ? Number(raw.split(" ")[0]) + eval1(raw.split(" ")[1]) : raw.includes("/") ? eval1(raw) : Number(raw));
    const maybeUnit = (m[2] ?? "").toLowerCase();
    if (UNIT_ALIASES[maybeUnit]) { unit = UNIT_ALIASES[maybeUnit]; s = m[3]; if (maybeUnit === "oz") qty *= 28; }
    else s = `${m[2] ?? ""} ${m[3]}`.trim();
  }
  const [name, note] = s.replace(/^of\s+/i, "").split(",");
  return { name: name.trim().toLowerCase(), quantity: Math.round(qty * 100) / 100, unit, note: note?.trim() };
}
const eval1 = (f: string) => { const [a, b] = f.split("/").map(Number); return b ? a / b : a; };

export function parseDuration(iso?: string | null): number {
  if (!iso) return 0;
  const m = /P(?:\d+D)?T?(?:(\d+)H)?(?:(\d+)M)?/.exec(iso);
  return m ? Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0) : 0;
}

type JsonLd = Record<string, unknown>;
function findRecipeNode(node: unknown): JsonLd | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const n of node) { const r = findRecipeNode(n); if (r) return r; } return null; }
  const o = node as JsonLd;
  const t = o["@type"];
  if (t === "Recipe" || (Array.isArray(t) && t.includes("Recipe"))) return o;
  if (o["@graph"]) return findRecipeNode(o["@graph"]);
  return null;
}
const text = (v: unknown): string => (typeof v === "string" ? v : Array.isArray(v) ? text(v[0]) : v && typeof v === "object" ? text((v as JsonLd).url ?? (v as JsonLd).text ?? "") : "");
const num = (v: unknown) => { const m = /[\d.]+/.exec(text(v)); return m ? parseFloat(m[0]) : undefined; };

function instructionList(v: unknown): string[] {
  if (!v) return [];
  if (typeof v === "string") return v.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(v)) return v.flatMap((x) => (typeof x === "string" ? [x] : x && typeof x === "object" && (x as JsonLd).itemListElement ? instructionList((x as JsonLd).itemListElement) : [text((x as JsonLd).text)])).map((s) => s.trim()).filter(Boolean);
  return [];
}

export function recipeFromHtml(html: string, url: string): NewRecipeInput {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  let node: JsonLd | null = null;
  for (const b of blocks) { try { node = findRecipeNode(JSON.parse(b.trim())); } catch { /* ignore malformed block */ } if (node) break; }
  if (!node) throw new AppError("We couldn't find a recipe on that page. Try another link, or add it manually.", 422, "no_recipe");
  const ingredients = (Array.isArray(node.recipeIngredient) ? (node.recipeIngredient as string[]) : []).map(parseIngredientLine).filter((i) => i.name);
  const prep = parseDuration(text(node.prepTime)), cook = parseDuration(text(node.cookTime)), total = parseDuration(text(node.totalTime));
  const nutrition = node.nutrition as JsonLd | undefined;
  return {
    title: text(node.name).slice(0, 120) || "Imported recipe", description: text(node.description).slice(0, 400), image: text(node.image) || null, sourceUrl: url,
    servings: Math.round(num(node.recipeYield) ?? 2) || 2, prepTime: prep || Math.max(total - cook, 5), cookTime: cook || Math.max(total - prep, 0),
    cuisine: text(node.recipeCuisine) || "Other", ingredients: ingredients.length ? ingredients : [{ name: "see source", quantity: 1, unit: "pc" }],
    instructions: instructionList(node.recipeInstructions), tags: [],
    nutrition: nutrition ? { calories: num(nutrition.calories), protein: num(nutrition.proteinContent), carbs: num(nutrition.carbohydrateContent), fat: num(nutrition.fatContent), fiber: num(nutrition.fiberContent) } : null,
  };
}

/** Block requests to private networks (SSRF guard). */
async function assertPublicUrl(raw: string) {
  let u: URL;
  try { u = new URL(raw); } catch { throw new AppError("That doesn't look like a valid link."); }
  if (!/^https?:$/.test(u.protocol)) throw new AppError("Only web links are supported.");
  const host = u.hostname;
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new AppError("We couldn't reach that site.", 422, "unreachable");
  for (const a of addrs) {
    const ip = a.address;
    if (/^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(ip) || ip === "::1" || /^f[cd]/i.test(ip) || /^fe80/i.test(ip)) throw new AppError("That link isn't allowed.");
  }
  return u;
}

export class JsonLdRecipeImporter implements RecipeImporter {
  async import(url: string): Promise<NewRecipeInput> {
    const u = await assertPublicUrl(url);
    let html: string;
    try {
      const res = await fetch(u, { headers: { "user-agent": "ThymeWellSpentBot/1.0", accept: "text/html" }, signal: AbortSignal.timeout(8000), redirect: "follow" });
      if (!res.ok) throw new Error(String(res.status));
      html = (await res.text()).slice(0, 2_000_000);
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError("We couldn't open that link. Check it and try again.", 422, "unreachable");
    }
    return recipeFromHtml(html, u.toString());
  }
}

/** Offline parser used in demos/tests (RECIPE_IMPORT=mock) so the flow works without internet. */
export class MockRecipeImporter implements RecipeImporter {
  async import(url: string): Promise<NewRecipeInput> {
    const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "example.com"; } })();
    return {
      title: "Lemon Garlic Chicken Skillet", description: `Imported from ${host} (sample data).`, sourceUrl: url, cuisine: "American", servings: 2, prepTime: 10, cookTime: 20,
      mealTypes: ["dinner"], tags: ["imported"],
      ingredients: [{ name: "chicken breast", quantity: 400, unit: "g" }, { name: "garlic", quantity: 3, unit: "pc" }, { name: "lemon", quantity: 1, unit: "pc" }, { name: "olive oil", quantity: 1, unit: "tbsp" }, { name: "spinach", quantity: 100, unit: "g" }],
      instructions: ["Season and sear the chicken.", "Add garlic and lemon juice.", "Wilt in the spinach and serve."],
    };
  }
}

export const getImporter = (): RecipeImporter => (process.env.RECIPE_IMPORT === "mock" ? new MockRecipeImporter() : new JsonLdRecipeImporter());
