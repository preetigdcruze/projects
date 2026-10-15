import Link from "next/link";
import { cn } from "@/lib/utils";

export function ShopTabs({ active }: { active: "grocery" | "pantry" }) {
  return (
    <nav aria-label="Shopping sections" className="inline-flex rounded-full bg-muted p-1">
      {([["grocery", "Shopping list", "/grocery"], ["pantry", "Pantry", "/pantry"]] as const).map(([k, l, h]) => (
        <Link key={k} href={h} aria-current={active === k ? "page" : undefined} className={cn("tap flex items-center rounded-full px-5 py-1.5 text-sm font-medium transition-all", active === k ? "bg-card shadow-soft" : "text-muted-foreground hover:text-foreground")}>{l}</Link>
      ))}
    </nav>
  );
}
