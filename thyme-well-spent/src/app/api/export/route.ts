import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { currentUserId, errorResponse } from "@/lib/api";
import { unauthorized } from "@/lib/errors";

/** GDPR-style data export: everything we hold about the signed-in user, as JSON. */
export async function GET() {
  try {
    const userId = await currentUserId();
    if (!userId) throw unauthorized();
    const [user, plans, logs, foods, lists, pantry, favs, recipes, templates, convs] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true, createdAt: true, profile: true, preference: true, goal: true, restrictions: true, allergies: true, notifications: true, subscription: true } }),
      prisma.mealPlan.findMany({ where: { userId }, include: { days: { include: { items: true } } } }),
      prisma.mealLog.findMany({ where: { userId } }), prisma.foodLog.findMany({ where: { userId } }),
      prisma.groceryList.findMany({ where: { userId }, include: { items: true } }), prisma.pantryItem.findMany({ where: { userId } }),
      prisma.favoriteRecipe.findMany({ where: { userId } }), prisma.recipe.findMany({ where: { userId }, include: { ingredients: true, instructions: true } }),
      prisma.savedMealPlan.findMany({ where: { userId } }), prisma.aIConversation.findMany({ where: { userId }, include: { messages: true } }),
    ]);
    return new NextResponse(JSON.stringify({ exportedAt: new Date().toISOString(), user, mealPlans: plans, mealLogs: logs, foodLogs: foods, groceryLists: lists, pantry, favorites: favs, myRecipes: recipes, templates, aiConversations: convs }, null, 2), {
      headers: { "content-type": "application/json", "content-disposition": 'attachment; filename="thyme-data-export.json"' },
    });
  } catch (e) { return errorResponse(e); }
}
