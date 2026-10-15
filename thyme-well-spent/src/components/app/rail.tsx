import { RecipeCard } from "./recipe-card";
import type { Section } from "@/server/services/recommendations";

export function Rail({ section }: { section: Section }) {
  return (
    <section aria-labelledby={`rail-${section.id}`} className="space-y-3">
      <div>
        <h2 id={`rail-${section.id}`} className="text-xl font-semibold">{section.title}</h2>
        {section.subtitle && <p className="text-sm text-muted-foreground">{section.subtitle}</p>}
      </div>
      <ul className="-mx-4 flex snap-x gap-4 overflow-x-auto px-4 pb-3 no-scrollbar md:-mx-8 md:px-8">
        {section.recipes.map((r) => <li key={r.id} className="w-[220px] shrink-0 snap-start md:w-[250px]"><RecipeCard r={r} compact /></li>)}
      </ul>
    </section>
  );
}
