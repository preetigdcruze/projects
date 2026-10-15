import { AppError } from "@/lib/errors";
import type { AIProvider, ProviderInput, ProviderResult } from "./provider";

export class OpenAIProvider implements AIProvider {
  readonly name = "openai";
  async respond({ system, messages, tools }: ProviderInput): Promise<ProviderResult> {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new AppError("The assistant isn't configured right now.", 503, "ai_unavailable");
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL ?? "gpt-4o-mini", temperature: 0.4,
        messages: [{ role: "system", content: system }, ...messages],
        tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
      }),
      signal: AbortSignal.timeout(30000),
    }).catch(() => null);
    if (!res || !res.ok) throw new AppError("The assistant is having trouble right now. Please try again.", 503, "ai_unavailable");
    const msg = (await res.json()).choices?.[0]?.message ?? {};
    return {
      text: msg.content || undefined,
      toolCalls: (msg.tool_calls ?? []).map((c: { function: { name: string; arguments: string } }) => {
        let args = {}; try { args = JSON.parse(c.function.arguments || "{}"); } catch { /* keep empty */ }
        return { name: c.function.name, args };
      }),
    };
  }
}
