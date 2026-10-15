import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn("relative overflow-hidden rounded-xl bg-muted", className)}>
      <div className="absolute inset-0 -translate-x-full animate-shimmer bg-gradient-to-r from-transparent via-white/40 to-transparent dark:via-white/10" />
    </div>
  );
}

export function RecipeCardSkeleton() {
  return <div className="space-y-3"><Skeleton className="aspect-[4/3] w-full rounded-2xl" /><Skeleton className="h-4 w-3/4" /><Skeleton className="h-3 w-1/2" /></div>;
}
export function MealCardSkeleton() {
  return <div className="flex gap-4 rounded-3xl bg-card p-3 shadow-soft"><Skeleton className="h-24 w-24 shrink-0 rounded-2xl" /><div className="flex-1 space-y-2 py-1"><Skeleton className="h-3 w-16" /><Skeleton className="h-5 w-3/4" /><Skeleton className="h-3 w-1/2" /></div></div>;
}
