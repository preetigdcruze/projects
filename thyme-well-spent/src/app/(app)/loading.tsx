import { MealCardSkeleton, Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-5" aria-busy aria-label="Loading">
      <Skeleton className="h-9 w-56" /><Skeleton className="h-44 w-full rounded-3xl" />
      <MealCardSkeleton /><MealCardSkeleton /><MealCardSkeleton />
    </div>
  );
}
