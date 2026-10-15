import Link from "next/link";

export const metadata = { title: "Privacy policy" };

export default function Privacy() {
  return (
    <main className="mx-auto max-w-2xl space-y-4 px-6 py-12 leading-relaxed">
      <Link href="/" className="text-sm text-muted-foreground underline">← Back</Link>
      <h1 className="text-4xl font-semibold">Privacy policy</h1>
      <p className="text-sm text-muted-foreground">Template text — have your own legal counsel review it before launch.</p>
      <h2 className="pt-4 text-xl font-semibold">What we store</h2>
      <p>Your account details, food preferences, meal plans, logs, pantry, grocery lists and assistant conversations. Each account's data is private to that account.</p>
      <h2 className="pt-4 text-xl font-semibold">How it's used</h2>
      <p>To personalise plans and recommendations. If an AI provider is enabled, the context needed to answer your request (such as your diet, plan and pantry) is sent to that provider. In the default demo mode nothing leaves the server.</p>
      <h2 className="pt-4 text-xl font-semibold">Your controls</h2>
      <p>Download a copy of your data or delete your account permanently from Settings → Privacy.</p>
    </main>
  );
}
