import { PrismaClient } from "@prisma/client";

const g = globalThis as unknown as { prisma?: PrismaClient };
export const prisma = g.prisma ?? new PrismaClient({ log: process.env.PRISMA_LOG ? ["query", "error"] : ["error"] });
if (process.env.NODE_ENV !== "production") g.prisma = prisma;
