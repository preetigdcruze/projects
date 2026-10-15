"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, CalendarDays, ChefHat, Home, Sparkles, ShoppingBasket, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { Logo } from "./logo";
import { ThemeSync } from "@/components/ui/theme";

const MAIN = [
  { href: "/", label: "Home", icon: Home, match: (p: string) => p === "/" || p.startsWith("/log") || p.startsWith("/assistant") },
  { href: "/plan", label: "Plan", icon: CalendarDays, match: (p: string) => p.startsWith("/plan") },
  { href: "/recipes", label: "Recipes", icon: ChefHat, match: (p: string) => p.startsWith("/recipes") },
  { href: "/grocery", label: "Grocery", icon: ShoppingBasket, match: (p: string) => p.startsWith("/grocery") || p.startsWith("/pantry") },
  { href: "/profile", label: "Profile", icon: User, match: (p: string) => p.startsWith("/profile") || p.startsWith("/settings") || p.startsWith("/subscription") },
];
const SIDE_EXTRA = [
  { href: "/progress", label: "Progress", icon: BarChart3, match: (p: string) => p.startsWith("/progress") || p.startsWith("/history") },
  { href: "/assistant", label: "Ask Thyme", icon: Sparkles, match: (p: string) => p.startsWith("/assistant") },
];

export function AppShell({ children, name, theme }: { children: React.ReactNode; name: string; theme: string }) {
  const path = usePathname();
  const side = [...MAIN.slice(0, 4), SIDE_EXTRA[0], SIDE_EXTRA[1], MAIN[4]];
  return (
    <div className="min-h-dvh md:flex">
      <ThemeSync theme={theme} />
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-border bg-card/60 p-5 md:flex">
        <Link href="/" className="mb-8 flex items-center gap-3 px-2"><Logo /><span className="font-display text-2xl font-semibold">Thyme</span></Link>
        <nav aria-label="Primary" className="flex flex-1 flex-col gap-1">
          {side.map((n) => {
            const active = n.match(path);
            return (
              <Link key={n.href} href={n.href} aria-current={active ? "page" : undefined}
                className={cn("flex items-center gap-3 rounded-2xl px-4 py-3 text-[15px] font-medium transition-colors", active ? "bg-primary text-primary-foreground shadow-soft" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
                <n.icon className="h-5 w-5" aria-hidden />{n.label}
              </Link>
            );
          })}
        </nav>
        <p className="px-2 text-xs text-muted-foreground">Signed in as {name}</p>
      </aside>

      <main id="main" className="min-w-0 flex-1 pb-28 md:pb-10">
        <div className="mx-auto w-full max-w-5xl px-4 pt-5 md:px-8 md:pt-8">{children}</div>
      </main>

      {/* Mobile bottom navigation */}
      <nav aria-label="Primary" className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/90 backdrop-blur-xl md:hidden">
        <ul className="mx-auto flex max-w-md items-stretch justify-around px-2 pb-safe pt-1.5">
          {MAIN.map((n) => {
            const active = n.match(path);
            return (
              <li key={n.href} className="flex-1">
                <Link href={n.href} aria-current={active ? "page" : undefined} className="flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-2xl text-[11px] font-medium">
                  <span className={cn("flex h-8 w-14 items-center justify-center rounded-full transition-all", active ? "bg-primary text-primary-foreground" : "text-muted-foreground")}><n.icon className="h-5 w-5" aria-hidden /></span>
                  <span className={active ? "text-foreground" : "text-muted-foreground"}>{n.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
