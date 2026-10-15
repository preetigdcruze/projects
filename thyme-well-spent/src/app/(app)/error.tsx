"use client";
import { ErrorState } from "@/components/ui/states";

export default function Error({ reset }: { error: Error; reset: () => void }) {
  return <div className="py-10"><ErrorState title="We couldn't load this page." body="It's probably a hiccup on our side. Give it another go." onRetry={reset} /></div>;
}
