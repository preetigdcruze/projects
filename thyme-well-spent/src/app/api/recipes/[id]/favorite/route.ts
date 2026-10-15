import { route } from "@/lib/api";
import { toggleFavorite } from "@/server/services/recipes";

export const POST = route<{ id: string }>(async ({ userId, params }) => ({ favorite: await toggleFavorite(userId, params.id) }));
