import { MealCardSkeleton, Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-5" aria-busy aria-label="Loading your plan">
      <Skeleton className="h-10 w-48" />
      <div className="flex gap-2">{[0, 1, 2, 3, 4, 5, 6].map((i) => <Skeleton key={i} className="h-20 w-16 shrink-0 rounded-2xl" />)}</div>
      <MealCardSkeleton /><MealCardSkeleton /><MealCardSkeleton /><MealCardSkeleton />
    </div>
  );
}
