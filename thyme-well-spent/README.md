# Thyme Well Spent

A meal-planning and nutrition app: personalised onboarding → AI meal plan → swap → grocery list (pantry-aware) → cook → log → track. Next.js 15 (App Router) · TypeScript · Tailwind · Prisma/PostgreSQL · Auth.js · Framer Motion. Mobile-first, responsive, PWA-installable.

## Quick start
```bash
npm install
cp .env.example .env          # set DATABASE_URL (Postgres) and AUTH_SECRET
npm run setup                 # prisma generate + db push + seed (116 recipes, demo account)
npm run dev                   # http://localhost:3000
```
Demo account: **demo@thyme.app / demo1234** (Pro, 7-day plan, 20 favorites, pantry, grocery list, 14 days of history).

| Task | Command |
|---|---|
| Migrations (dev) | `npm run db:migrate` · deploy: `npm run db:deploy` |
| Seed / reseed | `npm run db:seed` |
| Tests | `npm test` (needs the seeded DB) |
| Typecheck | `npm run lint` |
| Browser QA walkthrough | `npm run build && npm start`, then `node scripts/qa.mjs http://localhost:3000` |

## Environment
`DATABASE_URL`, `AUTH_SECRET`, `AUTH_URL`; optional `AI_PROVIDER` (`mock` default | `openai` | `anthropic`) with `OPENAI_API_KEY`/`OPENAI_MODEL` or `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL`; `AUTH_GOOGLE_ID/SECRET`, `AUTH_APPLE_ID/SECRET` (providers appear automatically); `RECIPE_IMPORT=mock`; `STRIPE_SECRET_KEY` (billing hook only); `NEXT_PUBLIC_DEMO=off` hides the demo-login helper.

## Architecture
- `src/lib` – pure, tested logic: unit conversion, serving scaling, nutrition, grocery consolidation / pantry subtraction, diet & allergen rules, swap ranking.
- `src/server/services` – MealPlanningService (`meal-plan`), RecipeRecommendationService (`recommendations`, `recipes`), GroceryService, NutritionService, AIChatService, plus pantry, leftovers, scanner, importer, subscription. Every function takes `userId` and checks ownership server-side.
- `src/server/ai` – provider interface; the mock provider emits the same tool calls a real LLM would, so plan edits go through one code path.
- `src/app/api/*` – thin, zod-validated route handlers (errors never leak internals). Pages are server components; interactions are client components calling the API.
- Ingredients are relational; recipe nutrition is computed from per-100 g ingredient data.

## Known limitations
- Food "photos" are generated art (gradient + emoji); `Recipe.image` accepts any URL for real photography.
- Photo scanner is a deterministic mock unless `AI_PROVIDER=openai`. Estimates are labelled as approximate.
- Dates use the server's timezone (greeting uses the browser clock). Per-user timezone is a next step.
- Billing is not connected: Upgrade returns a clear "not set up" message; plans only change from a verified webhook you add.
- Notification preferences are stored, but delivery (push/email) isn't implemented.
- Apple sign-in is wired but untested without Apple credentials. Paleo is approximated (no grain recipes). Terms/Privacy are templates.
- Prices are rough static INR estimates with fixed FX rates.

## Next
Per-user timezone, push notifications, barcode scan, real photo library, store delivery integrations, Stripe checkout + webhook, recipe ratings UI, offline PWA caching, native wrappers (Capacitor).
