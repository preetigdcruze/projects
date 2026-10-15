"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useMotionValue, useTransform } from "framer-motion";
import { ArrowLeftRight, Check, Clock, Flame, MoreHorizontal, Repeat2 } from "lucide-react";
import { FoodImage } from "@/components/ui/food-image";
import { Button } from "@/components/ui/button";
import { api, fail } from "@/lib/client";
import { MEAL_LABEL } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { LogMealSheet } from "./log-meal-sheet";
import { SwapSheet } from "./swap-sheet";
import type { PlanItemView } from "@/server/services/meal-plan";

/** Meal card with visible buttons AND swipe gestures (right = mark complete, left = replace). */
export function MealCard({ item, onMore, showDay }: { item: PlanItemView; onMore?: () => void; showDay?: boolean }) {
  const router = useRouter();
  const [logOpen, setLogOpen] = useState(false);
  const [swapOpen, setSwapOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const x = useMotionValue(0);
  const rightOpacity = useTransform(x, [0, 80], [0, 1]);
  const leftOpacity = useTransform(x, [-80, 0], [1, 0]);
  const done = item.status === "eaten";
  const skipped = item.status === "skipped";
  const locked = item.status !== "planned";

  async function quickComplete() {
    if (busy || done) return;
    setBusy(true);
    try { await api("/api/meals/log", { body: { mealPlanItemId: item.id, consumedQuantity: item.portion } }); toast.success(`Logged ${item.title}`); router.refresh(); } catch (e) { fail(e); } finally { setBusy(false); }
  }

  const target = { mealPlanItemId: item.id, recipeId: item.recipeId, title: item.title, mealType: item.mealType, date: item.date, calories: item.calories / item.portion, protein: item.protein / item.portion, carbs: item.carbs / item.portion, fat: item.fat / item.portion, defaultQty: item.portion, logId: item.logId, status: item.status, consumedQuantity: item.consumedQuantity, canLeftover: item.mealType === "lunch" || item.mealType === "dinner" };

  return (
    <>
      <div className="relative">
        <div className="absolute inset-0 flex items-center justify-between rounded-3xl px-6" aria-hidden>
          <motion.div style={{ opacity: rightOpacity }} className="flex items-center gap-2 font-semibold text-primary"><Check className="h-5 w-5" />Done</motion.div>
          <motion.div style={{ opacity: leftOpacity }} className="flex items-center gap-2 font-semibold text-accent"><Repeat2 className="h-5 w-5" />Replace</motion.div>
        </div>
        <motion.article
          layout style={{ x, touchAction: "pan-y" }} drag={locked ? false : "x"} dragConstraints={{ left: 0, right: 0 }} dragElastic={0.35} dragSnapToOrigin
          onDragEnd={(_, info) => { if (info.offset.x > 90) void quickComplete(); else if (info.offset.x < -90) setSwapOpen(true); }}
          animate={{ scale: done ? 0.975 : 1, opacity: done || skipped ? 0.8 : 1 }} transition={{ duration: 0.25 }}
          className={cn("relative flex gap-4 rounded-3xl bg-card p-3 shadow-soft", done && "bg-secondary/60")}
        >
          <Link href={`/recipes/${item.recipeId}`} className="relative h-[104px] w-[104px] shrink-0 overflow-hidden rounded-2xl" aria-label={`View recipe: ${item.title}`}>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div key={item.recipeId} className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
                <FoodImage title={item.title} cuisine={item.cuisine} image={item.image} className="h-full w-full" emojiClass="text-4xl" sizes="104px" />
              </motion.div>
            </AnimatePresence>
            {done && <div className="absolute inset-0 flex items-center justify-center bg-primary/70 text-primary-foreground"><Check className="h-8 w-8" strokeWidth={3} /></div>}
          </Link>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{showDay ? `${new Date(`${item.date}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })} · ` : ""}{MEAL_LABEL[item.mealType]}{item.isLeftover ? " · Leftovers" : ""}</span>
              {done && <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-semibold text-primary">Logged{item.consumedQuantity && item.consumedQuantity !== 1 ? ` · ${item.consumedQuantity}×` : ""}</span>}
              {skipped && <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">Skipped</span>}
              {onMore && <button onClick={onMore} className="tap -mr-2 -mt-2 flex items-center justify-center rounded-full text-muted-foreground hover:bg-muted" aria-label={`More options for ${item.title}`}><MoreHorizontal className="h-5 w-5" /></button>}
            </div>
            <AnimatePresence mode="wait" initial={false}>
              <motion.h3 key={item.recipeId} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.2 }} className={cn("line-clamp-2 text-[17px] font-semibold leading-snug", done && "text-muted-foreground")}>{item.title}</motion.h3>
            </AnimatePresence>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-1"><Flame className="h-3.5 w-3.5" aria-hidden />{item.calories} kcal</span>
              <span>{item.protein}g protein</span>
              <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" aria-hidden />{item.totalTime} min</span>
            </p>
            <div className="mt-auto flex flex-wrap items-center gap-2 pt-2.5">
              <Button size="sm" variant={done ? "outline" : "primary"} onClick={() => setLogOpen(true)} className="h-9 px-4">{done || skipped ? "Edit log" : "Log meal"}</Button>
              {!locked && <Button size="sm" variant="outline" onClick={() => setSwapOpen(true)} className="h-9 px-4"><ArrowLeftRight className="h-3.5 w-3.5" />Swap</Button>}
              <Button size="sm" variant="ghost" asChild className="h-9 px-3"><Link href={`/recipes/${item.recipeId}`} aria-label={`View recipe: ${item.title}`}>View</Link></Button>
            </div>
          </div>
        </motion.article>
      </div>
      {logOpen && <LogMealSheet open={logOpen} onOpenChange={setLogOpen} target={target} />}
      {swapOpen && <SwapSheet open={swapOpen} onOpenChange={setSwapOpen} itemId={item.id} currentTitle={item.title} />}
    </>
  );
}
