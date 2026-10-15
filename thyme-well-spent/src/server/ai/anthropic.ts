import { AppError } from "@/lib/errors";
import type { AIProvider, ProviderInput, ProviderResult } from "./provider";

export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic";
  async respond({ system, messages, tools }: ProviderInput): Promise<ProviderResult> {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new AppError("The assistant isn't configured right now.", 503, "ai_unavailable");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5", max_tokens: 1024, system, messages,
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      }),
      signal: AbortSignal.timeout(30000),
    }).catch(() => null);
    if (!res || !res.ok) throw new AppError("The assistant is having trouble right now. Please try again.", 503, "ai_unavailable");
    const content: { type: string; text?: string; name?: string; input?: Record<string, unknown> }[] = (await res.json()).content ?? [];
    return {
      text: content.filter((c) => c.type === "text").map((c) => c.text).join("\n") || undefined,
      toolCalls: content.filter((c) => c.type === "tool_use").map((c) => ({ name: c.name!, args: c.input ?? {} })),
    };
  }
}
