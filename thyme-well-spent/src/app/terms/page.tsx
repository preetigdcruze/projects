import Link from "next/link";

export const metadata = { title: "Terms of service" };

export default function Terms() {
  return (
    <main className="mx-auto max-w-2xl space-y-4 px-6 py-12 leading-relaxed">
      <Link href="/" className="text-sm text-muted-foreground underline">← Back</Link>
      <h1 className="text-4xl font-semibold">Terms of service</h1>
      <p className="text-sm text-muted-foreground">Template text — have your own legal counsel review it before launch.</p>
      <h2 className="pt-4 text-xl font-semibold">Using Thyme</h2>
      <p>Thyme helps you plan meals, shop and track what you eat. You're responsible for your account and for the accuracy of the information you enter.</p>
      <h2 className="pt-4 text-xl font-semibold">Not medical advice</h2>
      <p>Nutrition targets, calorie counts and photo-based estimates are approximations for general planning. They aren't medical, dietetic or allergy advice. Always check ingredient labels if you have allergies and speak to a qualified professional about health needs.</p>
      <h2 className="pt-4 text-xl font-semibold">Subscriptions</h2>
      <p>Free and Pro plans differ in features and limits. Paid plans, when available, renew until cancelled.</p>
      <h2 className="pt-4 text-xl font-semibold">Your content</h2>
      <p>Recipes and notes you add remain yours. You can export or delete your data at any time from Settings.</p>
    </main>
  );
}
