import { route } from "@/lib/api";
import { AppError } from "@/lib/errors";

// Billing hook. Wire Stripe / App Store / Play Billing here and flip Subscription.plan from a *verified webhook* only.
// We never mark a user Pro from the client, and we never fake a payment confirmation.
export const POST = route(async () => {
  if (!process.env.STRIPE_SECRET_KEY) throw new AppError("Payments aren't set up yet, so upgrades are unavailable for now.", 501, "payments_unconfigured");
  throw new AppError("Checkout isn't implemented yet.", 501, "not_implemented");
});
