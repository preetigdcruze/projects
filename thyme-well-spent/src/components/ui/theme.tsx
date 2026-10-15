"use client";
import { useEffect } from "react";

export function applyTheme(t: string) {
  const dark = t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  try { localStorage.setItem("theme", t); } catch { /* storage unavailable */ }
}

export function ThemeSync({ theme }: { theme?: string }) {
  useEffect(() => { if (theme) applyTheme(theme); }, [theme]);
  return null;
}

/** Runs before paint to avoid a flash of the wrong theme. */
export const themeScript = `try{var t=localStorage.getItem('theme')||'system';var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d)}catch(e){}`;
