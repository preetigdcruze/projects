"use client";
import { useState } from "react";
import { X } from "lucide-react";
import { Input } from "./input";

/** Free-text list input: type, press Enter/comma to add. Used for allergies, exclusions, dislikes. */
export function TagInput({ value, onChange, placeholder, label, suggestions }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; label: string; suggestions?: string[] }) {
  const [text, setText] = useState("");
  const add = (raw: string) => {
    const items = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!items.length) return;
    onChange([...new Set([...value, ...items])].slice(0, 40)); setText("");
  };
  return (
    <div className="space-y-2.5">
      <div className="flex gap-2">
        <Input value={text} aria-label={label} placeholder={placeholder} onChange={(e) => setText(e.target.value.endsWith(",") ? (add(e.target.value), "") : e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(text); } else if (e.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1)); }} onBlur={() => add(text)} />
      </div>
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label={`${label} list`}>
          {value.map((v) => (
            <li key={v} className="inline-flex items-center gap-1 rounded-full bg-secondary py-1.5 pl-3.5 pr-1.5 text-sm font-medium text-secondary-foreground">
              {v}<button type="button" onClick={() => onChange(value.filter((x) => x !== v))} aria-label={`Remove ${v}`} className="flex h-6 w-6 items-center justify-center rounded-full hover:bg-black/10"><X className="h-3.5 w-3.5" /></button>
            </li>
          ))}
        </ul>
      )}
      {suggestions && (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.filter((s) => !value.includes(s)).map((s) => <button key={s} type="button" onClick={() => add(s)} className="rounded-full border border-dashed border-border px-3 py-1 text-xs text-muted-foreground hover:bg-muted">+ {s}</button>)}
        </div>
      )}
    </div>
  );
}
