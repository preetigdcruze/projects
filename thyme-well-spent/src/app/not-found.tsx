import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-6 text-center">
      <div className="text-6xl" aria-hidden>🌿</div>
      <h1 className="mt-4 text-3xl font-semibold">We couldn't find that page</h1>
      <p className="mt-2 text-muted-foreground">It may have moved, or the link might be off.</p>
      <Button asChild className="mt-6"><Link href="/">Back to today</Link></Button>
    </main>
  );
}
