import { route } from "@/lib/api";
import { usageSummary } from "@/server/services/subscription";

export const GET = route(async ({ userId }) => usageSummary(userId));
