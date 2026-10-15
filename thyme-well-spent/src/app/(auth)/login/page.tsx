import { redirect } from "next/navigation";
import { auth, oauthProviders } from "@/auth";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };

export default async function LoginPage() {
  if ((await auth())?.user) redirect("/");
  return <LoginForm oauth={oauthProviders} demo={process.env.NEXT_PUBLIC_DEMO !== "off"} />;
}
