"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUp, CalendarCheck, RotateCcw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FoodImage } from "@/components/ui/food-image";
import { api, ApiError } from "@/lib/client";
import { cn } from "@/lib/utils";
import type { RecipeCard } from "@/server/services/recipes";

type Msg = { id: string; role: "user" | "assistant"; content: string; recipes?: RecipeCard[]; changed?: boolean; failed?: boolean; limit?: boolean };

const PROMPTS = ["What should I eat tonight?", "I have chicken, rice and spinach", "Give me a high-protein dinner", "Make tomorrow vegetarian", "Replace Friday's dinner with something vegetarian", "Use up my spinach", "Plan dinners under ₹2,000 this week", "Give me meals I can cook in 20 minutes"];

export function Assistant() {
  const router = useRouter();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [conv, setConv] = useState<string | undefined>();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<{ conversationId: string | null; messages: Msg[] }>("/api/ai/chat").then((r) => { setConv(r.conversationId ?? undefined); setMsgs(r.messages); }).catch(() => undefined).finally(() => setLoading(false));
  }, []);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [msgs, busy]);

  async function send(message: string) {
    const m = message.trim();
    if (!m || busy) return;
    setText(""); setBusy(true);
    setMsgs((x) => [...x.filter((y) => !y.failed), { id: `u${Date.now()}`, role: "user", content: m }]);
    try {
      const r = await api<{ conversationId: string; reply: string; recipes: RecipeCard[]; changed: boolean }>("/api/ai/chat", { body: { message: m, conversationId: conv } });
      setConv(r.conversationId);
      setMsgs((x) => [...x, { id: `a${Date.now()}`, role: "assistant", content: r.reply, recipes: r.recipes, changed: r.changed }]);
      if (r.changed) router.refresh();
    } catch (e) {
      setMsgs((x) => [...x, { id: `e${Date.now()}`, role: "assistant", failed: true, limit: e instanceof ApiError && e.code === "limit_reached", content: e instanceof ApiError ? e.message : "I couldn't answer that just now.", recipes: [] }]);
    } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-9rem)] max-w-2xl flex-col md:min-h-[calc(100dvh-6rem)]">
      <header className="flex items-center justify-between gap-3 pb-4">
        <div className="flex items-center gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary text-primary-foreground"><Sparkles className="h-5 w-5" /></span><div><h1 className="text-2xl font-semibold leading-tight">Ask Thyme</h1><p className="text-sm text-muted-foreground">Meal ideas, swaps and plan changes</p></div></div>
        {msgs.length > 0 && <Button variant="ghost" size="sm" onClick={() => { setMsgs([]); setConv(undefined); }}><RotateCcw className="h-4 w-4" />New chat</Button>}
      </header>

      <div className="flex-1 space-y-4 pb-4" aria-live="polite">
        {loading && <><Skeleton className="h-16 w-3/4" /><Skeleton className="ml-auto h-12 w-1/2" /></>}
        {!loading && msgs.length === 0 && (
          <div className="space-y-4 pt-4"><p className="font-display text-2xl">What can I help you plan?</p><div className="flex flex-wrap gap-2">{PROMPTS.map((p) => <button key={p} onClick={() => send(p)} className="tap rounded-2xl border border-border bg-card px-4 py-2.5 text-left text-[15px] shadow-soft transition-all hover:bg-muted active:scale-[0.98]">{p}</button>)}</div>
            <p className="text-xs text-muted-foreground">I only change your plan when you clearly ask me to.</p></div>
        )}
        <AnimatePresence initial={false}>
          {msgs.map((m) => (
            <motion.div key={m.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
              <div className={cn("max-w-[88%] space-y-3 rounded-3xl px-4 py-3 text-[15.5px] leading-relaxed", m.role === "user" ? "rounded-br-lg bg-primary text-primary-foreground" : m.failed ? "rounded-bl-lg bg-danger/10" : "rounded-bl-lg bg-card shadow-soft")}>
                <p className="whitespace-pre-line">{m.content}</p>
                {m.recipes && m.recipes.length > 0 && (
                  <ul className="space-y-2">{m.recipes.slice(0, 4).map((r) => <li key={r.id}><Link href={`/recipes/${r.id}`} className="flex items-center gap-3 rounded-2xl bg-muted p-2 text-foreground"><FoodImage title={r.title} cuisine={r.cuisine} image={r.image} className="h-12 w-12 shrink-0 rounded-xl" emojiClass="text-xl" sizes="48px" /><span className="min-w-0"><span className="block truncate text-sm font-semibold">{r.title}</span><span className="text-xs text-muted-foreground">{r.calories} kcal · {r.protein}g protein · {r.totalTime} min</span></span></Link></li>)}</ul>
                )}
                {m.changed && <Link href="/plan" className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5 text-sm font-semibold text-secondary-foreground"><CalendarCheck className="h-4 w-4" />Plan updated · View plan</Link>}
                {m.limit && <Link href="/subscription" className="inline-block rounded-full bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground">See Thyme Pro</Link>}
                {m.failed && !m.limit && <Button size="sm" variant="outline" onClick={() => { const last = [...msgs].reverse().find((x) => x.role === "user"); if (last) void send(last.content); }}>Try again</Button>}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
        {busy && <div className="flex" aria-label="Thyme is thinking"><div className="space-y-2 rounded-3xl rounded-bl-lg bg-card p-4 shadow-soft"><Skeleton className="h-3 w-56" /><Skeleton className="h-3 w-40" /><Skeleton className="h-3 w-48" /></div></div>}
        <div ref={end} />
      </div>

      <form onSubmit={(e) => { e.preventDefault(); void send(text); }} className="sticky bottom-24 flex items-end gap-2 rounded-full border border-border bg-card p-1.5 pl-5 shadow-lift md:bottom-4">
        <label htmlFor="ask" className="sr-only">Message Thyme</label>
        <input id="ask" value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask about meals, swaps, groceries…" maxLength={1000} className="h-11 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground/70" autoComplete="off" />
        <Button type="submit" size="icon" disabled={!text.trim() || busy} aria-label="Send"><ArrowUp className="h-5 w-5" /></Button>
      </form>
    </div>
  );
}
