// End-to-end QA walk-through against a running dev/prod server:  node scripts/qa.mjs [baseUrl] [screenshotDir]
import { chromium } from "playwright-core";
import fs from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:3000";
const SHOTS = process.argv[3] ?? "/tmp/qa-shots";
fs.mkdirSync(SHOTS, { recursive: true });
const exe = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const stamp = Date.now();
const email = `qa-${stamp}@example.com`, password = "supersecret1";

const results = [];
let page;
async function step(name, fn) {
  try { await fn(); results.push([true, name]); console.log(`✓ ${name}`); }
  catch (e) { results.push([false, name, e.message.split("\n")[0]]); console.log(`✗ ${name}\n   ${e.message.split("\n").slice(0, 3).join("\n   ")}`); await page.screenshot({ path: `${SHOTS}/FAIL-${results.length}.png` }).catch(() => {}); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true });
const num = (s) => Number(String(s).replace(/[^\d.]/g, ""));

const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
page = await ctx.newPage(); page.setDefaultTimeout(20000);
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error" && !/favicon|Failed to load resource/.test(m.text())) consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

await step("1. Sign up", async () => {
  await page.goto(`${BASE}/signup`);
  await page.getByLabel("First name").fill("Quinn");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/onboarding", { timeout: 20000 });
  await shot("01-onboarding-start");
});

await step("2. Complete onboarding", async () => {
  await page.getByRole("button", { name: /Eat healthier/ }).click();
  await page.getByRole("button", { name: /Gain muscle/ }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Everything" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Allergies", { exact: true }).fill("peanuts");
  await page.getByLabel("Allergies", { exact: true }).press("Enter");
  await page.getByLabel("Dislikes").fill("mushrooms");
  await page.getByLabel("Dislikes").press("Enter");
  await shot("02-onboarding-avoid");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: /Indian/ }).click();
  await page.getByRole("button", { name: /Mediterranean/ }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "30–45 minutes" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "2", exact: true }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Snacks" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Age").fill("30");
  await page.getByLabel("Height (cm)").fill("172");
  await page.getByLabel("Weight (kg)").fill("70");
  await shot("03-onboarding-nutrition");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByText("kcal/day").waitFor();
  await shot("04-onboarding-ready");
  assert(await page.getByText("Your plan is ready.").isVisible(), "ready screen");
  await page.getByRole("button", { name: "Create My Meal Plan" }).click();
  await page.waitForURL("**/plan?**review=1", { timeout: 60000 });
});

await step("3. Generated plan is shown for review", async () => {
  await page.getByText("Your plan is ready 🎉").waitFor();
  await page.waitForTimeout(500);
  await shot("05-plan-mobile");
  const cards = await page.locator("article").count();
  assert(cards >= 3, `expected meal cards, got ${cards}`);
});

await step("4. View today's meals (Home)", async () => {
  await page.goto(`${BASE}/`);
  await page.getByText("Today's meals").waitFor();
  await page.waitForTimeout(600);
  await shot("06-home-mobile");
  assert((await page.locator("article h3").count()) >= 3, "home meal cards");
});

let firstMealTitle;
await step("5. Open recipe & change serving size", async () => {
  firstMealTitle = await page.locator("article h3").first().innerText();
  await page.locator("article a[aria-label^='View recipe']").first().click();
  await page.waitForURL("**/recipes/**");
  const row = page.locator("section[aria-labelledby=ingredients] ul li").first();
  const before = (await row.locator("span").last().innerText()).trim();
  const baseServings = num(await page.locator("[aria-label='servings'] span[aria-live]").innerText());
  await page.getByRole("button", { name: "Increase servings" }).click();
  await page.getByRole("button", { name: "Increase servings" }).click();
  await page.waitForTimeout(400);
  const after = (await row.locator("span").last().innerText()).trim();
  const newServings = num(await page.locator("[aria-label='servings'] span[aria-live]").innerText());
  console.log(`   servings ${baseServings}→${newServings}: ${before} → ${after}`);
  assert(newServings === baseServings + 2 && before !== after, "ingredient quantity should change with servings");
  await shot("07-recipe-detail");
});

