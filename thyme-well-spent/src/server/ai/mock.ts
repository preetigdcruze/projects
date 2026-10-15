import type { AIProvider, ProviderInput, ProviderResult, ToolCall } from "./provider";

const DAY_RE = /\b(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i;
const MEAL_RE = /\b(breakfast|lunch|dinner|supper|snack)s?\b/i;
const FULL: Record<string, string> = { mon: "monday", tue: "tuesday", wed: "wednesday", thu: "thursday", fri: "friday", sat: "saturday", sun: "sunday" };

function constraintsFrom(t: string) {
  const c: Record<string, unknown> = {};
  if (/\bvegan\b/.test(t)) c.vegan = true;
  else if (/\bvegetarian\b|\bveggie\b|\bveg\b/.test(t)) c.vegetarian = true;
  if (/high[- ]protein|more protein/.test(t)) c.highProtein = true;
  if (/low[- ]cal|light\b/.test(t)) c.lowCalorie = true;
  const mins = t.match(/(?:under|in|within|less than|<)\s*(\d+)\s*(?:min|minutes)|(\d+)\s*(?:min|minute)/);
  if (mins) c.maxMinutes = Number(mins[1] ?? mins[2]);
  for (const cu of ["indian", "italian", "mexican", "thai", "japanese", "mediterranean", "american"]) if (t.includes(cu)) c.cuisine = cu;
  return c;
}

const dayOf = (t: string) => {
  const m = t.match(DAY_RE)?.[1]?.toLowerCase();
  if (!m) return undefined;
  return m === "tonight" ? "today" : FULL[m] ?? m;
};
const mealOf = (t: string) => {
  const m = t.match(MEAL_RE)?.[1]?.toLowerCase();
  return m === "supper" ? "dinner" : m;
};

/**
 * Deterministic, offline "model". Understands the assistant's example prompts via simple intent rules and emits the same
 * tool calls a real LLM would — so every downstream code path (DB changes, authorization, replies) is identical.
 */
export class MockProvider implements AIProvider {
  readonly name = "mock";
  async respond({ messages }: ProviderInput): Promise<ProviderResult> {
    const raw = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const t = raw.toLowerCase().replace(/[’']s\b/g, "").trim();
    const calls: ToolCall[] = [];

    const budget = t.match(/(?:under|below|within|budget(?: of)?|less than)\s*[₹$£€]?\s*([\d,]+)/);
    if (/\bplan\b/.test(t) && budget && /dinner|lunch|breakfast|meals/.test(t)) {
      const mealType = mealOf(t) ?? "dinner";
      return { toolCalls: [{ name: "plan_budget_meals", args: { mealType, budget: Number(budget[1].replace(/,/g, "")), days: /week/.test(t) ? 7 : 5 } }] };
    }
    if (/make\b.*\b(vegetarian|vegan)\b/.test(t) && DAY_RE.test(t) && !MEAL_RE.test(t)) {
      return { toolCalls: [{ name: "make_day_vegetarian", args: { day: dayOf(t) } }] };
    }
    if (/\b(replace|swap|change|switch)\b/.test(t) && MEAL_RE.test(t)) {
      return { toolCalls: [{ name: "replace_meal", args: { day: dayOf(t) ?? "today", mealType: mealOf(t), constraints: constraintsFrom(t) } }] };
    }
    if (/\b(add|put)\b/.test(t) && MEAL_RE.test(t) && DAY_RE.test(t)) {
      const q = t.match(/\badd\s+(?:a\s+|an\s+|some\s+)?(.+?)\s+(?:to|for|on)\b/)?.[1];
      return { toolCalls: [{ name: "add_meal", args: { day: dayOf(t), mealType: mealOf(t), query: q && !MEAL_RE.test(q) ? q : undefined, constraints: constraintsFrom(t) } }] };
    }
    const use = t.match(/\b(?:use up|use|using|finish|got extra|need to use)\s+(?:my\s+|the\s+|up\s+)?([a-z ]+?)(?:[.?!]|$)/);
    if (use && !/\bi have\b/.test(t) && /use up|finish|use my|using my|use the/.test(t)) {
      return { toolCalls: [{ name: "use_up_ingredient", args: { ingredient: use[1].trim() } }] };
    }
    const have = t.match(/\bi (?:have|got|own)\s+(.+?)(?:[.?!]|$)/);
    if (have) {
      const ingredients = have[1].split(/,|\band\b/).map((s) => s.replace(/\b(some|a|an|the|leftover|fresh)\b/g, "").trim()).filter(Boolean);
      return { toolCalls: [{ name: "suggest_meals", args: { ingredients, mealType: mealOf(t), constraints: constraintsFrom(t) } }] };
    }
    if (/what should i (eat|have|cook|make)|what('| i)?s for (dinner|lunch|breakfast)|ideas?\b|give me|suggest|recommend|meals? (i can|that)|cook in|something/.test(t) || mealOf(t) || Object.keys(constraintsFrom(t)).length) {
      const meal = mealOf(t) ?? (/tonight/.test(t) ? "dinner" : undefined);
      return { toolCalls: [{ name: "suggest_meals", args: { mealType: meal, constraints: constraintsFrom(t) } }] };
    }
    return {
      text: "I can help with your plan and your pantry. Try: “What should I eat tonight?”, “I have chicken, rice and spinach”, “Replace Friday's dinner with something vegetarian”, or “Give me meals I can cook in 20 minutes.”",
      toolCalls: calls,
    };
  }
}
