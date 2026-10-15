import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";

/** For server components/pages: returns the signed-in user id or redirects to /login. */
export async function requireUserId(): Promise<string> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) redirect("/login");
  // A deleted account with a still-valid JWT must not be treated as signed in.
  const exists = await prisma.user.findUnique({ where: { id }, select: { id: true } });
  if (!exists) redirect("/login");
  return id;
}
