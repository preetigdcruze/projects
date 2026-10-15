import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return <div className="space-y-4" aria-busy aria-label="Loading your list"><Skeleton className="h-10 w-48" /><Skeleton className="h-24 w-full rounded-3xl" />{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>;
}
