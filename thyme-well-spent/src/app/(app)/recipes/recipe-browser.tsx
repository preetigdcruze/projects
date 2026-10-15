"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Link2, Plus, Search, SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Input, Select } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { RecipeCardSkeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { RecipeCard } from "@/components/app/recipe-card";
import { CUISINES } from "@/components/app/generate-sheet";
import { api } from "@/lib/client";
import type { RecipeCard as Card } from "@/server/services/recipes";

type Result = { total: number; hasMore: boolean; items: Card[]; page: number };

const COLLECTIONS = [
  ["recommended", "Recommended"], ["popular", "Popular"], ["quick", "Quick"], ["high-protein", "High protein"], ["low-calorie", "Low calorie"], ["vegetarian", "Vegetarian"], ["vegan", "Vegan"],
  ["breakfast", "Breakfast"], ["lunch", "Lunch"], ["dinner", "Dinner"], ["snacks", "Snacks"], ["desserts", "Desserts"], ["favorites", "Favorites"], ["mine", "My recipes"],
] as const;

const EMPTY_COPY: Record<string, { emoji: string; title: string; body: string }> = {
  favorites: { emoji: "💚", title: "No favorites yet", body: "Tap the heart on any recipe and it will show up here." },
  mine: { emoji: "📖", title: "No recipes of your own yet", body: "Create one from scratch or import it from a link." },
};

