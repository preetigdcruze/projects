"use client";
import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Heart } from "lucide-react";
import { useRouter } from "next/navigation";
import { api, fail } from "@/lib/client";
import { cn } from "@/lib/utils";

export function HeartButton({ recipeId, initial, className, onChange }: { recipeId: string; initial: boolean; className?: string; onChange?: (v: boolean) => void }) {
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  async function toggle(e: React.MouseEvent) {
    e.preventDefault(); e.stopPropagation();
    if (busy) return;
    const next = !on;
    setOn(next); setBusy(true); // optimistic
    try {
      const r = await api<{ favorite: boolean }>(`/api/recipes/${recipeId}/favorite`, { method: "POST" });
      setOn(r.favorite); onChange?.(r.favorite); router.refresh();
    } catch (err) { setOn(!next); fail(err); } finally { setBusy(false); }
  }
  return (
    <button type="button" onClick={toggle} aria-pressed={on} aria-label={on ? "Remove from favorites" : "Add to favorites"}
      className={cn("tap flex items-center justify-center rounded-full bg-card/90 shadow-soft backdrop-blur transition-transform active:scale-90", className)}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span key={String(on)} initial={{ scale: 0.6 }} animate={{ scale: on ? [1, 1.35, 1] : 1 }} transition={{ duration: 0.28 }}>
          <Heart className={cn("h-5 w-5", on ? "fill-accent stroke-accent" : "stroke-foreground")} />
        </motion.span>
      </AnimatePresence>
    </button>
  );
}
