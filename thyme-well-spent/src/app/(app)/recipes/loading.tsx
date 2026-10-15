import { RecipeCardSkeleton, Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-5" aria-busy aria-label="Loading recipes">
      <Skeleton className="h-10 w-40" /><Skeleton className="h-12 w-full rounded-full" />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">{Array.from({ length: 8 }).map((_, i) => <RecipeCardSkeleton key={i} />)}</div>
    </div>
  );
}
