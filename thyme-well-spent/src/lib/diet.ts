export type RecipeFacts = {
  id: string;
  title: string;
  cuisine: string;
  mealTypes: string[];
  dietType: string; // vegan | vegetarian | eggetarian | pescatarian | nonveg
  totalTime: number;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  tags: string[];
  ingredientIds: string[];
  ingredientNames: string[]; // normalized
  ingredientCategories: string[];
  costPerServing?: number; // INR estimate
};

export const DIET_OPTIONS = [
  { value: "everything", label: "Everything" },
  { value: "vegetarian", label: "Vegetarian" },
  { value: "eggetarian", label: "Eggetarian" },
  { value: "vegan", label: "Vegan" },
  { value: "pescatarian", label: "Pescatarian" },
  { value: "keto", label: "Keto" },
  { value: "paleo", label: "Paleo" },
  { value: "mediterranean", label: "Mediterranean" },
  { value: "low_carb", label: "Low carb" },
  { value: "high_protein", label: "High protein" },
  { value: "other", label: "Other" },
] as const;

const ALLOWED: Record<string, string[]> = {
  vegan: ["vegan"],
  vegetarian: ["vegan", "vegetarian"],
  eggetarian: ["vegan", "vegetarian", "eggetarian"],
  pescatarian: ["vegan", "vegetarian", "eggetarian", "pescatarian"],
};

/** Words that must also match when the user excludes a broad term (allergies often are broad). */
const SYNONYMS: Record<string, string[]> = {
  nut: ["almond", "cashew", "walnut", "pistachio", "peanut", "hazelnut", "pecan"],
  nuts: ["almond", "cashew", "walnut", "pistachio", "peanut", "hazelnut", "pecan"],
  "tree nut": ["almond", "cashew", "walnut", "pistachio", "hazelnut", "pecan"],
  shellfish: ["prawn", "shrimp", "crab", "lobster"],
  seafood: ["prawn", "shrimp", "crab", "salmon", "fish", "tuna", "cod", "lobster"],
  fish: ["salmon", "tuna", "cod", "fish"],
  dairy: ["milk", "cheese", "paneer", "yogurt", "curd", "butter", "ghee", "cream"],
  milk: ["milk", "cream", "yogurt", "curd", "paneer", "cheese", "butter", "ghee"],
  lactose: ["milk", "cream", "yogurt", "curd", "paneer", "cheese"],
  egg: ["egg"],
  gluten: ["wheat", "flour", "bread", "pasta", "roti", "tortilla", "naan", "bun", "couscous", "pita", "noodle", "semolina", "rava", "soy sauce"],
  wheat: ["wheat", "flour", "bread", "pasta", "roti", "tortilla", "naan", "semolina"],
  soy: ["soy", "tofu", "tempeh", "edamame"],
  sesame: ["sesame", "tahini"],
  peanut: ["peanut"],
  coconut: ["coconut"],
  mushroom: ["mushroom"],
  pork: ["pork", "bacon", "ham"],
  beef: ["beef"],
  meat: ["chicken", "mutton", "lamb", "beef", "pork", "bacon", "turkey"],
};

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
const singular = (w: string) => (w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.endsWith("oes") ? w.slice(0, -2) : w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

export function exclusionTerms(raw: string): string[] {
  const n = singular(norm(raw));
  if (!n) return [];
  const syn = SYNONYMS[n] ?? SYNONYMS[`${n}s`] ?? [];
  return [n, ...syn.map(singular)];
}

/** Returns the first exclusion that this recipe violates (or null). */
export function violatedExclusion(r: RecipeFacts, exclusions: string[]): string | null {
  const haystack = [...r.ingredientNames, norm(r.title)].map(norm);
  for (const ex of exclusions) {
    const terms = exclusionTerms(ex);
    for (const t of terms) {
      if (haystack.some((h) => h.split(" ").map(singular).includes(t) || h.includes(t))) return ex;
    }
  }
  return null;
}

export function matchesDiet(r: RecipeFacts, diet: string): boolean {
  if (ALLOWED[diet]) return ALLOWED[diet].includes(r.dietType);
  const cal = Math.max(r.calories, 1);
  const carbShare = (r.carbs * 4) / cal;
  const proteinShare = (r.protein * 4) / cal;
  switch (diet) {
    case "keto": return carbShare <= 0.15;
    case "low_carb": return carbShare <= 0.3;
    case "high_protein": return proteinShare >= 0.25 || r.protein >= 30;
    case "mediterranean": return r.cuisine === "Mediterranean" || r.tags.includes("mediterranean");
    case "paleo": return !r.ingredientCategories.includes("Grains");
    default: return true;
  }
}

export type DietContext = { diet: string; exclusions: string[] };

export function isRecipeAllowed(r: RecipeFacts, ctx: DietContext): boolean {
  if (!matchesDiet(r, ctx.diet)) return false;
  return violatedExclusion(r, ctx.exclusions) === null;
}

/** Hard safety filter: diet type families only (veg/vegan/etc.) + exclusions; style diets are soft preferences. */
export function isSafeForUser(r: RecipeFacts, ctx: DietContext): boolean {
  const hard = ALLOWED[ctx.diet] ? ALLOWED[ctx.diet].includes(r.dietType) : true;
  return hard && violatedExclusion(r, ctx.exclusions) === null;
}

export const DIET_LABEL: Record<string, string> = { vegan: "Vegan", vegetarian: "Vegetarian", eggetarian: "Eggetarian", pescatarian: "Pescatarian", nonveg: "Non-veg" };
