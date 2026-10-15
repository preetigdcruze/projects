import { AnthropicProvider } from "./anthropic";
import { MockProvider } from "./mock";
import { OpenAIProvider } from "./openai";
import type { AIProvider } from "./provider";

/** AI_PROVIDER=mock (default) | openai | anthropic. Missing keys fall back to mock so the app always runs. */
export function getProvider(): AIProvider {
  const p = (process.env.AI_PROVIDER ?? "mock").toLowerCase();
  if (p === "openai" && process.env.OPENAI_API_KEY) return new OpenAIProvider();
  if (p === "anthropic" && process.env.ANTHROPIC_API_KEY) return new AnthropicProvider();
  return new MockProvider();
}
export * from "./provider";
