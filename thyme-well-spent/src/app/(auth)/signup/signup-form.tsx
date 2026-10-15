"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { api } from "@/lib/client";

const schema = z.object({ name: z.string().trim().min(1, "What should we call you?"), email: z.string().email("Enter a valid email."), password: z.string().min(8, "Use at least 8 characters.") });
type V = z.infer<typeof schema>;

export function SignupForm({ oauth }: { oauth: { google: boolean; apple: boolean } }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<V>({ resolver: zodResolver(schema) });

  async function submit(v: V) {
    setError(null);
    try {
      await api("/api/signup", { body: v });
      const res = await signIn("credentials", { email: v.email.toLowerCase(), password: v.password, redirect: false });
      if (res?.error) throw new Error("Your account was created, but we couldn't sign you in. Please sign in manually.");
      router.replace("/onboarding"); router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Something went wrong."); }
  }

  return (
    <div>
      <h1 className="text-3xl font-semibold">Let's get you eating well</h1>
      <p className="mt-1.5 text-muted-foreground">Create your free account. It takes a minute.</p>
      <form onSubmit={handleSubmit(submit)} className="mt-8 space-y-4" noValidate>
        <Field label="First name" htmlFor="name"><Input id="name" autoComplete="given-name" aria-invalid={!!errors.name} {...register("name")} />{errors.name && <p role="alert" className="text-sm text-danger">{errors.name.message}</p>}</Field>
        <Field label="Email" htmlFor="email"><Input id="email" type="email" autoComplete="email" inputMode="email" aria-invalid={!!errors.email} {...register("email")} />{errors.email && <p role="alert" className="text-sm text-danger">{errors.email.message}</p>}</Field>
        <Field label="Password" htmlFor="password" hint="At least 8 characters."><Input id="password" type="password" autoComplete="new-password" aria-invalid={!!errors.password} {...register("password")} />{errors.password && <p role="alert" className="text-sm text-danger">{errors.password.message}</p>}</Field>
        {error && <p role="alert" className="rounded-2xl bg-danger/10 px-4 py-3 text-sm text-danger">{error}</p>}
        <Button type="submit" size="lg" className="w-full" loading={isSubmitting}>Create account</Button>
      </form>
      {(oauth.google || oauth.apple) && (
        <div className="mt-5 space-y-3">
          <div className="flex items-center gap-3 text-xs text-muted-foreground"><span className="h-px flex-1 bg-border" />or<span className="h-px flex-1 bg-border" /></div>
          {oauth.google && <Button variant="outline" size="lg" className="w-full" onClick={() => signIn("google", { callbackUrl: "/onboarding" })}>Continue with Google</Button>}
          {oauth.apple && <Button variant="outline" size="lg" className="w-full" onClick={() => signIn("apple", { callbackUrl: "/onboarding" })}>Continue with Apple</Button>}
        </div>
      )}
      <p className="mt-6 text-center text-xs text-muted-foreground">By continuing you agree to our <Link href="/terms" className="underline">Terms</Link> and <Link href="/privacy" className="underline">Privacy Policy</Link>.</p>
      <p className="mt-4 text-center text-sm text-muted-foreground">Already have an account? <Link href="/login" className="font-semibold text-primary underline-offset-4 hover:underline">Sign in</Link></p>
    </div>
  );
}
