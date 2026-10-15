import { createHash } from "node:crypto";

export type ScanResult = {
  match: string; confidence: number; estimated: { calories: number; protein: number; carbs: number; fat: number };
  alternatives: string[]; provider: string; disclaimer: string;
};

export interface FoodScanner {
  scan(image: Buffer, mime: string): Promise<ScanResult>;
}

const DISCLAIMER = "Photo-based estimates are approximate. Please check and adjust before logging.";
const DISHES: Omit<ScanResult, "provider" | "disclaimer" | "confidence" | "alternatives">[] = [
  { match: "Chicken rice bowl", estimated: { calories: 650, protein: 38, carbs: 72, fat: 18 } },
  { match: "Veg biryani with raita", estimated: { calories: 560, protein: 15, carbs: 88, fat: 16 } },
  { match: "Masala dosa with chutney", estimated: { calories: 420, protein: 9, carbs: 62, fat: 15 } },
  { match: "Paneer wrap", estimated: { calories: 480, protein: 24, carbs: 46, fat: 22 } },
  { match: "Greek salad with feta", estimated: { calories: 340, protein: 12, carbs: 14, fat: 26 } },
  { match: "Pasta with tomato sauce", estimated: { calories: 520, protein: 16, carbs: 88, fat: 12 } },
  { match: "Dal and rice plate", estimated: { calories: 540, protein: 20, carbs: 90, fat: 9 } },
  { match: "Avocado egg toast", estimated: { calories: 380, protein: 17, carbs: 28, fat: 22 } },
];

/** Deterministic stand-in used when no vision provider is configured. Same image → same answer. */
export class MockFoodScanner implements FoodScanner {
  async scan(image: Buffer): Promise<ScanResult> {
    const h = createHash("sha1").update(image).digest();
    const i = h[0] % DISHES.length;
    const d = DISHES[i];
    return {
      ...d, confidence: 0.55 + (h[1] % 30) / 100,
      alternatives: [DISHES[(i + 1) % DISHES.length].match, DISHES[(i + 3) % DISHES.length].match],
      provider: "mock", disclaimer: DISCLAIMER,
    };
  }
}

/** OpenAI vision implementation (used when AI_PROVIDER=openai). Falls back to the mock on any failure. */
export class OpenAIFoodScanner implements FoodScanner {
  constructor(private fallback: FoodScanner = new MockFoodScanner()) {}
  async scan(image: Buffer, mime: string): Promise<ScanResult> {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return this.fallback.scan(image, mime);
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL ?? "gpt-4o-mini", response_format: { type: "json_object" },
          messages: [{ role: "user", content: [
            { type: "text", text: 'Identify the meal in this photo. Reply JSON: {"match": string, "confidence": 0-1, "estimated": {"calories": n, "protein": n, "carbs": n, "fat": n}, "alternatives": [string, string]}. Estimate for the portion shown.' },
            { type: "image_url", image_url: { url: `data:${mime};base64,${image.toString("base64")}` } },
          ] }],
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const j = JSON.parse((await res.json()).choices[0].message.content);
      return { match: String(j.match), confidence: Number(j.confidence ?? 0.5), estimated: j.estimated, alternatives: j.alternatives ?? [], provider: "openai", disclaimer: DISCLAIMER };
    } catch {
      return this.fallback.scan(image, mime);
    }
  }
}

export function getScanner(): FoodScanner {
  return process.env.AI_PROVIDER === "openai" ? new OpenAIFoodScanner() : new MockFoodScanner();
}
