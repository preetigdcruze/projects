"use client";
import { ProgressRing, MacroBar } from "@/components/ui/progress-ring";

export function DayProgress({ consumed, targets }: { consumed: { calories: number; protein: number; carbs: number; fat: number }; targets: { calories: number; proteinG: number; carbsG: number; fatG: number } }) {
  const left = targets.calories - consumed.calories;
  return (
    <section aria-label="Today's nutrition" className="rounded-3xl bg-card p-5 shadow-soft">
      <div className="flex items-center gap-5">
        <ProgressRing value={consumed.calories} max={targets.calories} size={112} stroke={10}>
          <span className="text-2xl font-semibold tabular-nums leading-none">{consumed.calories.toLocaleString()}</span>
          <span className="mt-1 text-[11px] text-muted-foreground">of {targets.calories.toLocaleString()}</span>
        </ProgressRing>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Calories</p>
          <p className="mt-0.5 font-display text-xl font-semibold leading-snug">{left >= 0 ? `${left.toLocaleString()} kcal left` : `${Math.abs(left).toLocaleString()} kcal over`}</p>
          <p className="mt-1 text-sm text-muted-foreground">{consumed.calories === 0 ? "Nothing logged yet — start with breakfast." : left >= 0 ? "You're doing great today." : "No stress — tomorrow's a fresh start."}</p>
        </div>
      </div>
      <div className="mt-5 flex gap-4">
        <MacroBar label="Protein" value={consumed.protein} target={targets.proteinG} color="protein" />
        <MacroBar label="Carbs" value={consumed.carbs} target={targets.carbsG} color="carbs" />
        <MacroBar label="Fat" value={consumed.fat} target={targets.fatG} color="fat" />
      </div>
    </section>
  );
}
