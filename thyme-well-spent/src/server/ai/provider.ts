// Provider abstraction. The app never calls an LLM directly from UI code — everything flows through AIChatService → AIProvider.
export type ChatMsg = { role: "user" | "assistant"; content: string };
export type ToolCall = { name: string; args: Record<string, unknown> };
export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };
export type ProviderInput = { system: string; messages: ChatMsg[]; tools: ToolSpec[] };
export type ProviderResult = { text?: string; toolCalls: ToolCall[] };

export interface AIProvider {
  readonly name: string;
  respond(input: ProviderInput): Promise<ProviderResult>;
}

export const CONSTRAINT_SCHEMA = {
  type: "object",
  properties: {
    vegetarian: { type: "boolean" }, vegan: { type: "boolean" }, highProtein: { type: "boolean" }, lowCalorie: { type: "boolean" },
    maxMinutes: { type: "number" }, ingredient: { type: "string" }, cuisine: { type: "string" },
  },
};

export const TOOLS: ToolSpec[] = [
  { name: "replace_meal", description: "Replace one planned meal (e.g. Wednesday's dinner) with a different recipe. Only call when the user explicitly asks to change/replace/swap a meal.", parameters: { type: "object", properties: { day: { type: "string", description: "today, tomorrow, a weekday name, or yyyy-mm-dd" }, mealType: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"] }, constraints: CONSTRAINT_SCHEMA }, required: ["day", "mealType"] } },
  { name: "make_day_vegetarian", description: "Replace every non-vegetarian meal on a day with vegetarian meals. Only when explicitly asked.", parameters: { type: "object", properties: { day: { type: "string" } }, required: ["day"] } },
  { name: "add_meal", description: "Add a meal to the plan on a day. Only when explicitly asked.", parameters: { type: "object", properties: { day: { type: "string" }, mealType: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"] }, query: { type: "string", description: "recipe name or idea" }, constraints: CONSTRAINT_SCHEMA }, required: ["day", "mealType"] } },
  { name: "suggest_meals", description: "Suggest recipes (does not change the plan). Use for questions like 'what should I eat tonight' or 'I have chicken, rice and spinach'.", parameters: { type: "object", properties: { mealType: { type: "string" }, ingredients: { type: "array", items: { type: "string" } }, constraints: CONSTRAINT_SCHEMA }, required: [] } },
  { name: "use_up_ingredient", description: "Suggest meals that use up a specific ingredient (e.g. spinach).", parameters: { type: "object", properties: { ingredient: { type: "string" } }, required: ["ingredient"] } },
  { name: "plan_budget_meals", description: "Generate a plan for one meal type for several days within a total budget, replacing unlogged meals. Only when explicitly asked.", parameters: { type: "object", properties: { mealType: { type: "string", enum: ["breakfast", "lunch", "dinner"] }, days: { type: "number" }, budget: { type: "number" } }, required: ["budget"] } },
];
