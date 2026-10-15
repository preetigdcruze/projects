import { z } from "zod";
import { body, route, query } from "@/lib/api";
import { chat, getConversation } from "@/server/services/ai-chat";

export const POST = route(async ({ userId, req }) => chat(userId, await body(req, z.object({ message: z.string().min(1).max(1000), conversationId: z.string().optional() }))));
export const GET = route(async ({ userId, req }) => {
  const conv = await getConversation(userId, query(req).conversationId);
  return conv ? { conversationId: conv.id, messages: conv.messages.map((m) => ({ id: m.id, role: m.role, content: m.content, recipes: (m.actions as { recipes?: unknown[] } | null)?.recipes ?? [] })) } : { conversationId: null, messages: [] };
});
