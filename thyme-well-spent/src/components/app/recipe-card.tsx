import Link from "next/link";
import { Clock, Flame } from "lucide-react";
import { FoodImage } from "@/components/ui/food-image";
import { HeartButton } from "@/components/ui/heart-button";
import { Tag } from "@/components/ui/chip";
import { DIET_LABEL } from "@/lib/diet";
import type { RecipeCard as Card } from "@/server/services/recipes";

export function RecipeCard({ r, compact }: { r: Card; compact?: boolean }) {
  return (
    <article className="group relative">
      <Link href={`/recipes/${r.id}`} className="block rounded-2xl focus-visible:ring-offset-4">
        <div className="relative overflow-hidden rounded-2xl shadow-soft transition-transform duration-300 group-hover:-translate-y-0.5 group-hover:shadow-lift">
          <FoodImage title={r.title} cuisine={r.cuisine} image={r.image} className={compact ? "aspect-[5/4] w-full" : "aspect-[4/3] w-full"} emojiClass={compact ? "text-5xl" : "text-6xl"} />
          {r.isMine && <span className="absolute left-2.5 top-2.5 rounded-full bg-card/90 px-2.5 py-1 text-[11px] font-semibold shadow-soft">My recipe</span>}
        </div>
        <h3 className="mt-3 line-clamp-2 text-[17px] font-semibold leading-snug">{r.title}</h3>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" aria-hidden />{r.totalTime} min</span>
          <span className="inline-flex items-center gap-1"><Flame className="h-3.5 w-3.5" aria-hidden />{r.calories} kcal</span>
          <span>{r.protein}g protein</span>
        </p>
        {!compact && <div className="mt-2 flex flex-wrap gap-1.5"><Tag>{r.cuisine}</Tag><Tag>{DIET_LABEL[r.dietType] ?? r.dietType}</Tag></div>}
      </Link>
      <HeartButton recipeId={r.id} initial={r.isFavorite} className="absolute right-2.5 top-2.5 h-10 w-10" />
    </article>
  );
}
