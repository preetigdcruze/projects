import { z } from "zod";
import { prisma } from "@/lib/db";
import { body, route } from "@/lib/api";
import { AppError } from "@/lib/errors";

/** Permanently deletes the account and all related data (cascades). Requires typing DELETE. */
export const DELETE = route(async ({ userId, req }) => {
  const { confirm } = await body(req, z.object({ confirm: z.string() }));
  if (confirm !== "DELETE") throw new AppError("Type DELETE to confirm.");
  await prisma.user.delete({ where: { id: userId } });
});
