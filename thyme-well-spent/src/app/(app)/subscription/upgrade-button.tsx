"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/client";

export function UpgradeButton() {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-3">
      <Button size="lg" className="w-full md:w-auto" loading={busy} onClick={async () => { setBusy(true); try { await api("/api/subscription/checkout", { method: "POST", body: {} }); } catch (e) { setMsg(e instanceof ApiError ? e.message : "Something went wrong."); } finally { setBusy(false); } }}>Upgrade to Pro</Button>
      {msg && <p role="status" className="rounded-2xl bg-muted px-4 py-3 text-sm">{msg}</p>}
    </div>
  );
}