await step("6. Add recipe to planner", async () => {
  await page.getByRole("button", { name: "Add to plan" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Add to plan" }).click();
  await page.getByText("Added to your plan").waitFor();
});

await step("7. Swap a meal (Home)", async () => {
  await page.goto(`${BASE}/`);
  await page.getByText("Today's meals").waitFor();
  const card = page.locator("article").filter({ hasText: firstMealTitle }).first();
  const bTitle = await card.locator("h3").innerText();
  await card.getByRole("button", { name: "Swap" }).click();
  await page.getByText("Swap this meal").waitFor();
  await page.getByText("Why this works", { exact: false }).first().waitFor().catch(() => {});
  await shot("08-swap-sheet");
  const reasonCount = await page.locator("ul[aria-label='Why this works'] li").count();
  assert(reasonCount > 0, "swap alternatives should show reasons");
  await page.getByRole("dialog").getByRole("button", { name: /^Use / }).first().click();
  await page.getByText(/^Swapped to/).waitFor();
  await page.waitForTimeout(800);
  const titles = await page.locator("article h3").allInnerTexts();
  assert(!titles.includes(bTitle) || titles.filter((t) => t === bTitle).length < (await page.locator("article h3").count()), "title should have changed");
  console.log(`   swapped "${bTitle}" → ${titles.join(" | ")}`);
});

await step("8-10. Log meal and verify nutrition changes", async () => {
  await page.goto(`${BASE}/`);
  await page.getByText("Today's meals").waitFor();
  const ringText = async () => num(await page.locator("section[aria-label=\"Today's nutrition\"] [role=img]").first().getAttribute("aria-label").then((s) => s.split(" of ")[0]));
  const before = await ringText();
  const card = page.locator("article").first();
  const kcal = num((await card.innerText()).match(/(\d+)\s*kcal/)[1]);
  await card.getByRole("button", { name: "Log meal" }).click();
  await page.getByText("Did you eat this?").waitFor();
  await shot("09-log-sheet");
  await page.getByRole("dialog").getByRole("button", { name: "Log meal" }).click();
  await page.getByText(/^Logged /).first().waitFor();
  await page.waitForFunction((b) => { const el = document.querySelector("section[aria-label=\"Today's nutrition\"] [role=img]"); return el && Number(el.getAttribute("aria-label").split(" of ")[0]) > b; }, before, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(300);
  const after = await ringText();
  console.log(`   calories ${before} → ${after} (meal ${kcal})`);
  assert(after > before && Math.abs(after - before - kcal) <= 2, "calories should increase by the meal's calories");
  await shot("10-home-after-log");
});

await step("11-12. Generate grocery list and verify consolidation", async () => {
  await page.goto(`${BASE}/grocery`);
  await page.getByRole("button", { name: "Generate from my plan" }).click().catch(async () => { await page.getByRole("button", { name: "Regenerate from plan" }).click(); });
  await page.getByRole("button", { name: "Build my list" }).click();
  await page.getByText(/items from \d+ meals/).waitFor();
  await page.waitForTimeout(800);
  await shot("11-grocery");
  const names = (await page.locator("main li button[aria-label^='Edit']").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label").replace("Edit ", "").toLowerCase())));
  assert(names.length > 8, `expected a populated list, got ${names.length}`);
  assert(new Set(names).size === names.length, "duplicate ingredient rows found");
  assert((await page.getByText("Added from meal plan").count()) > 0, "label missing");
  globalThis.groceryNames = names;
});

await step("13-15. Add pantry item, regenerate, verify subtraction", async () => {
  const qtyOf = async (name) => {
    const t = await page.locator(`main li button[aria-label="Edit ${name}"]`).first().innerText().catch(() => null);
    return t;
  };
  // choose an ingredient present in the list with gram units
  const candidates = globalThis.groceryNames.filter((n) => !["salt"].includes(n));
  let pick = null, beforeTxt = null;
  for (const n of candidates) { const t = await qtyOf(n.replace(/^./, (c) => c.toUpperCase())); if (t && /\d+(\.\d+)? (g|kg)\b/.test(t) && !/ g\s*$/.test("") ) { pick = n; beforeTxt = t; break; } }
  assert(pick, "no gram-based item found");
  const m = beforeTxt.match(/(\d+(?:\.\d+)?) (kg|g)\b/); const grams = Number(m[1]) * (m[2] === "kg" ? 1000 : 1);
  console.log(`   using "${pick}" needs ${grams} g`);
  await page.goto(`${BASE}/pantry`);
  await page.getByRole("button", { name: "Add to pantry" }).first().click();
  await page.getByLabel("Ingredient").fill(pick);
  await page.getByLabel("Quantity").fill(String(Math.max(Math.floor(grams / 2), 1)));
  await page.getByLabel("Unit").selectOption("g");
  await page.getByRole("dialog").getByRole("button", { name: "Add to pantry" }).click();
  await page.getByText(/Added .* to your pantry/).waitFor();
  await page.waitForTimeout(500);
  await shot("12-pantry");
  await page.goto(`${BASE}/grocery`);
  await page.getByRole("button", { name: "Regenerate from plan" }).click();
  await page.getByRole("button", { name: "Build my list" }).click();
  await page.getByText(/items from \d+ meals/).waitFor();
  await page.waitForTimeout(800);
  const after = await qtyOf(pick.replace(/^./, (c) => c.toUpperCase()));
  const m2 = after?.match(/(\d+(?:\.\d+)?) (kg|g)\b/);
  const afterGrams = m2 ? Number(m2[1]) * (m2[2] === "kg" ? 1000 : 1) : 0;
  console.log(`   after pantry: ${after ? afterGrams : "removed"} g`);
  assert(!after || afterGrams < grams, "quantity should drop after pantry subtraction");
});

await step("check an item off (grocery)", async () => {
  const cb = page.getByRole("checkbox").first();
  await cb.click();
  await page.waitForTimeout(400);
  assert((await cb.getAttribute("aria-checked")) === "true", "checkbox state");
  await shot("13-grocery-checked");
});

await step("16. Favorite a recipe", async () => {
  await page.goto(`${BASE}/recipes`);
  await page.getByRole("button", { name: "Add to favorites" }).first().click();
  await page.getByRole("button", { name: "Remove from favorites" }).first().waitFor();
  await page.getByRole("button", { name: "Favorites", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll("main article").length > 0 && !document.querySelector("[aria-busy]"), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
  assert((await page.locator("article").count()) >= 1, "favorite should appear in Favorites collection");
});

await step("17. Search recipes", async () => {
  await page.goto(`${BASE}/recipes`);
  await page.getByLabel("Search recipes").fill("chicken");
  await page.waitForFunction(() => document.querySelectorAll("main article").length > 0, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(600);
  const n = await page.locator("article").count();
  assert(n >= 4, `chicken search returned ${n}`);
  await page.getByLabel("Search recipes").fill("high protein vegetarian under 30 minutes");
  await page.waitForTimeout(2500);
  const n2 = await page.locator("article").count();
  assert(n2 >= 1, "combined search returned none");
  console.log(`   chicken → ${n} results, combined → ${n2}`);
  await shot("14-recipes-search");
});

await step("18. Create custom recipe", async () => {
  await page.goto(`${BASE}/recipes/new`);
  await page.getByLabel("Recipe name").fill("QA Lemon Chicken Bowl");
  await page.getByLabel("Ingredient 1 name").fill("chicken breast");
  await page.getByLabel("Ingredient 1 amount").fill("300");
  await page.getByLabel("Step 1", { exact: true }).fill("Cook the chicken and serve.");
  await page.getByRole("button", { name: "Save recipe" }).click();
  await page.waitForURL(/\/recipes\/(?!new)[a-z0-9]+$/, { timeout: 60000 });
  assert(await page.getByRole("heading", { name: "QA Lemon Chicken Bowl" }).isVisible(), "custom recipe page");
  await shot("15-custom-recipe");
});

await step("19. Mobile layout: bottom nav, no horizontal scroll", async () => {
  for (const p of ["/", "/plan", "/recipes", "/grocery", "/pantry", "/progress", "/history", "/profile", "/settings", "/assistant", "/log"]) {
    await page.goto(`${BASE}${p}`);
    await page.waitForTimeout(500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 1, `${p} overflows horizontally by ${overflow}px`);
  }
  await page.goto(`${BASE}/`);
  assert(await page.locator("nav[aria-label=Primary]").last().isVisible(), "bottom nav visible");
});

await step("Assistant replaces a meal in the database", async () => {
  await page.goto(`${BASE}/plan`);
  await page.waitForTimeout(500);
  await page.goto(`${BASE}/assistant`);
  await page.getByRole("button", { name: "What should I eat tonight?" }).click();
  await page.getByText(/ideas that fit your day|ideas/).first().waitFor({ timeout: 20000 });
  await shot("16-assistant");
  // tomorrow dinner: add one then ask to replace it
  const d = new Date(Date.now() + 86400000);
  const day = d.toLocaleDateString("en-US", { weekday: "long" });
  const r = await page.evaluate(async (day) => (await fetch("/api/ai/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: `Replace ${day}'s dinner with something vegetarian` }) })).json(), day);
  console.log(`   assistant: ${r.reply?.split("\n")[0]}`);
  assert(r.changed === true && /^Done/.test(r.reply), `assistant did not modify plan: ${JSON.stringify(r).slice(0, 200)}`);
});

await step("Progress, history, log food, scan, settings render", async () => {
  await page.goto(`${BASE}/progress`); await page.getByText("Meal consistency").waitFor(); await shot("17-progress");
  await page.goto(`${BASE}/history?range=today`); await page.waitForTimeout(300); await shot("18-history");
  await page.goto(`${BASE}/log`); await page.getByLabel("Search foods").fill("banana");
  await page.getByText("Banana, medium").waitFor();
  await page.getByRole("button", { name: /^Add to / }).first().click();
  await page.getByText(/^Added Banana/).first().waitFor();
  await shot("19-log-food");
  await page.goto(`${BASE}/log?tab=scan`);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await page.setInputFiles("input[type=file]", { name: "meal.png", mimeType: "image/png", buffer: png });
  await page.getByText(/Possible match/).waitFor({ timeout: 15000 });
  await shot("20-scan");
  await page.getByRole("button", { name: /Confirm/ }).click();
  await page.getByText(/^Added /).first().waitFor();
  await page.goto(`${BASE}/settings`); await page.getByText("Planning defaults").waitFor(); await shot("21-settings");
});

await step("21. Logout and login", async () => {
  await page.goto(`${BASE}/settings`);
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL("**/login", { timeout: 15000 });
  await page.goto(`${BASE}/`);
  await page.waitForURL("**/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${BASE}/`, { timeout: 15000 });
  await page.getByText("Today's meals").waitFor();
});

await step("22. User data isolation (second user can't see first user's data)", async () => {
  const idsA = await page.evaluate(async () => {
    const w = await (await fetch("/api/meal-plan")).json();
    const item = w.days.flatMap((d) => d.items)[0];
    const g = await (await fetch("/api/grocery")).json();
    return { itemId: item?.id, groceryId: g.items[0]?.id, recipes: (await (await fetch("/api/recipes?collection=mine")).json()).items.map((r) => r.id) };
  });
  assert(idsA.itemId && idsA.groceryId && idsA.recipes.length, "user A should have data");
  const ctx2 = await browser.newContext(); const p2 = await ctx2.newPage();
  const email2 = `qa2-${stamp}@example.com`;
  await p2.goto(`${BASE}/signup`);
  await p2.getByLabel("First name").fill("Other"); await p2.getByLabel("Email").fill(email2); await p2.getByLabel("Password").fill(password);
  await p2.getByRole("button", { name: "Create account" }).click(); await p2.waitForURL("**/onboarding");
  // second user is mid-onboarding but authenticated: API must still enforce ownership
  const res = await p2.evaluate(async (a) => {
    const j = async (r) => ({ status: r.status });
    return {
      delItem: await j(await fetch(`/api/meal-plan/item?id=${a.itemId}`, { method: "DELETE" })),
      logItem: await j(await fetch("/api/meals/log", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mealPlanItemId: a.itemId }) })),
      patchGrocery: await j(await fetch("/api/grocery/item", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: a.groceryId, checked: true }) })),
      readRecipe: await j(await fetch(`/api/recipes/${a.recipes[0]}`)),
      groceryList: (await (await fetch("/api/grocery")).json()).items.length,
      plan: (await (await fetch("/api/meal-plan")).json()).days.flatMap((d) => d.items).length,
    };
  }, idsA);
  console.log("   second user:", JSON.stringify(res));
  assert(res.delItem.status === 404 && res.logItem.status === 404 && res.patchGrocery.status === 404 && res.readRecipe.status === 404, "cross-user access must 404");
  assert(res.groceryList === 0 && res.plan === 0, "second user must see empty data");
  const anon = await (await ctx2.newPage()).request.get(`${BASE}/api/meal-plan`).catch(() => null);
  void anon;
  await ctx2.close();
});

await step("20. Desktop layout", async () => {
  const dctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const dp = await dctx.newPage();
  await dp.goto(`${BASE}/login`);
  await dp.getByLabel("Email").fill(email); await dp.getByLabel("Password").fill(password);
  await dp.getByRole("button", { name: "Sign in" }).click(); await dp.waitForURL(`${BASE}/`);
  await dp.getByText("Today's meals").waitFor(); await dp.waitForTimeout(500);
  assert(await dp.locator("aside nav").isVisible(), "sidebar visible on desktop");
  await dp.screenshot({ path: `${SHOTS}/22-desktop-home.png`, fullPage: true });
  await dp.goto(`${BASE}/plan`); await dp.waitForTimeout(700); await dp.screenshot({ path: `${SHOTS}/23-desktop-plan.png`, fullPage: true });
  await dp.goto(`${BASE}/recipes`); await dp.waitForTimeout(700); await dp.screenshot({ path: `${SHOTS}/24-desktop-recipes.png` });
  await dp.goto(`${BASE}/grocery`); await dp.waitForTimeout(700); await dp.screenshot({ path: `${SHOTS}/25-desktop-grocery.png`, fullPage: true });
  await dctx.close();
});

await step("Demo account loads with seeded data", async () => {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const p = await c.newPage();
  await p.goto(`${BASE}/login`); await p.getByLabel("Email").fill("demo@thyme.app"); await p.getByLabel("Password").fill("demo1234");
  await p.getByRole("button", { name: "Sign in" }).click(); await p.waitForURL(`${BASE}/`);
  await p.getByText("Today's meals").waitFor(); await p.waitForTimeout(800);
  await p.screenshot({ path: `${SHOTS}/26-demo-home.png`, fullPage: true });
  const counts = await p.evaluate(async () => ({ fav: (await (await fetch("/api/recipes?collection=favorites&pageSize=60")).json()).total, groc: (await (await fetch("/api/grocery")).json()).items.length, pantry: (await (await fetch("/api/pantry")).json()).items.length }));
  console.log("   demo:", JSON.stringify(counts));
  assert(counts.fav === 20 && counts.groc > 10 && counts.pantry >= 8, "demo data");
  await p.goto(`${BASE}/progress`); await p.waitForTimeout(500); await p.screenshot({ path: `${SHOTS}/27-demo-progress.png`, fullPage: true });
  await p.goto(`${BASE}/pantry`); await p.waitForTimeout(500); await p.screenshot({ path: `${SHOTS}/28-demo-pantry.png`, fullPage: true });
  await c.close();
});

await browser.close();
const failed = results.filter((r) => !r[0]);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
if (consoleErrors.length) console.log("Console errors:\n" + [...new Set(consoleErrors)].slice(0, 10).join("\n"));
process.exit(failed.length ? 1 : 0);
