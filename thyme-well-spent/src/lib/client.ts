"use client";
import { toast } from "sonner";

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

/** Thin fetch wrapper: JSON in/out, friendly errors (the server never leaks raw errors). */
export async function api<T = unknown>(url: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method: opts.method ?? (opts.body ? "POST" : "GET"), headers: opts.body instanceof FormData ? undefined : { "content-type": "application/json" }, body: opts.body instanceof FormData ? opts.body : opts.body ? JSON.stringify(opts.body) : undefined });
  } catch {
    throw new ApiError("You seem to be offline. Check your connection and try again.", 0, "offline");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? "Something went wrong. Please try again.", res.status, data.code);
  return data as T;
}

export function fail(e: unknown) {
  toast.error(e instanceof Error ? e.message : "Something went wrong. Please try again.");
}
