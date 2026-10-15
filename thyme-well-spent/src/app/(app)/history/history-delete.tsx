"use client";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { api, fail } from "@/lib/client";
import { toast } from "sonner";

export function HistoryDelete({ kind, id }: { kind: "meal" | "food"; id: string }) {
  const router = useRouter();
  return (
    <button aria-label="Delete entry" className="tap flex items-center justify-center rounded-full text-muted-foreground hover:bg-muted" onClick={async () => {
      try { await api(kind === "meal" ? `/api/meals/log?id=${id}` : `/api/foods/log?id=${id}`, { method: "DELETE" }); toast("Entry removed"); router.refresh(); } catch (e) { fail(e); }
    }}><Trash2 className="h-4 w-4" /></button>
  );
}
