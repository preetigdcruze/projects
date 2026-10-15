import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { errorResponse } from "@/lib/api";

const schema = z.object({ name: z.string().trim().min(1).max(80), email: z.string().trim().toLowerCase().email().max(200), password: z.string().min(8, "Use at least 8 characters.").max(200) });

export async function POST(req: NextRequest) {
  try {
    const parsed = schema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message ?? "Please check your details.");
    const { name, email, password } = parsed.data;
    if (await prisma.user.findUnique({ where: { email } })) throw new AppError("An account with that email already exists. Try signing in.", 409, "exists");
    await prisma.user.create({
      data: { name, email, passwordHash: await bcrypt.hash(password, 10), profile: { create: {} }, subscription: { create: { plan: "free" } }, notifications: { create: {} } },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
