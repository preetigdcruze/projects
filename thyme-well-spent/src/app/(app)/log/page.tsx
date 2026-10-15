import { Suspense } from "react";
import { LogFood } from "./log-food";

export const metadata = { title: "Add food" };

export default async function LogPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const sp = await searchParams;
  return <Suspense><LogFood initialTab={sp.tab === "scan" ? "scan" : sp.tab === "quick" ? "quick" : "search"} /></Suspense>;
}
