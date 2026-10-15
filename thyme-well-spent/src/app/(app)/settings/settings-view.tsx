"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { ArrowLeft, Download, LogOut, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { applyTheme } from "@/components/ui/theme";
import { api, fail } from "@/lib/client";
import { toast } from "sonner";

type N = { enabled: boolean; morningMeal: boolean; mealReminder: boolean; groceryReminder: boolean; weeklyPlanning: boolean; expiring: boolean; mealPrep: boolean };
const NOTIFS: [keyof Omit<N, "enabled">, string, string][] = [
  ["morningMeal", "Morning meal reminder", "A nudge with today's breakfast"], ["mealReminder", "Meal reminders", "Before lunch and dinner"], ["groceryReminder", "Grocery reminder", "Before your usual shopping day"],
  ["weeklyPlanning", "Weekly planning reminder", "Sunday: plan the week ahead"], ["expiring", "Expiring ingredients", "When pantry items need using"], ["mealPrep", "Meal prep reminder", "Batch-cooking days"],
];

function Switch({ checked, onChange, label, sub, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; sub?: string; disabled?: boolean }) {
  return (
    <div className={`flex min-h-14 items-center justify-between gap-4 px-5 py-2.5 ${disabled ? "opacity-50" : ""}`}>
      <div><p className="font-medium">{label}</p>{sub && <p className="text-sm text-muted-foreground">{sub}</p>}</div>
      <button role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${checked ? "bg-primary" : "bg-border"}`}><span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all ${checked ? "left-6" : "left-1"}`} /></button>
    </div>
  );
}

export function SettingsView(p: { units: string; currency: string; theme: string; email: string; notifications: N; prefs: { usePantry: boolean; preferVariety: boolean; useLeftovers: boolean } }) {
  const router = useRouter();
  const [units, setUnits] = useState(p.units);
  const [currency, setCurrency] = useState(p.currency);
  const [theme, setTheme] = useState(p.theme);
  const [n, setN] = useState(p.notifications);
  const [prefs, setPrefs] = useState(p.prefs);
  const [del, setDel] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const patch = async (body: Record<string, unknown>, ok?: string) => { try { await api("/api/profile", { method: "PATCH", body }); if (ok) toast.success(ok); router.refresh(); } catch (e) { fail(e); } };

  return (
    <div className="mx-auto max-w-2xl space-y-7">
      <header className="flex items-center gap-3"><Link href="/profile" aria-label="Back to profile" className="tap flex items-center justify-center rounded-full bg-muted"><ArrowLeft className="h-5 w-5" /></Link><h1 className="text-3xl font-semibold">Settings</h1></header>

      <section aria-labelledby="disp"><h2 id="disp" className="mb-2 px-1 font-sans text-xs font-bold uppercase tracking-wider text-muted-foreground">Display</h2>
        <div className="space-y-5 rounded-3xl bg-card p-5 shadow-soft">
          <div><p className="mb-2 font-medium">Units</p><div className="flex gap-2">{[["metric", "Metric"], ["imperial", "Imperial"]].map(([v, l]) => <Chip key={v} active={units === v} onClick={() => { setUnits(v); void patch({ units: v }); }}>{l}</Chip>)}</div></div>
          <div><p className="mb-2 font-medium">Currency</p><div className="flex flex-wrap gap-2">{["INR", "USD", "GBP", "EUR"].map((c) => <Chip key={c} active={currency === c} onClick={() => { setCurrency(c); void patch({ currency: c }, "Currency updated"); }}>{c}</Chip>)}</div></div>
          <div><p className="mb-2 font-medium">Theme</p><div className="flex gap-2">{["system", "light", "dark"].map((t) => <Chip key={t} active={theme === t} onClick={() => { setTheme(t); applyTheme(t); void patch({ theme: t }); }}>{t[0].toUpperCase() + t.slice(1)}</Chip>)}</div></div>
        </div></section>

      <section aria-labelledby="plan-h"><h2 id="plan-h" className="mb-2 px-1 font-sans text-xs font-bold uppercase tracking-wider text-muted-foreground">Planning defaults</h2>
        <div className="divide-y divide-border rounded-3xl bg-card shadow-soft">
          <Switch label="Use pantry ingredients" sub="Prefer meals that use what you have" checked={prefs.usePantry} onChange={(v) => { setPrefs({ ...prefs, usePantry: v }); void patch({ usePantry: v }); }} />
          <Switch label="Maximize variety" sub="Avoid repeating meals" checked={prefs.preferVariety} onChange={(v) => { setPrefs({ ...prefs, preferVariety: v }); void patch({ preferVariety: v }); }} />
          <Switch label="Use leftovers" sub="Cook once, eat twice" checked={prefs.useLeftovers} onChange={(v) => { setPrefs({ ...prefs, useLeftovers: v }); void patch({ useLeftovers: v }); }} />
        </div></section>

      <section aria-labelledby="notif"><h2 id="notif" className="mb-2 px-1 font-sans text-xs font-bold uppercase tracking-wider text-muted-foreground">Notifications</h2>
        <div className="divide-y divide-border rounded-3xl bg-card shadow-soft">
          <Switch label="Allow notifications" checked={n.enabled} onChange={(v) => { const x = { ...n, enabled: v }; setN(x); void patch({ notifications: x }); }} />
          {NOTIFS.map(([k, l, s]) => <Switch key={k} label={l} sub={s} disabled={!n.enabled} checked={n[k]} onChange={(v) => { const x = { ...n, [k]: v }; setN(x); void patch({ notifications: x }); }} />)}
        </div>
        <p className="mt-2 px-1 text-xs text-muted-foreground">Your choices are saved. Delivery (push / email) switches on when the app is packaged for iOS, Android or installed as a PWA.</p></section>

      <section aria-labelledby="priv"><h2 id="priv" className="mb-2 px-1 font-sans text-xs font-bold uppercase tracking-wider text-muted-foreground">Privacy &amp; account</h2>
        <div className="space-y-2 rounded-3xl bg-card p-4 shadow-soft">
          <Button asChild variant="outline" className="w-full justify-start"><a href="/api/export" download><Download className="h-4 w-4" />Download my data</a></Button>
          <Button variant="outline" className="w-full justify-start" onClick={() => signOut({ callbackUrl: "/login" })}><LogOut className="h-4 w-4" />Sign out</Button>
          <Button variant="outline" className="w-full justify-start text-danger" onClick={() => setDel(true)}><Trash2 className="h-4 w-4" />Delete my account</Button>
          <p className="px-2 pt-1 text-xs text-muted-foreground">Signed in as {p.email}</p>
        </div>
        <p className="mt-3 flex gap-4 px-1 text-sm"><Link href="/terms" className="underline">Terms of service</Link><Link href="/privacy" className="underline">Privacy policy</Link></p></section>

      <Sheet open={del} onOpenChange={setDel} title="Delete your account?" description="This permanently removes your plans, logs, pantry, recipes and conversations. It can't be undone.">
        <div className="space-y-4 pb-4">
          <label className="block text-sm font-medium" htmlFor="dc">Type <strong>DELETE</strong> to confirm</label>
          <Input id="dc" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
          <Button variant="danger" size="lg" className="w-full" disabled={confirm !== "DELETE"} loading={busy} onClick={async () => { setBusy(true); try { await api("/api/account", { method: "DELETE", body: { confirm } }); await signOut({ callbackUrl: "/login" }); } catch (e) { fail(e); setBusy(false); } }}>Permanently delete</Button>
        </div>
      </Sheet>
    </div>
  );
}
