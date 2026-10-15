import * as React from "react";
import { AlertCircle } from "lucide-react";
import { Button } from "./button";

export function EmptyState({ emoji = "🍽️", title, body, action }: { emoji?: string; title: string; body?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-3xl border border-dashed border-border bg-card/60 px-6 py-12 text-center">
      <div className="mb-4 text-5xl" aria-hidden>{emoji}</div>
      <h3 className="text-xl font-semibold">{title}</h3>
      {body && <p className="mt-1.5 max-w-sm text-[15px] text-muted-foreground">{body}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

export function ErrorState({ title = "Something went wrong.", body = "Please try again in a moment.", onRetry }: { title?: string; body?: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center rounded-3xl bg-card px-6 py-10 text-center shadow-soft">
      <AlertCircle className="mb-3 h-9 w-9 text-danger" aria-hidden />
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="mt-1 text-[15px] text-muted-foreground">{body}</p>
      {onRetry && <Button className="mt-5" variant="outline" onClick={onRetry}>Try again</Button>}
    </div>
  );
}
