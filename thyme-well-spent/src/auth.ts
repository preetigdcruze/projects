import NextAuth, { type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import Apple from "next-auth/providers/apple";
import type { Provider } from "next-auth/providers";
import { PrismaAdapter } from "@auth/prisma-adapter";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/db";

declare module "next-auth" {
  interface Session { user: { id: string } & DefaultSession["user"] }
}

const providers: Provider[] = [
  Credentials({
    credentials: { email: {}, password: {} },
    async authorize(raw) {
      const parsed = z.object({ email: z.string().email(), password: z.string().min(1) }).safeParse(raw);
      if (!parsed.success) return null;
      const user = await prisma.user.findUnique({ where: { email: parsed.data.email.toLowerCase() } });
      if (!user?.passwordHash) return null;
      const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
      return ok ? { id: user.id, email: user.email, name: user.name, image: user.image } : null;
    },
  }),
];
// OAuth providers switch on automatically when their credentials are present.
if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) providers.push(Google({ allowDangerousEmailAccountLinking: false }));
if (process.env.AUTH_APPLE_ID && process.env.AUTH_APPLE_SECRET) providers.push(Apple);

export const oauthProviders = { google: Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET), apple: Boolean(process.env.AUTH_APPLE_ID && process.env.AUTH_APPLE_SECRET) };

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 30 },
  pages: { signIn: "/login" },
  trustHost: true,
  providers,
  callbacks: {
    jwt({ token, user }) { if (user?.id) token.sub = user.id; return token; },
    session({ session, token }) { if (token.sub) session.user.id = token.sub; return session; },
  },
  events: {
    async createUser({ user }) {
      if (!user.id) return;
      await prisma.subscription.create({ data: { userId: user.id, plan: "free" } }).catch(() => undefined);
      await prisma.notificationPreference.create({ data: { userId: user.id } }).catch(() => undefined);
    },
  },
});
