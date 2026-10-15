import { NextRequest, NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { auth } from "@/auth";
import { AppError, unauthorized } from "@/lib/errors";

type Ctx<P> = { userId: string; req: NextRequest; params: P };

export async function currentUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}

export function errorResponse(e: unknown) {
  if (e instanceof AppError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
  if (e instanceof ZodError) return NextResponse.json({ error: "Some details look off. Please check your entries and try again.", code: "invalid" }, { status: 400 });
  console.error("[api]", e); // log server-side only; never expose raw errors to users
  return NextResponse.json({ error: "Something went wrong on our side. Please try again.", code: "server_error" }, { status: 500 });
}

/** Authenticated route wrapper: resolves the user from the session, converts errors to safe JSON. */
export function route<P = Record<string, never>>(fn: (c: Ctx<P>) => Promise<unknown>) {
  return async (req: NextRequest, ctx: { params: Promise<P> }) => {
    try {
      const userId = await currentUserId();
      if (!userId) throw unauthorized();
      const out = await fn({ userId, req, params: await ctx.params });
      return NextResponse.json(out ?? { ok: true });
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export async function body<T>(req: NextRequest, schema: ZodType<T>): Promise<T> {
  return schema.parse(await req.json().catch(() => ({})));
}
export const query = (req: NextRequest) => Object.fromEntries(req.nextUrl.searchParams.entries());
