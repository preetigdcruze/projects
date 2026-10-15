"use client";
import { useState } from "react";
import { Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RecipeForm, type Draft } from "@/components/app/recipe-form";
import { api, ApiError } from "@/lib/client";

export function ImportRecipe() {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  async function go(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try { setDraft((await api<{ draft: Draft }>("/api/recipes/import", { body: { url: url.trim() } })).draft); }
    catch (err) { setError(err instanceof ApiError ? err.message : "We couldn't import that link."); }
    finally { setBusy(false); }
  }
  return (
    <div className="space-y-6">
      <form onSubmit={go} className="flex gap-2">
        <div className="relative flex-1"><Link2 className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/recipe" inputMode="url" aria-label="Recipe link" className="pl-10" required /></div>
        <Button type="submit" loading={busy} className="h-12">Import</Button>
      </form>
      {error && <p role="alert" className="rounded-2xl bg-danger/10 px-4 py-3 text-sm text-danger">{error} You can still <a className="font-semibold underline" href="/recipes/new">add it manually</a>.</p>}
      {draft && <><p className="rounded-2xl bg-secondary px-4 py-3 text-sm text-secondary-foreground">Imported — please check the details before saving. Nutrition is estimated if the page didn't include it.</p><RecipeForm draft={draft} /></>}
    </div>
  );
}
