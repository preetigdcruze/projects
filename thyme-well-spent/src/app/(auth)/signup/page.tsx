import { redirect } from "next/navigation";
import { auth, oauthProviders } from "@/auth";
import { SignupForm } from "./signup-form";

export const metadata = { title: "Create account" };

export default async function SignupPage() {
  if ((await auth())?.user) redirect("/");
  return <SignupForm oauth={oauthProviders} />;
}