export function RecipeBrowser({ initial, initialQuery, initialCollection }: { initial: Result; initialQuery: string; initialCollection: string }) {
  const [q, setQ] = useState(initialQuery);
  const [collection, setCollection] = useState(initialCollection);
  const [filters, setFilters] = useState({ cuisine: "", maxTime: "", maxCalories: "", minProtein: "", diet: "", sort: "" });
  const [res, setRes] = useState<Result>(initial);
  const [loading, setLoading] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const first = useRef(true);

  const run = useCallback(async (page: number) => {
    const p = new URLSearchParams({ page: String(page), pageSize: "24" });
    if (q.trim()) p.set("q", q.trim());
    if (collection !== "recommended") p.set("collection", collection);
    Object.entries(filters).forEach(([k, v]) => v && p.set(k, v));
    return api<Result>(`/api/recipes?${p}`);
  }, [q, collection, filters]);

  // Debounced search / filter changes
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setLoading(true); setError(false);
    const t = setTimeout(async () => {
      try { setRes(await run(1)); } catch { setError(true); } finally { setLoading(false); }
    }, 300);
    return () => clearTimeout(t);
  }, [run]);

  async function loadMore() {
    setMore(true);
    try { const r = await run(res.page + 1); setRes({ ...r, items: [...res.items, ...r.items] }); } catch { setError(true); } finally { setMore(false); }
  }
  const activeFilters = Object.values(filters).filter(Boolean).length;
  const empty = EMPTY_COPY[collection] ?? { emoji: "🔍", title: "No recipes match", body: "Try fewer filters, or search by an ingredient like “chicken”." };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-3xl font-semibold">Recipes</h1><p className="text-muted-foreground">{res.total} recipes{q ? ` for “${q}”` : ""}</p></div>
        <div className="flex gap-2">
          <Button asChild variant="outline" size="sm"><Link href="/recipes/import"><Link2 className="h-4 w-4" />Import</Link></Button>
          <Button asChild size="sm"><Link href="/recipes/new"><Plus className="h-4 w-4" />New recipe</Link></Button>
        </div>
      </header>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Try “high protein vegetarian under 30 minutes”" className="h-12 rounded-full pl-12 pr-10" aria-label="Search recipes" type="search" enterKeyHint="search" />
          {q && <button onClick={() => setQ("")} aria-label="Clear search" className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full hover:bg-muted"><X className="h-4 w-4" /></button>}
        </div>
        <Button variant="outline" size="icon" className="relative h-12 w-12" onClick={() => setFilterOpen(true)} aria-label="Filters">
          <SlidersHorizontal className="h-5 w-5" />{activeFilters > 0 && <span className="absolute -right-0.5 -top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-[11px] font-bold text-white">{activeFilters}</span>}
        </Button>
      </div>

      <div role="group" aria-label="Collections" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 no-scrollbar md:mx-0 md:flex-wrap md:px-0">
        {COLLECTIONS.map(([v, l]) => <Chip key={v} active={collection === v} onClick={() => setCollection(v)}>{l}</Chip>)}
      </div>

      {error ? <ErrorState title="Couldn't load recipes." onRetry={() => { setError(false); setLoading(true); run(1).then(setRes).catch(() => setError(true)).finally(() => setLoading(false)); }} />
        : loading ? <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4" aria-busy>{Array.from({ length: 8 }).map((_, i) => <RecipeCardSkeleton key={i} />)}</div>
        : res.items.length === 0 ? <EmptyState {...empty} action={collection === "mine" ? <Button asChild><Link href="/recipes/new">Create a recipe</Link></Button> : activeFilters || q ? <Button variant="outline" onClick={() => { setQ(""); setFilters({ cuisine: "", maxTime: "", maxCalories: "", minProtein: "", diet: "", sort: "" }); }}>Clear search &amp; filters</Button> : undefined} />
        : (
          <>
            <ul className="grid grid-cols-2 gap-x-4 gap-y-7 md:grid-cols-3 lg:grid-cols-4">{res.items.map((r) => <li key={r.id}><RecipeCard r={r} /></li>)}</ul>
            {res.hasMore && <div className="flex justify-center pt-2"><Button variant="outline" onClick={loadMore} loading={more}>Show more recipes</Button></div>}
          </>
        )}

      <Sheet open={filterOpen} onOpenChange={setFilterOpen} title="Filters" description="Narrow things down — works with favorites too.">
        <div className="space-y-5 pb-4">
          <div><p className="mb-2 text-sm font-semibold">Cuisine</p><div className="flex flex-wrap gap-2">{CUISINES.map((c) => <Chip key={c} active={filters.cuisine === c} onClick={() => setFilters((f) => ({ ...f, cuisine: f.cuisine === c ? "" : c }))}>{c}</Chip>)}</div></div>
          <div><p className="mb-2 text-sm font-semibold">Diet</p><div className="flex flex-wrap gap-2">{[["vegetarian", "Vegetarian"], ["vegan", "Vegan"], ["eggetarian", "Eggetarian"], ["pescatarian", "Pescatarian"], ["keto", "Keto"], ["low_carb", "Low carb"]].map(([v, l]) => <Chip key={v} active={filters.diet === v} onClick={() => setFilters((f) => ({ ...f, diet: f.diet === v ? "" : v }))}>{l}</Chip>)}</div></div>
          <div><p className="mb-2 text-sm font-semibold">Total time</p><div className="flex flex-wrap gap-2">{["15", "30", "45", "60"].map((v) => <Chip key={v} active={filters.maxTime === v} onClick={() => setFilters((f) => ({ ...f, maxTime: f.maxTime === v ? "" : v }))}>≤ {v} min</Chip>)}</div></div>
          <div><p className="mb-2 text-sm font-semibold">Calories per serving</p><div className="flex flex-wrap gap-2">{["300", "450", "600"].map((v) => <Chip key={v} active={filters.maxCalories === v} onClick={() => setFilters((f) => ({ ...f, maxCalories: f.maxCalories === v ? "" : v }))}>≤ {v}</Chip>)}</div></div>
          <div><p className="mb-2 text-sm font-semibold">Protein per serving</p><div className="flex flex-wrap gap-2">{["20", "30", "40"].map((v) => <Chip key={v} active={filters.minProtein === v} onClick={() => setFilters((f) => ({ ...f, minProtein: f.minProtein === v ? "" : v }))}>≥ {v}g</Chip>)}</div></div>
          <div><p className="mb-2 text-sm font-semibold">Sort by</p><Select value={filters.sort} onChange={(e) => setFilters((f) => ({ ...f, sort: e.target.value }))} aria-label="Sort"><option value="">Best match</option><option value="popular">Most popular</option><option value="rating">Top rated</option><option value="quickest">Quickest</option><option value="protein">Most protein</option><option value="calories">Fewest calories</option><option value="newest">Newest</option></Select></div>
          <div className="flex gap-3"><Button variant="outline" className="flex-1" onClick={() => setFilters({ cuisine: "", maxTime: "", maxCalories: "", minProtein: "", diet: "", sort: "" })}>Reset</Button><Button className="flex-1" onClick={() => setFilterOpen(false)}>Show {res.total} recipes</Button></div>
        </div>
      </Sheet>
    </div>
  );
}
