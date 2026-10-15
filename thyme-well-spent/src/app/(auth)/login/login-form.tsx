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

const schema = z.object({ email: z.string().email("Enter a valid email."), password: z.string().min(1, "Enter your password.") });
type V = z.infer<typeof schema>;

export function LoginForm({ oauth, demo }: { oauth: { google: boolean; apple: boolean }; demo: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, setValue, formState: { errors, isSubmitting } } = useForm<V>({ resolver: zodResolver(schema) });

  async function submit(v: V) {
    setError(null);
    const res = await signIn("credentials", { ...v, email: v.email.toLowerCase(), redirect: false });
    if (res?.error) { setError("That email and password don't match. Please try again."); return; }
    router.replace("/"); router.refresh();
  }

  return (
    <div>
      <h1 className="text-3xl font-semibold">Welcome back</h1>
      <p className="mt-1.5 text-muted-foreground">Sign in to see what you're eating today.</p>
      <form onSubmit={handleSubmit(submit)} className="mt-8 space-y-4" noValidate>
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" inputMode="email" aria-invalid={!!errors.email} {...register("email")} />
          {errors.email && <p role="alert" className="text-sm text-danger">{errors.email.message}</p>}
        </Field>
        <Field label="Password" htmlFor="password">
          <Input id="password" type="password" autoComplete="current-password" aria-invalid={!!errors.password} {...register("password")} />
          {errors.password && <p role="alert" className="text-sm text-danger">{errors.password.message}</p>}
        </Field>
        {error && <p role="alert" className="rounded-2xl bg-danger/10 px-4 py-3 text-sm text-danger">{error}</p>}
        <Button type="submit" size="lg" className="w-full" loading={isSubmitting}>Sign in</Button>
      </form>
      {(oauth.google || oauth.apple) && (
        <div className="mt-5 space-y-3">
          <div className="flex items-center gap-3 text-xs text-muted-foreground"><span className="h-px flex-1 bg-border" />or<span className="h-px flex-1 bg-border" /></div>
          {oauth.google && <Button variant="outline" size="lg" className="w-full" onClick={() => signIn("google", { callbackUrl: "/" })}>Continue with Google</Button>}
          {oauth.apple && <Button variant="outline" size="lg" className="w-full" onClick={() => signIn("apple", { callbackUrl: "/" })}>Continue with Apple</Button>}
        </div>
      )}
      {demo && (
        <button type="button" className="mt-5 w-full rounded-2xl bg-secondary px-4 py-3 text-sm font-medium text-secondary-foreground" onClick={() => { setValue("email", "demo@thyme.app"); setValue("password", "demo1234"); }}>
          Try the demo account <span className="text-muted-foreground">(fills in demo@thyme.app)</span>
        </button>
      )}
      <p className="mt-8 text-center text-sm text-muted-foreground">New here? <Link href="/signup" className="font-semibold text-primary underline-offset-4 hover:underline">Create an account</Link></p>
    </div>
  );
}
