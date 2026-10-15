import { route } from "@/lib/api";
import { getListWithItems } from "@/server/services/grocery";

export const GET = route(async ({ userId }) => getListWithItems(userId));
